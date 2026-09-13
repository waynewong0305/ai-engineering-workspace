import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentProvider } from "@aiew/agents";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { agentRuns, projects } from "../db/schema.js";
import { AgentRunManager } from "../services/agent-run-manager.js";

type CreateRunBody = {
  projectId?: unknown;
  provider?: unknown;
  prompt?: unknown;
  model?: unknown;
  effort?: unknown;
  timeoutMs?: unknown;
};

const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function registerAgentRunRoutes(
  app: FastifyInstance,
  db: WorkspaceDatabase,
  adapters: Map<AgentProvider, AgentAdapter>,
  manager = new AgentRunManager(db),
) {
  app.get("/api/agents/health", async () => {
    const entries = await Promise.all([...adapters].map(async ([provider, adapter]) => [provider, await adapter.healthCheck()] as const));
    return Object.fromEntries(entries);
  });

  app.get<{ Querystring: { projectId?: string } }>("/api/agent-runs", async (request) => {
    const query = db.select().from(agentRuns);
    return request.query.projectId
      ? query.where(eq(agentRuns.projectId, request.query.projectId)).orderBy(desc(agentRuns.createdAt)).all()
      : query.orderBy(desc(agentRuns.createdAt)).all();
  });

  app.get<{ Params: { id: string } }>("/api/agent-runs/:id", async (request, reply) => {
    const run = db.select().from(agentRuns).where(eq(agentRuns.id, request.params.id)).get();
    if (!run) return reply.code(404).send({ message: "Agent run not found." });
    return { ...run, events: manager.listEvents(run.id) };
  });

  app.post<{ Body: CreateRunBody }>("/api/agent-runs", async (request, reply) => {
    const projectId = stringValue(request.body?.projectId);
    const provider = stringValue(request.body?.provider) as AgentProvider | null;
    const prompt = stringValue(request.body?.prompt);
    if (!projectId || !provider || !prompt) return reply.code(400).send({ message: "Project, provider, and prompt are required." });
    if (provider !== "CLAUDE" && provider !== "CODEX") return reply.code(400).send({ message: "Unknown agent provider." });
    if (prompt.length > 20_000) return reply.code(400).send({ message: "Prompt must be 20,000 characters or fewer." });
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return reply.code(404).send({ message: "Project not found." });
    const adapter = adapters.get(provider);
    if (!adapter) return reply.code(503).send({ message: `${provider} adapter is unavailable.` });

    const timeoutMs = typeof request.body.timeoutMs === "number" ? request.body.timeoutMs : 300_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      return reply.code(400).send({ message: "Timeout must be between 1 second and 1 hour." });
    }
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(), projectId, taskId: null, provider,
      role: "REPOSITORY_EXPLANATION" as const, targetProvider: null, prompt,
      promptVersion: "repository-explanation-v1",
      requestedModel: stringValue(request.body.model) ?? "(provider default)",
      actualModel: null,
      effort: stringValue(request.body.effort),
      permissionProfile: "READ_ONLY" as const,
      webAccessPolicy: "DISABLED" as const,
      webAccessPermitted: false,
      status: "QUEUED" as const,
      output: "", rawOutput: "", errorOutput: "", errorMessage: null,
      exitCode: null, cliVersion: null, durationMs: null, startedAt: null, completedAt: null,
      createdAt: now, updatedAt: now,
    };
    db.insert(agentRuns).values(run).run();
    void manager.start(run, adapter, {
      runId: run.id,
      cwd: project.repositoryPath,
      prompt,
      promptVersion: run.promptVersion,
      permissionProfile: "READ_ONLY",
      webAccess: { policy: "DISABLED", permitted: false, decidedAt: now, decidedBy: "SYSTEM" },
      outputFormat: "JSONL",
      timeoutMs,
      environment: {},
      model: { requested: run.requestedModel, effort: run.effort ?? undefined },
    });
    return reply.code(202).send(run);
  });

  app.post<{ Params: { id: string } }>("/api/agent-runs/:id/cancel", async (request, reply) => {
    const run = db.select().from(agentRuns).where(eq(agentRuns.id, request.params.id)).get();
    if (!run) return reply.code(404).send({ message: "Agent run not found." });
    if (TERMINAL.has(run.status)) return reply.code(409).send({ message: `Run is already ${run.status.toLowerCase()}.` });
    const adapter = adapters.get(run.provider);
    if (!adapter) return reply.code(503).send({ message: "Agent adapter is unavailable." });
    const cancelled = await manager.cancel(run.id, adapter);
    return cancelled ? reply.code(202).send({ message: "Cancellation requested." }) : reply.code(409).send({ message: "Run is no longer active." });
  });

  app.get<{ Params: { id: string } }>("/api/agent-runs/:id/events", async (request, reply) => {
    const run = db.select().from(agentRuns).where(eq(agentRuns.id, request.params.id)).get();
    if (!run) return reply.code(404).send({ message: "Agent run not found." });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let lastSequence = 0;
    const send = (event: ReturnType<typeof manager.listEvents>[number]) => {
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      reply.raw.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (["completed", "failed", "cancelled"].includes(event.type)) {
        unsubscribe();
        reply.raw.end();
      }
    };
    const unsubscribe = manager.subscribe(run.id, send);
    request.raw.on("close", unsubscribe);
    for (const event of manager.listEvents(run.id)) send(event);
    const refreshed = db.select().from(agentRuns).where(and(eq(agentRuns.id, run.id))).get();
    if (refreshed && TERMINAL.has(refreshed.status) && !reply.raw.writableEnded) {
      unsubscribe();
      reply.raw.end();
    }
  });
}
