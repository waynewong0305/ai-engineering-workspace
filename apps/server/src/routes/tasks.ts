import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentProvider } from "@aiew/agents";
import type { FastifyInstance } from "fastify";
import { asc, desc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns,
  evidenceItems,
  projects,
  taskArtifacts,
  taskComparisons,
  tasks,
  type EvidenceType,
  type RiskLevel,
  type TaskType,
} from "../db/schema.js";
import { AgentRunManager } from "../services/agent-run-manager.js";
import { BrainstormWorkflow } from "../services/brainstorm-workflow.js";
import { UsageSafetyService } from "../services/usage-safety.js";

type CreateTaskBody = {
  projectId?: unknown;
  title?: unknown;
  problemStatement?: unknown;
  type?: unknown;
  riskLevel?: unknown;
  webAccessPermitted?: unknown;
};

type StartTaskBody = {
  claudeModel?: unknown;
  codexModel?: unknown;
  claudeEffort?: unknown;
  timeoutMs?: unknown;
};

const TASK_TYPES = new Set<TaskType>(["BRAINSTORM", "ARCHITECTURE"]);
const RISK_LEVELS = new Set<RiskLevel>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const EVIDENCE_TYPES = new Set<EvidenceType>(["FACT", "ASSUMPTION", "QUESTION", "DECISION", "EXPERIMENT_RESULT"]);

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function registerTaskRoutes(
  app: FastifyInstance,
  db: WorkspaceDatabase,
  adapters: Map<AgentProvider, AgentAdapter>,
  manager: AgentRunManager,
  usageSafety = new UsageSafetyService(db),
) {
  const workflow = new BrainstormWorkflow(db, manager, adapters, usageSafety);

  app.get<{ Querystring: { projectId?: string } }>("/api/tasks", async (request) => {
    const query = db.select().from(tasks);
    return request.query.projectId
      ? query.where(eq(tasks.projectId, request.query.projectId)).orderBy(desc(tasks.createdAt)).all()
      : query.orderBy(desc(tasks.createdAt)).all();
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    const task = db.select().from(tasks).where(eq(tasks.id, request.params.id)).get();
    if (!task) return reply.code(404).send({ message: "Task not found." });
    return {
      ...task,
      runs: db.select().from(agentRuns).where(eq(agentRuns.taskId, task.id)).orderBy(asc(agentRuns.createdAt)).all(),
      artifacts: db.select().from(taskArtifacts).where(eq(taskArtifacts.taskId, task.id)).orderBy(asc(taskArtifacts.createdAt)).all(),
      evidence: db.select().from(evidenceItems).where(eq(evidenceItems.taskId, task.id)).orderBy(asc(evidenceItems.createdAt)).all(),
      comparison: db.select().from(taskComparisons).where(eq(taskComparisons.taskId, task.id)).get()?.content ?? null,
    };
  });

  app.post<{ Body: CreateTaskBody }>("/api/tasks", async (request, reply) => {
    const projectId = text(request.body?.projectId);
    const title = text(request.body?.title);
    const problemStatement = text(request.body?.problemStatement);
    const type = text(request.body?.type) as TaskType | null;
    const riskLevel = text(request.body?.riskLevel) as RiskLevel | null;
    if (!projectId || !title || !problemStatement || !type || !riskLevel) {
      return reply.code(400).send({ message: "Project, title, problem statement, task type, and risk level are required." });
    }
    if (!TASK_TYPES.has(type)) return reply.code(400).send({ message: "Task type must be BRAINSTORM or ARCHITECTURE." });
    if (!RISK_LEVELS.has(riskLevel)) return reply.code(400).send({ message: "Unknown risk level." });
    if (typeof request.body.webAccessPermitted !== "boolean") {
      return reply.code(400).send({ message: "An explicit web-access decision is required." });
    }
    if (title.length > 160 || problemStatement.length > 20_000) {
      return reply.code(400).send({ message: "Title must be at most 160 characters and the problem statement at most 20,000." });
    }
    if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).get()) {
      return reply.code(404).send({ message: "Project not found." });
    }
    const now = new Date().toISOString();
    const task = {
      id: randomUUID(), projectId, title, problemStatement, type, riskLevel,
      status: "DRAFT" as const,
      webAccessPolicy: request.body.webAccessPermitted ? "ENABLED_FOR_TASK" as const : "DISABLED" as const,
      webAccessPermitted: request.body.webAccessPermitted,
      webAccessDecidedAt: now, webAccessDecidedBy: "USER" as const,
      errorMessage: null, createdAt: now, updatedAt: now,
    };
    db.insert(tasks).values(task).run();
    return reply.code(201).send({ ...task, runs: [], artifacts: [], evidence: [], comparison: null });
  });

  app.post<{ Params: { id: string }; Body: StartTaskBody }>("/api/tasks/:id/start", async (request, reply) => {
    const task = db.select().from(tasks).where(eq(tasks.id, request.params.id)).get();
    if (!task) return reply.code(404).send({ message: "Task not found." });
    if (task.status !== "DRAFT") return reply.code(409).send({ message: "Only a draft task can be started." });
    const timeoutMs = typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : 600_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      return reply.code(400).send({ message: "Timeout must be between 1 second and 1 hour per run." });
    }
    const providers = ["CLAUDE", "CODEX"] as const;
    const readiness = await Promise.all(providers.map(async (provider) => {
      const adapter = adapters.get(provider);
      return [provider, adapter ? await adapter.healthCheck() : null] as const;
    }));
    const unavailable = readiness.filter(([, health]) => !health?.available || !health.authenticated);
    if (unavailable.length) {
      return reply.code(503).send({
        message: `Both providers must be ready before any usage is spent. Not ready: ${unavailable.map(([provider]) => provider).join(", ")}.`,
      });
    }
    if (db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, task.id)).get()?.status !== "DRAFT") {
      return reply.code(409).send({ message: "The task was already started while provider readiness was checked." });
    }
    const usageDecision = providers
      .map((provider) => usageSafety.evaluate(provider, { combined: true }))
      .find((decision) => !decision.allowed);
    if (usageDecision) {
      return reply.code(409).send({ message: usageDecision.reason, code: "USAGE_CHECKPOINT", decision: usageDecision });
    }
    void workflow.start(task.id, {
      models: { CLAUDE: text(request.body?.claudeModel) ?? undefined, CODEX: text(request.body?.codexModel) ?? undefined },
      claudeEffort: text(request.body?.claudeEffort) ?? undefined,
      timeoutMs,
    });
    return reply.code(202).send({ message: "Independent analyses are starting.", taskId: task.id });
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/resume", async (request, reply) => {
    const task = db.select().from(tasks).where(eq(tasks.id, request.params.id)).get();
    if (!task) return reply.code(404).send({ message: "Task not found." });
    if (task.status !== "CHECKPOINTED") return reply.code(409).send({ message: "Only a checkpointed task can be resumed." });
    const usageDecision = (["CLAUDE", "CODEX"] as const)
      .map((provider) => usageSafety.evaluate(provider, { combined: true }))
      .find((decision) => !decision.allowed);
    if (usageDecision) {
      return reply.code(409).send({ message: usageDecision.reason, code: "USAGE_CHECKPOINT", decision: usageDecision });
    }
    void workflow.resume(task.id);
    return reply.code(202).send({ message: "Resuming the checkpointed workflow.", taskId: task.id });
  });

  app.post<{ Params: { id: string } }>("/api/tasks/:id/cancel", async (request, reply) => {
    return await workflow.cancel(request.params.id)
      ? reply.code(202).send({ message: "Task cancellation requested." })
      : reply.code(409).send({ message: "Task is not running." });
  });

  app.post<{ Params: { id: string }; Body: { type?: unknown; content?: unknown } }>("/api/tasks/:id/evidence", async (request, reply) => {
    const task = db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, request.params.id)).get();
    if (!task) return reply.code(404).send({ message: "Task not found." });
    const type = text(request.body?.type) as EvidenceType | null;
    const content = text(request.body?.content);
    if (!type || !EVIDENCE_TYPES.has(type) || !content) return reply.code(400).send({ message: "A valid record type and content are required." });
    if (content.length > 5_000) return reply.code(400).send({ message: "Evidence content must be 5,000 characters or fewer." });
    const now = new Date().toISOString();
    const item = { id: randomUUID(), taskId: task.id, type, content, sourceProvider: null, sourceArtifactId: null, createdAt: now, updatedAt: now };
    db.insert(evidenceItems).values(item).run();
    return reply.code(201).send(item);
  });

  app.patch<{ Params: { taskId: string; itemId: string }; Body: { type?: unknown; content?: unknown } }>("/api/tasks/:taskId/evidence/:itemId", async (request, reply) => {
    const current = db.select().from(evidenceItems).where(eq(evidenceItems.id, request.params.itemId)).get();
    if (!current || current.taskId !== request.params.taskId) return reply.code(404).send({ message: "Evidence item not found." });
    const type = request.body?.type === undefined ? current.type : text(request.body.type) as EvidenceType | null;
    const content = request.body?.content === undefined ? current.content : text(request.body.content);
    if (!type || !EVIDENCE_TYPES.has(type) || !content) return reply.code(400).send({ message: "A valid record type and content are required." });
    db.update(evidenceItems).set({ type, content, updatedAt: new Date().toISOString() }).where(eq(evidenceItems.id, current.id)).run();
    return db.select().from(evidenceItems).where(eq(evidenceItems.id, current.id)).get();
  });
}
