import { randomUUID } from "node:crypto";
import { WorktreeSafetyError, WorktreeService, proposeWorktree, type WorktreeProvider } from "@aiew/git";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, asc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { projects, tasks, worktrees, type WorktreeRecord } from "../db/schema.js";
import { WorktreeUsageManager } from "../services/worktree-usage-manager.js";

type CreateWorktreeBody = {
  provider?: unknown;
  path?: unknown;
  branchName?: unknown;
  baseRef?: unknown;
};

function value(input: unknown, label: string, maxLength = 1_024) {
  if (typeof input !== "string" || !input.trim()) throw new WorktreeSafetyError(`${label} is required.`, "INVALID_INPUT");
  const result = input.trim();
  if (result.length > maxLength) throw new WorktreeSafetyError(`${label} is too long.`, "INVALID_INPUT");
  return result;
}

function provider(input: unknown): WorktreeProvider {
  if (input !== "CLAUDE" && input !== "CODEX") throw new WorktreeSafetyError("Provider must be CLAUDE or CODEX.", "INVALID_PROVIDER");
  return input;
}

function safetyError(reply: FastifyReply, error: unknown) {
  if (error instanceof WorktreeSafetyError) {
    const conflict = error.code.includes("COLLISION")
      || error.code === "WORKTREE_IN_USE"
      || error.code === "WORKTREE_DIRTY"
      || error.code === "WORKTREE_LOCKED"
      || error.code === "WORKTREE_PRUNABLE";
    return reply.code(conflict ? 409 : 400).send({ message: error.message, code: error.code });
  }
  if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
    return reply.code(409).send({ message: "That worktree path, branch, or provider slot is already managed." });
  }
  return reply.code(500).send({ message: "Worktree operation failed." });
}

export function registerWorktreeRoutes(app: FastifyInstance, db: WorkspaceDatabase) {
  const service = new WorktreeService();
  const usage = new WorktreeUsageManager(db);

  const contextFor = (record: WorktreeRecord) => {
    const project = db.select().from(projects).where(eq(projects.id, record.projectId)).get();
    if (!project) throw new WorktreeSafetyError("The owning project no longer exists.", "PROJECT_NOT_FOUND");
    return project;
  };

  const recordMoveOrRenameFailure = async (
    record: WorktreeRecord,
    field: "path" | "branch",
    persistError: unknown,
    rollback: () => Promise<void>,
    attemptedValue: string,
  ) => {
    const persistMessage = persistError instanceof Error ? persistError.message : "Database update failed.";
    try {
      await rollback();
      db.update(worktrees).set({
        lastError: `A ${field} update reached Git but could not be saved, so it was rolled back automatically. ${persistMessage}`,
        updatedAt: new Date().toISOString(),
      }).where(eq(worktrees.id, record.id)).run();
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "Rollback failed.";
      db.update(worktrees).set({
        status: "ERROR",
        lastError: `A ${field} update reached Git (now ${attemptedValue}) but the database record could not be saved, and automatic rollback also failed. Reconcile manually. Persistence error: ${persistMessage} Rollback error: ${rollbackMessage}`,
        updatedAt: new Date().toISOString(),
      }).where(eq(worktrees.id, record.id)).run();
    }
  };

  const detailFor = async (record: WorktreeRecord) => {
    const project = contextFor(record);
    try {
      const inspection = await service.inspect(project.repositoryPath, record.path);
      return { ...record, inUse: usage.isInUse(record.id), activeUsages: usage.listActive(record.id), inspection, inspectionError: null };
    } catch (error) {
      return {
        ...record,
        inUse: usage.isInUse(record.id),
        activeUsages: usage.listActive(record.id),
        inspection: null,
        inspectionError: error instanceof Error ? error.message : "Could not inspect worktree.",
      };
    }
  };

  app.get<{ Params: { id: string } }>("/api/projects/:id/worktrees", async (request, reply) => {
    const project = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
    if (!project) return reply.code(404).send({ message: "Project not found." });
    const managed = db.select().from(worktrees).where(eq(worktrees.projectId, project.id)).orderBy(asc(worktrees.createdAt)).all();
    try {
      const gitWorktrees = await service.list(project.repositoryPath);
      return { managed: await Promise.all(managed.map(detailFor)), gitWorktrees };
    } catch (error) {
      return safetyError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/worktrees/preview", async (request, reply) => {
    const task = db.select().from(tasks).where(eq(tasks.id, request.params.id)).get();
    if (!task) return reply.code(404).send({ message: "Task not found." });
    const project = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!project) return reply.code(404).send({ message: "Project not found." });
    const existing = db.select().from(worktrees).where(eq(worktrees.taskId, task.id)).all();
    const proposals = await Promise.all((["CLAUDE", "CODEX"] as const).map(async (agent) => {
      const proposal = proposeWorktree(project.worktreeRoot, task.id, task.title, agent, project.defaultBranch);
      if (existing.some((record) => record.provider === agent)) {
        return { ...proposal, available: false, message: "A managed worktree already exists for this provider." };
      }
      try {
        const validated = await service.validateProposal(project.repositoryPath, project.worktreeRoot, proposal);
        return { ...proposal, ...validated, available: true, message: null };
      } catch (error) {
        return { ...proposal, available: false, message: error instanceof Error ? error.message : "Proposal is unavailable." };
      }
    }));
    return { taskId: task.id, projectId: project.id, worktreeRoot: project.worktreeRoot, proposals };
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/worktrees", async (request, reply) => {
    if (!db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, request.params.id)).get()) {
      return reply.code(404).send({ message: "Task not found." });
    }
    const records = db.select().from(worktrees).where(eq(worktrees.taskId, request.params.id)).orderBy(asc(worktrees.createdAt)).all();
    return Promise.all(records.map(detailFor));
  });

  app.post<{ Params: { id: string }; Body: CreateWorktreeBody }>("/api/tasks/:id/worktrees", async (request, reply) => {
    let recordId: string | null = null;
    try {
      const task = db.select().from(tasks).where(eq(tasks.id, request.params.id)).get();
      if (!task) return reply.code(404).send({ message: "Task not found." });
      const project = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
      if (!project) return reply.code(404).send({ message: "Project not found." });
      const proposal = {
        provider: provider(request.body?.provider),
        path: value(request.body?.path, "Worktree path"),
        branchName: value(request.body?.branchName, "Branch name", 255),
        baseRef: value(request.body?.baseRef ?? project.defaultBranch, "Base ref", 255),
      };
      const validated = await service.validateProposal(project.repositoryPath, project.worktreeRoot, proposal);
      const now = new Date().toISOString();
      const record = {
        id: randomUUID(), taskId: task.id, projectId: project.id, provider: proposal.provider,
        path: validated.path, branchName: validated.branchName, baseRef: validated.baseRef,
        status: "CREATING" as const, lastError: null, createdAt: now, updatedAt: now,
      };
      recordId = record.id;
      db.insert(worktrees).values(record).run();
      const inspection = await service.create(project.repositoryPath, project.worktreeRoot, { ...proposal, path: validated.path });
      db.update(worktrees).set({ path: inspection.path, status: "ACTIVE", updatedAt: new Date().toISOString() }).where(eq(worktrees.id, record.id)).run();
      return reply.code(201).send(await detailFor({ ...record, path: inspection.path, status: "ACTIVE" }));
    } catch (error) {
      if (recordId) {
        db.update(worktrees).set({ status: "ERROR", lastError: error instanceof Error ? error.message : "Creation failed.", updatedAt: new Date().toISOString() })
          .where(eq(worktrees.id, recordId)).run();
      }
      return safetyError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/worktrees/:id", async (request, reply) => {
    const record = db.select().from(worktrees).where(eq(worktrees.id, request.params.id)).get();
    if (!record) return reply.code(404).send({ message: "Worktree not found." });
    return detailFor(record);
  });

  app.get<{ Params: { id: string } }>("/api/worktrees/:id/diff", async (request, reply) => {
    const record = db.select().from(worktrees).where(eq(worktrees.id, request.params.id)).get();
    if (!record) return reply.code(404).send({ message: "Worktree not found." });
    try {
      return await service.diff(record.path);
    } catch (error) {
      return safetyError(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: { path?: unknown } }>("/api/worktrees/:id/path", async (request, reply) => {
    const record = db.select().from(worktrees).where(eq(worktrees.id, request.params.id)).get();
    if (!record) return reply.code(404).send({ message: "Worktree not found." });
    const project = contextFor(record);
    try {
      const newPath = value(request.body?.path, "Worktree path");
      const inspection = await service.move(project.repositoryPath, project.worktreeRoot, record.path, newPath, usage.isInUse(record.id));
      try {
        db.update(worktrees).set({ path: inspection.path, updatedAt: new Date().toISOString() }).where(eq(worktrees.id, record.id)).run();
      } catch (error) {
        await recordMoveOrRenameFailure(record, "path", error, async () => {
          await service.move(project.repositoryPath, project.worktreeRoot, inspection.path, record.path, false);
        }, inspection.path);
        throw error;
      }
      return detailFor({ ...record, path: inspection.path, updatedAt: new Date().toISOString() });
    } catch (error) {
      return safetyError(reply, error);
    }
  });

  app.patch<{ Params: { id: string }; Body: { branchName?: unknown } }>("/api/worktrees/:id/branch", async (request, reply) => {
    const record = db.select().from(worktrees).where(eq(worktrees.id, request.params.id)).get();
    if (!record) return reply.code(404).send({ message: "Worktree not found." });
    const project = contextFor(record);
    try {
      const branchName = value(request.body?.branchName, "Branch name", 255);
      const inspection = await service.renameBranch(project.repositoryPath, record.path, branchName, usage.isInUse(record.id));
      try {
        db.update(worktrees).set({ branchName, updatedAt: new Date().toISOString() }).where(eq(worktrees.id, record.id)).run();
      } catch (error) {
        await recordMoveOrRenameFailure(record, "branch", error, async () => {
          await service.renameBranch(project.repositoryPath, record.path, record.branchName, false);
        }, inspection.branchName ?? branchName);
        throw error;
      }
      return detailFor({ ...record, branchName: inspection.branchName!, updatedAt: new Date().toISOString() });
    } catch (error) {
      return safetyError(reply, error);
    }
  });

  app.delete<{ Params: { id: string }; Body: { confirm?: unknown; deleteBranch?: unknown } }>("/api/worktrees/:id", async (request, reply) => {
    const record = db.select().from(worktrees).where(eq(worktrees.id, request.params.id)).get();
    if (!record) return reply.code(404).send({ message: "Worktree not found." });
    if (request.body?.confirm !== true) return reply.code(400).send({ message: "Explicit removal confirmation is required." });
    if (request.body?.deleteBranch !== undefined && typeof request.body.deleteBranch !== "boolean") {
      return reply.code(400).send({ message: "deleteBranch must be true or false." });
    }
    const project = contextFor(record);
    try {
      if (request.body.deleteBranch) await service.ensureBranchMerged(project.repositoryPath, record.branchName, record.baseRef);
      const result = await service.remove(project.repositoryPath, record.path, usage.isInUse(record.id));
      if (request.body.deleteBranch) await service.deleteMergedBranch(project.repositoryPath, record.branchName, record.baseRef);
      db.delete(worktrees).where(eq(worktrees.id, record.id)).run();
      return { ...result, deletedBranch: request.body.deleteBranch === true };
    } catch (error) {
      return safetyError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; usageId: string } }>("/api/worktrees/:id/usages/:usageId", async (request, reply) => {
    const record = db.select().from(worktrees).where(eq(worktrees.id, request.params.id)).get();
    if (!record) return reply.code(404).send({ message: "Worktree not found." });
    const released = usage.releaseById(record.id, request.params.usageId);
    if (!released) return reply.code(404).send({ message: "Active usage lease not found." });
    return detailFor(record);
  });
}
