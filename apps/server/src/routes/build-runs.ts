import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentProvider } from "@aiew/agents";
import { WorktreeService } from "@aiew/git";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq } from "drizzle-orm";
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
import { buildPrePrReport } from "../services/pre-pr-report.js";
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
  maxReviewRounds?: unknown;
};

type RespondBody = {
  validationCommandIds?: unknown;
  claudeModel?: unknown;
  codexModel?: unknown;
  claudeEffort?: unknown;
  timeoutMs?: unknown;
  validationTimeoutMs?: unknown;
};

type MergeBody = {
  targetBranch?: unknown;
  commitMessage?: unknown;
  keepWorktreeAfterMerge?: unknown;
  deleteBranchAfterMerge?: unknown;
  validationCommandIds?: unknown;
  validationTimeoutMs?: unknown;
};

const NON_TERMINAL_BUILD_STATUSES: readonly string[] = ["BUILDING", "VALIDATING", "REVIEWING", "RESPONDING", "CHECKPOINTED"];
const DEFAULT_MAX_REVIEW_ROUNDS = 3;

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
    // Deliberately a per-build setting rather than a hardcoded constant (PROJECT_SPEC.md §23 names
    // 3 as the default, not a fixed ceiling) — a human can raise or lower it per build at start time.
    const maxReviewRounds = typeof request.body?.maxReviewRounds === "number" ? request.body.maxReviewRounds : DEFAULT_MAX_REVIEW_ROUNDS;
    if (!Number.isInteger(maxReviewRounds) || maxReviewRounds < 1 || maxReviewRounds > 10) {
      return reply.code(400).send({ message: "maxReviewRounds must be an integer between 1 and 10." });
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
      diffUnstaged: null, diffStaged: null, reviewRound: 1, maxReviewRounds,
      mergeStatus: "NOT_MERGED", mergeTargetBranch: null, mergeCommitSha: null, mergedAt: null,
      mergeError: null, mergeTargetCheckedOutAt: null, worktreeRemovedAfterMerge: null,
      branchDeletedAfterMerge: null, worktreeCleanupSkippedReason: null, errorMessage: null,
      createdAt: now, updatedAt: now,
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

  app.get<{ Params: { id: string } }>("/api/builds/:id/report", async (request, reply) => {
    const report = buildPrePrReport(db, request.params.id);
    if (!report) return reply.code(404).send({ message: "Build not found." });
    return report;
  });

  app.post<{ Params: { id: string }; Body: RespondBody }>("/api/builds/:id/respond", async (request, reply) => {
    const build = db.select().from(buildRuns).where(eq(buildRuns.id, request.params.id)).get();
    if (!build) return reply.code(404).send({ message: "Build not found." });
    if (build.status !== "COMPLETED") return reply.code(409).send({ message: "Only a completed build can start a review-response round." });
    const openFindingsCount = db.select({ id: reviewFindings.id }).from(reviewFindings)
      .where(and(eq(reviewFindings.buildRunId, build.id), eq(reviewFindings.status, "OPEN"))).all().length;
    if (!openFindingsCount) return reply.code(409).send({ message: "There are no open findings to respond to." });
    if (build.reviewRound >= build.maxReviewRounds) {
      return reply.code(409).send({
        message: `This build has reached its maximum of ${build.maxReviewRounds} review round(s). Resolve the remaining findings directly, or start a new build if a human wants to allow more rounds.`,
      });
    }

    const timeoutMs = typeof request.body?.timeoutMs === "number" ? request.body.timeoutMs : 900_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
      return reply.code(400).send({ message: "Timeout must be between 1 second and 1 hour." });
    }
    const validationTimeoutMs = typeof request.body?.validationTimeoutMs === "number" ? request.body.validationTimeoutMs : 600_000;
    if (!Number.isFinite(validationTimeoutMs) || validationTimeoutMs < 1_000 || validationTimeoutMs > 3_600_000) {
      return reply.code(400).send({ message: "Validation timeout must be between 1 second and 1 hour." });
    }

    const providersToCheck = [build.builderProvider, build.reviewerProvider] as const;
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
    const usageDecision = providersToCheck
      .map((checkedProvider) => usageSafety.evaluate(checkedProvider, { combined: true }))
      .find((decision) => !decision.allowed);
    if (usageDecision) {
      return reply.code(409).send({ message: usageDecision.reason, code: "USAGE_CHECKPOINT", decision: usageDecision });
    }

    void workflow.respondToFindings(build.id, {
      models: { CLAUDE: text(request.body?.claudeModel) ?? undefined, CODEX: text(request.body?.codexModel) ?? undefined },
      claudeEffort: text(request.body?.claudeEffort) ?? undefined,
      timeoutMs,
      validationTimeoutMs,
      validationCommandIds: stringArray(request.body?.validationCommandIds),
    });
    return reply.code(202).send({ message: "Sending open findings back to the builder.", buildRunId: build.id });
  });

  app.post<{ Params: { id: string }; Body: MergeBody }>("/api/builds/:id/merge", async (request, reply) => {
    const build = db.select().from(buildRuns).where(eq(buildRuns.id, request.params.id)).get();
    if (!build) return reply.code(404).send({ message: "Build not found." });
    if (build.status !== "COMPLETED") return reply.code(409).send({ message: "Only a completed build can be merged." });
    if (build.mergeStatus === "MERGING") return reply.code(409).send({ message: "A merge is already in progress for this build." });
    if (build.mergeStatus === "MERGED") return reply.code(409).send({ message: "This build has already been merged." });

    if (request.body?.targetBranch !== undefined && typeof request.body.targetBranch !== "string") {
      return reply.code(400).send({ message: "targetBranch must be a string." });
    }
    if (request.body?.commitMessage !== undefined && typeof request.body.commitMessage !== "string") {
      return reply.code(400).send({ message: "commitMessage must be a string." });
    }
    if (request.body?.keepWorktreeAfterMerge !== undefined && typeof request.body.keepWorktreeAfterMerge !== "boolean") {
      return reply.code(400).send({ message: "keepWorktreeAfterMerge must be true or false." });
    }
    if (request.body?.deleteBranchAfterMerge !== undefined && typeof request.body.deleteBranchAfterMerge !== "boolean") {
      return reply.code(400).send({ message: "deleteBranchAfterMerge must be true or false." });
    }
    const validationTimeoutMs = typeof request.body?.validationTimeoutMs === "number" ? request.body.validationTimeoutMs : 600_000;
    if (!Number.isFinite(validationTimeoutMs) || validationTimeoutMs < 1_000 || validationTimeoutMs > 3_600_000) {
      return reply.code(400).send({ message: "Validation timeout must be between 1 second and 1 hour." });
    }

    void workflow.mergeBuild(build.id, {
      targetBranch: text(request.body?.targetBranch) ?? undefined,
      commitMessage: text(request.body?.commitMessage) ?? undefined,
      keepWorktreeAfterMerge: request.body?.keepWorktreeAfterMerge === true,
      deleteBranchAfterMerge: request.body?.deleteBranchAfterMerge === true,
      validationCommandIds: stringArray(request.body?.validationCommandIds),
      validationTimeoutMs,
    });
    return reply.code(202).send({ message: "Merging into the target branch.", buildRunId: build.id });
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
