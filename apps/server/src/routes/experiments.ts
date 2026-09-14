import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentProvider } from "@aiew/agents";
import { WorktreeService } from "@aiew/git";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { agentRuns, experiments, projects, tasks, type ExperimentRecord } from "../db/schema.js";
import { AgentRunManager } from "../services/agent-run-manager.js";
import { ExperimentWorkflow } from "../services/experiment-workflow.js";
import { UsageSafetyService } from "../services/usage-safety.js";
import { UsageBudgetService } from "../services/usage-settings.js";
import { WorktreeUsageManager } from "../services/worktree-usage-manager.js";
import { ensureWorktreeForTask, safetyError } from "./worktrees.js";

type StartExperimentBody = {
  hypothesis?: unknown;
  builderProvider?: unknown;
  reviewerProvider?: unknown;
  claudeModel?: unknown;
  codexModel?: unknown;
  claudeEffort?: unknown;
  timeoutMs?: unknown;
};

const NON_TERMINAL_STATUSES: readonly string[] = ["RUNNING", "REVIEWING", "CHECKPOINTED"];

function agentProvider(input: unknown): AgentProvider | null {
  return input === "CLAUDE" || input === "CODEX" ? input : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasActiveExperiment(db: WorkspaceDatabase, taskId: string, provider: AgentProvider) {
  return db.select().from(experiments).where(eq(experiments.taskId, taskId)).all()
    .some((experiment) => experiment.builderProvider === provider && NON_TERMINAL_STATUSES.includes(experiment.status));
}

export function registerExperimentRoutes(
  app: FastifyInstance,
  db: WorkspaceDatabase,
  adapters: Map<AgentProvider, AgentAdapter>,
  manager: AgentRunManager,
  usageSafety: UsageSafetyService = new UsageSafetyService(db),
  worktreeService: WorktreeService = new WorktreeService(),
  worktreeUsageManager: WorktreeUsageManager = new WorktreeUsageManager(db),
  usageBudgets: UsageBudgetService = new UsageBudgetService(db),
) {
  const workflow = new ExperimentWorkflow(db, manager, adapters, worktreeService, worktreeUsageManager, usageSafety, usageBudgets);

  const detailFor = (experiment: ExperimentRecord) => ({
    ...experiment,
    builderRun: experiment.builderRunId ? db.select().from(agentRuns).where(eq(agentRuns.id, experiment.builderRunId)).get() ?? null : null,
    reviewerRun: experiment.reviewerRunId ? db.select().from(agentRuns).where(eq(agentRuns.id, experiment.reviewerRunId)).get() ?? null : null,
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/experiments", async (request, reply) => {
    if (!db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, request.params.id)).get()) {
      return reply.code(404).send({ message: "Task not found." });
    }
    return db.select().from(experiments).where(eq(experiments.taskId, request.params.id)).orderBy(desc(experiments.createdAt)).all();
  });

  app.post<{ Params: { id: string }; Body: StartExperimentBody }>("/api/tasks/:id/experiments", async (request, reply) => {
    const task = db.select().from(tasks).where(eq(tasks.id, request.params.id)).get();
    if (!task) return reply.code(404).send({ message: "Task not found." });
    const project = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!project) return reply.code(404).send({ message: "Project not found." });

    const hypothesis = text(request.body?.hypothesis);
    if (!hypothesis || hypothesis.length > 5_000) {
      return reply.code(400).send({ message: "A hypothesis is required (5,000 characters or fewer)." });
    }
    const builderProvider = agentProvider(request.body?.builderProvider);
    const reviewerProvider = agentProvider(request.body?.reviewerProvider);
    if (!builderProvider || !reviewerProvider) {
      return reply.code(400).send({ message: "builderProvider and reviewerProvider must each be CLAUDE or CODEX." });
    }
    if (builderProvider === reviewerProvider) {
      return reply.code(400).send({ message: "The builder and reviewer must be different providers." });
    }
    if (hasActiveExperiment(db, task.id, builderProvider)) {
      return reply.code(409).send({ message: "An experiment is already running for this task and provider." });
    }

    const timeoutMs = typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : 900_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      return reply.code(400).send({ message: "Timeout must be between 1 second and 1 hour." });
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
    if (hasActiveExperiment(db, task.id, builderProvider)) {
      return reply.code(409).send({ message: "An experiment was already started for this task and provider while readiness was checked." });
    }
    const usageDecision = providersToCheck
      .map((checkedProvider) => usageSafety.evaluate(checkedProvider, { combined: true }))
      .find((decision) => !decision.allowed);
    if (usageDecision) {
      return reply.code(409).send({ message: usageDecision.reason, code: "USAGE_CHECKPOINT", decision: usageDecision });
    }
    const budgetDecision = usageBudgets.evaluate(task.id);
    if (!budgetDecision.allowed) {
      return reply.code(409).send({ message: budgetDecision.reason, code: "BUDGET_CHECKPOINT", decision: budgetDecision });
    }

    let worktree;
    try {
      worktree = await ensureWorktreeForTask(db, worktreeService, task, project, builderProvider);
    } catch (error) {
      return safetyError(reply, error);
    }

    const now = new Date().toISOString();
    const experiment: ExperimentRecord = {
      id: randomUUID(), taskId: task.id, projectId: project.id, hypothesis, builderProvider, reviewerProvider,
      worktreeId: worktree.id, builderRunId: null, reviewerRunId: null, status: "RUNNING",
      diffUnstaged: null, diffStaged: null, testExecuted: null, result: null, conclusion: null,
      verdict: null, evidenceItemId: null, errorMessage: null, createdAt: now, updatedAt: now,
    };
    db.insert(experiments).values(experiment).run();
    void workflow.start(experiment.id, {
      models: { CLAUDE: text(request.body?.claudeModel) ?? undefined, CODEX: text(request.body?.codexModel) ?? undefined },
      claudeEffort: text(request.body?.claudeEffort) ?? undefined,
      timeoutMs,
    });
    return reply.code(202).send({ message: "The experiment is starting.", experimentId: experiment.id });
  });

  app.get<{ Params: { id: string } }>("/api/experiments/:id", async (request, reply) => {
    const experiment = db.select().from(experiments).where(eq(experiments.id, request.params.id)).get();
    if (!experiment) return reply.code(404).send({ message: "Experiment not found." });
    return detailFor(experiment);
  });

  app.post<{ Params: { id: string } }>("/api/experiments/:id/cancel", async (request, reply) => {
    return await workflow.cancel(request.params.id)
      ? reply.code(202).send({ message: "Experiment cancellation requested." })
      : reply.code(409).send({ message: "Experiment is not running." });
  });

  app.post<{ Params: { id: string } }>("/api/experiments/:id/resume", async (request, reply) => {
    const experiment = db.select().from(experiments).where(eq(experiments.id, request.params.id)).get();
    if (!experiment) return reply.code(404).send({ message: "Experiment not found." });
    if (experiment.status !== "CHECKPOINTED") return reply.code(409).send({ message: "Only a checkpointed experiment can be resumed." });
    const usageDecision = ([experiment.builderProvider, experiment.reviewerProvider] as const)
      .map((provider) => usageSafety.evaluate(provider, { combined: true }))
      .find((decision) => !decision.allowed);
    if (usageDecision) return reply.code(409).send({ message: usageDecision.reason, code: "USAGE_CHECKPOINT", decision: usageDecision });
    const budgetDecision = usageBudgets.evaluate(experiment.taskId);
    if (!budgetDecision.allowed) return reply.code(409).send({ message: budgetDecision.reason, code: "BUDGET_CHECKPOINT", decision: budgetDecision });
    void workflow.resume(experiment.id);
    return reply.code(202).send({ message: "Resuming the checkpointed experiment.", experimentId: experiment.id });
  });
}
