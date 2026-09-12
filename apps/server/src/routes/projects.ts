import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { projects, type ValidationCommand } from "../db/schema.js";
import { inspectRepository, RepositoryInspectionError } from "../services/repository-inspector.js";

type CreateProjectBody = {
  name?: unknown;
  repositoryPath?: unknown;
  defaultBranch?: unknown;
  worktreeRoot?: unknown;
  projectContext?: unknown;
  validationCommands?: unknown;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseValidationCommands(value: unknown): ValidationCommand[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new RepositoryInspectionError("Validation commands must be a list of at most 20 items.");
  }

  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new RepositoryInspectionError(`Validation command ${index + 1} is invalid.`);
    }
    const candidate = item as Record<string, unknown>;
    const label = optionalString(candidate.label);
    const command = optionalString(candidate.command);
    if (!label || !command) {
      throw new RepositoryInspectionError(`Validation command ${index + 1} needs a label and command.`);
    }
    return { id: randomUUID(), label, command };
  });
}

export function registerProjectRoutes(app: FastifyInstance, db: WorkspaceDatabase) {
  app.get("/api/projects", async () => db.select().from(projects).orderBy(desc(projects.createdAt)));

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
    if (!project) return reply.code(404).send({ message: "Project not found." });
    return project;
  });

  app.post<{ Body: CreateProjectBody }>("/api/projects", async (request, reply) => {
    try {
      const repositoryPath = optionalString(request.body?.repositoryPath);
      if (!repositoryPath) throw new RepositoryInspectionError("Repository path is required.");

      const snapshot = await inspectRepository(repositoryPath);
      const name = optionalString(request.body.name) ?? snapshot.repositoryName;
      const requestedWorktreeRoot = optionalString(request.body.worktreeRoot);
      if (requestedWorktreeRoot && !isAbsolute(requestedWorktreeRoot)) {
        throw new RepositoryInspectionError("Worktree root must be an absolute path.");
      }

      const now = new Date().toISOString();
      const project = {
        id: randomUUID(),
        name,
        repositoryPath: snapshot.repositoryPath,
        defaultBranch: optionalString(request.body.defaultBranch) ?? snapshot.defaultBranch,
        currentBranch: snapshot.currentBranch,
        worktreeRoot: requestedWorktreeRoot ?? snapshot.worktreeRoot,
        projectContext: optionalString(request.body.projectContext) ?? null,
        validationCommands: parseValidationCommands(request.body.validationCommands),
        gitStatus: snapshot.gitStatus,
        createdAt: now,
        updatedAt: now,
      } as const;

      db.insert(projects).values(project).run();
      return reply.code(201).send(project);
    } catch (error) {
      if (error instanceof RepositoryInspectionError) {
        return reply.code(400).send({ message: error.message });
      }
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return reply.code(409).send({ message: "That repository is already registered." });
      }
      request.log.error(error);
      return reply.code(500).send({ message: "Project registration failed." });
    }
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/recheck", async (request, reply) => {
    const project = db.select().from(projects).where(eq(projects.id, request.params.id)).get();
    if (!project) return reply.code(404).send({ message: "Project not found." });

    try {
      const snapshot = await inspectRepository(project.repositoryPath);
      const updatedAt = new Date().toISOString();
      db.update(projects)
        .set({
          currentBranch: snapshot.currentBranch,
          gitStatus: snapshot.gitStatus,
          updatedAt,
        })
        .where(eq(projects.id, project.id))
        .run();
      return { ...project, currentBranch: snapshot.currentBranch, gitStatus: snapshot.gitStatus, updatedAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Repository check failed.";
      return reply.code(400).send({ message });
    }
  });
}

