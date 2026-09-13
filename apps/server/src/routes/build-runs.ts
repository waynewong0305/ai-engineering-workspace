import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentProvider } from "@aiew/agents";
import { WorktreeService } from "@aiew/git";
import type { FastifyInstance } from "fastify";
import { asc, desc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns,
  buildRuns,
  projects,
  reviewFindings,
  taskArtifacts,
  tasks,
  validationRuns,
  type BuildRunRecord,
} from "../db/schema.js";
import { AgentRunManager } from "../services/agent-run-manager.js";
import { BuildReviewWorkflow } from "../services/build-review-workflow.js";
import { UsageSafetyService } from "../services/usage-safety.js";
import { WorktreeUsageManager } from "../services/worktree-usage-manager.js";
import { ensureWorktreeForTask, safetyError } from "./worktrees.js";

type StartBuildBody = {
  builderProvider?: unknown;
  reviewerProvider?: unknown;
  validationCommandIds?: unknown;
  claudeModel?: unknown;
  codexModel?: unknown;
  claudeEffort?: unknown;
  timeoutMs?: unknown;
  validationTimeoutMs?: unknown;
};

const NON_TERMINAL_BUILD_STATUSES: readonly string[] = ["BUILDING", "VALIDATING", "REVIEWING", "CHECKPOINTED"];

function agentProvider(input: unknown): AgentProvider | null {
  return input === "CLAUDE" || input === "CODEX" ? input : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function hasActiveBuild(db: WorkspaceDatabase, taskId: string) {
  return db.select().from(buildRuns).where(eq(buildRuns.taskId, taskId)).all()
    .some((build) => NON_TERMINAL_BUILD_STATUSES.includes(build.status));
}

export function registerBuildRoutes(
  app: FastifyInstance,
  db: WorkspaceDatabase,
  adapters: Map<AgentProvider, AgentAdapter>,
  manager: AgentRunManager,
  usageSafety: UsageSafetyService = new UsageSafetyService(db),
  worktreeService: WorktreeService = new WorktreeService(),
  worktreeUsageManager: WorktreeUsageManager = new WorktreeUsageManager(db),
) {
  const workflow = new BuildReviewWorkflow(db, manager, adapters, worktreeService, worktreeUsageManager, usageSafety);

  const detailFor = (build: BuildRunRecord) => ({
    ...build,
    builderRun: build.builderRunId ? db.select().from(agentRuns).where(eq(agentRuns.id, build.builderRunId)).get() ?? null : null,
    reviewerRun: build.reviewerRunId ? db.select().from(agentRuns).where(eq(agentRuns.id, build.reviewerRunId)).get() ?? null : null,
    validationRuns: db.select().from(validationRuns).where(eq(validationRuns.buildRunId, build.id)).orderBy(asc(validationRuns.createdAt)).all(),
    findings: db.select().from(reviewFindings).where(eq(reviewFindings.buildRunId, build.id)).orderBy(asc(reviewFindings.ordinal)).all(),
    // Surfaces the reviewer's raw output and any parseError even when parsing failed, mirroring how
    // brainstorm task artifacts are exposed — nothing the reviewer said is ever hidden by a failure.
    reviewArtifact: build.reviewerRunId
      ? db.select().from(taskArtifacts).where(eq(taskArtifacts.runId, build.reviewerRunId)).get() ?? null
      : null,
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/builds", async (request, reply) => {
    if (!db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, request.params.id)).get()) {
      return reply.code(404).send({ message: "Task not found." });
    }
    return db.select().from(buildRuns).where(eq(buildRuns.taskId, request.params.id)).orderBy(desc(buildRuns.createdAt)).all();
  });

  app.post<{ Params: { id: string }; Body: StartBuildBody }>("/api/tasks/:id/builds", async (request, reply) => {
    const task = db.select().from(tasks).where(eq(tasks.id, request.params.id)).get();
    if (!task) return reply.code(404).send({ message: "Task not found." });
    // Avoid racing BrainstormWorkflow, which also mutates this task's row while it runs.
    if (task.status === "ANALYZING" || task.status === "CROSS_REVIEW") {
      return reply.code(409).send({ message: "This task's brainstorm workflow is still running." });
    }
    const project = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!project) return reply.code(404).send({ message: "Project not found." });

    const builderProvider = agentProvider(request.body?.builderProvider);
    const reviewerProvider = agentProvider(request.body?.reviewerProvider);
    if (!builderProvider || !reviewerProvider) {
      return reply.code(400).send({ message: "builderProvider and reviewerProvider must each be CLAUDE or CODEX." });
    }
    if (builderProvider === reviewerProvider) {
      return reply.code(400).send({ message: "The builder and reviewer must be different providers." });
    }
    if (hasActiveBuild(db, task.id)) return reply.code(409).send({ message: "A build is already in progress for this task." });

    const timeoutMs = typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : 900_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      return reply.code(400).send({ message: "Timeout must be between 1 second and 1 hour." });
    }
    const validationTimeoutMs = typeof request.body?.validationTimeoutMs === "number" ? request.body.validationTimeoutMs : 600_000;
    if (!Number.isFinite(validationTimeoutMs) || validationTimeoutMs < 1_000 || validationTimeoutMs > 3_600_000) {
      return reply.code(400).send({ message: "Validation timeout must be between 1 second and 1 hour." });
    }

    const providersToCheck = [builderProvider, reviewerProvider] as const;
    const readiness = await Promise.all(providersToCheck.map(async (checkedProvider) => {
      const adapter = adapters.get(checkedProvider);
      return [checkedProvider, adapter ? await adapter.healthCheck() : null] as const;
    }));
    const unavailable = readiness.filter(([, health]) => !health?.available || !health.authenticated);
    if (unavailable.length) {
      return reply.code(503).send({
        message: `Both the builder and reviewer must be ready before any usage is spent. Not ready: ${unavailable.map(([checkedProvider]) => checkedProvider).join(", ")}.`,
      });
    }
    if (hasActiveBuild(db, task.id)) {
      return reply.code(409).send({ message: "A build was already started for this task while provider readiness was checked." });
    }
    const usageDecision = providersToCheck
      .map((checkedProvider) => usageSafety.evaluate(checkedProvider, { combined: true }))
      .find((decision) => !decision.allowed);
    if (usageDecision) {
      return reply.code(409).send({ message: usageDecision.reason, code: "USAGE_CHECKPOINT", decision: usageDecision });
    }

    let worktree;
    try {
      worktree = await ensureWorktreeForTask(db, worktreeService, task, project, builderProvider);
    } catch (error) {
      return safetyError(reply, error);
    }

    const now = new Date().toISOString();
    const build: BuildRunRecord = {
      id: randomUUID(), taskId: task.id, projectId: project.id, builderProvider, reviewerProvider,
      worktreeId: worktree.id, builderRunId: null, reviewerRunId: null, status: "BUILDING",
      diffUnstaged: null, diffStaged: null, errorMessage: null, createdAt: now, updatedAt: now,
    };
    db.insert(buildRuns).values(build).run();
    void workflow.start(build.id, {
      models: { CLAUDE: text(request.body?.claudeModel) ?? undefined, CODEX: text(request.body?.codexModel) ?? undefined },
      claudeEffort: text(request.body?.claudeEffort) ?? undefined,
      timeoutMs,
      validationTimeoutMs,
      validationCommandIds: stringArray(request.body?.validationCommandIds),
    });
    return reply.code(202).send({ message: "The build is starting.", buildRunId: build.id });
  });

  app.get<{ Params: { id: string } }>("/api/builds/:id", async (request, reply) => {
    const build = db.select().from(buildRuns).where(eq(buildRuns.id, request.params.id)).get();
    if (!build) return reply.code(404).send({ message: "Build not found." });
    return detailFor(build);
  });

  app.get<{ Params: { id: string } }>("/api/builds/:id/diff", async (request, reply) => {
    const build = db.select().from(buildRuns).where(eq(buildRuns.id, request.params.id)).get();
    if (!build) return reply.code(404).send({ message: "Build not found." });
    return { unstaged: build.diffUnstaged, staged: build.diffStaged };
  });

  app.get<{ Params: { id: string } }>("/api/builds/:id/findings", async (request, reply) => {
    if (!db.select({ id: buildRuns.id }).from(buildRuns).where(eq(buildRuns.id, request.params.id)).get()) {
      return reply.code(404).send({ message: "Build not found." });
    }
    return db.select().from(reviewFindings).where(eq(reviewFindings.buildRunId, request.params.id)).orderBy(asc(reviewFindings.ordinal)).all();
  });

  app.post<{ Params: { id: string } }>("/api/builds/:id/cancel", async (request, reply) => {
    return await workflow.cancel(request.params.id)
      ? reply.code(202).send({ message: "Build cancellation requested." })
      : reply.code(409).send({ message: "Build is not running." });
  });

  app.post<{ Params: { id: string } }>("/api/builds/:id/resume", async (request, reply) => {
    const build = db.select().from(buildRuns).where(eq(buildRuns.id, request.params.id)).get();
    if (!build) return reply.code(404).send({ message: "Build not found." });
    if (build.status !== "CHECKPOINTED") return reply.code(409).send({ message: "Only a checkpointed build can be resumed." });
    const usageDecision = ([build.builderProvider, build.reviewerProvider] as const)
      .map((provider) => usageSafety.evaluate(provider, { combined: true }))
      .find((decision) => !decision.allowed);
    if (usageDecision) {
      return reply.code(409).send({ message: usageDecision.reason, code: "USAGE_CHECKPOINT", decision: usageDecision });
    }
    void workflow.resume(build.id);
    return reply.code(202).send({ message: "Resuming the checkpointed build.", buildRunId: build.id });
  });
}
