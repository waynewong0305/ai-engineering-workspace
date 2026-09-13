import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentProvider, AgentRunInput } from "@aiew/agents";
import { WorktreeService } from "@aiew/git";
import { and, eq, inArray } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns,
  evidenceItems,
  experiments,
  projects,
  taskArtifacts,
  tasks,
  worktrees,
  type AgentRunRecord,
  type ExperimentRecord,
  type ExperimentStatus,
  type ExperimentVerdict,
  type ExperimentVerdictArtifact,
  type ProjectRecord,
  type TaskRecord,
  type WorktreeRecord,
} from "../db/schema.js";
import { AgentRunManager } from "./agent-run-manager.js";
import { extractJson, record } from "./structured-output.js";
import { UsageCheckpointError, type UsageSafetyService } from "./usage-safety.js";
import type { WorktreeUsageManager } from "./worktree-usage-manager.js";

const BUILD_VERSION = "experiment-builder:v1";
const REVIEW_VERSION = "experiment-reviewer:v1";
const MAX_TEXT_CHARS = 5_000;

const promptRoot = fileURLToPath(new URL("../../../../prompts/", import.meta.url));
const builderTemplate = readFileSync(`${promptRoot}experiment-builder.md`, "utf8");
const reviewerTemplate = readFileSync(`${promptRoot}experiment-reviewer.md`, "utf8");

const VERDICTS = new Set<ExperimentVerdict>(["PROVEN", "DISPROVEN", "INCONCLUSIVE"]);

type ExperimentOptions = {
  models?: Partial<Record<AgentProvider, string>>;
  claudeEffort?: string;
  timeoutMs?: number;
};

function replace(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error("A required field is missing or invalid.");
  return value.trim();
}

function parseVerdict(text: string): ExperimentVerdictArtifact {
  const value = record(extractJson(text));
  if (!value) throw new Error("The reviewer's response does not match experiment-reviewer:v1.");
  const { verdict } = value;
  if (typeof verdict !== "string" || !VERDICTS.has(verdict as ExperimentVerdict)) throw new Error("The reviewer's verdict is missing or invalid.");
  return {
    verdict: verdict as ExperimentVerdict,
    reasoning: requiredString(value.reasoning, MAX_TEXT_CHARS),
    result: requiredString(value.result, MAX_TEXT_CHARS),
    conclusion: requiredString(value.conclusion, MAX_TEXT_CHARS),
  };
}

/**
 * PROJECT_SPEC.md §19: an architecture task can spin up an isolated worktree where "the selected
 * agent implements only the smallest POC required", then a second agent reviews it, and the result
 * becomes an EXPERIMENT_RESULT evidence-board item. Deliberately much smaller than
 * BuildReviewWorkflow: no validation-command execution (a POC isn't expected to pass a project's
 * full test suite), no finding-response/re-review loop, and no merge — the outcome is meant to
 * inform a decision via evidence, not to land in the target branch.
 */
export class ExperimentWorkflow {
  constructor(
    private readonly db: WorkspaceDatabase,
    private readonly manager: AgentRunManager,
    private readonly adapters: Map<AgentProvider, AgentAdapter>,
    private readonly worktreeService: WorktreeService,
    private readonly worktreeUsageManager: WorktreeUsageManager,
    private readonly usageSafety?: UsageSafetyService,
  ) {}

  async start(experimentId: string, options: ExperimentOptions = {}) {
    const experiment = this.getExperiment(experimentId);
    if (!experiment || experiment.status !== "RUNNING") return;
    try {
      await this.pipeline(experiment, options);
    } catch (error) {
      this.handleWorkflowError(experiment.id, error);
    }
  }

  async cancel(experimentId: string): Promise<boolean> {
    const experiment = this.getExperiment(experimentId);
    if (!experiment || !["RUNNING", "REVIEWING", "CHECKPOINTED"].includes(experiment.status)) return false;
    const runIds = [experiment.builderRunId, experiment.reviewerRunId].filter((id): id is string => Boolean(id));
    const activeRuns = runIds.length
      ? this.db.select().from(agentRuns).where(and(
        inArray(agentRuns.id, runIds), inArray(agentRuns.status, ["QUEUED", "RUNNING"]),
      )).all()
      : [];
    await Promise.all(activeRuns.map((run) => this.manager.cancel(run.id, this.adapters.get(run.provider)!)));
    this.db.update(experiments).set({ status: "CANCELLED", updatedAt: new Date().toISOString() }).where(eq(experiments.id, experimentId)).run();
    if (experiment.worktreeId) this.worktreeUsageManager.release(experiment.worktreeId, "AGENT_RUN", experimentId);
    return true;
  }

  private async pipeline(initial: ExperimentRecord, options: ExperimentOptions) {
    const task = this.db.select().from(tasks).where(eq(tasks.id, initial.taskId)).get();
    if (!task) return this.fail(initial.id, "The task no longer exists.");
    const project = this.db.select().from(projects).where(eq(projects.id, initial.projectId)).get();
    if (!project) return this.fail(initial.id, "The registered project no longer exists.");
    const worktree = initial.worktreeId ? this.db.select().from(worktrees).where(eq(worktrees.id, initial.worktreeId)).get() : null;
    if (!worktree) return this.fail(initial.id, "The experiment worktree no longer exists.");

    this.worktreeUsageManager.acquire(worktree.id, "AGENT_RUN", initial.id);

    let experiment = initial;
    if (experiment.status === "RUNNING") {
      const builderRun = await this.runBuilder(experiment, task, project, worktree, options);
      if (!builderRun) return;
      await this.collectDiff(experiment, worktree);
      this.updateStatus(experiment.id, "REVIEWING");
      experiment = this.getExperiment(experiment.id)!;
    }
    if (experiment.status === "REVIEWING") {
      await this.runReviewer(experiment, task, project, worktree, options);
    }
  }

  private assertPhaseReady(providers: readonly AgentProvider[]) {
    for (const provider of providers) this.usageSafety?.assertReady(provider, { combined: true });
  }

  private async runBuilder(
    experiment: ExperimentRecord, task: TaskRecord, project: ProjectRecord, worktree: WorktreeRecord, options: ExperimentOptions,
  ): Promise<AgentRunRecord | null> {
    this.assertPhaseReady([experiment.builderProvider, experiment.reviewerProvider]);
    const adapter = this.adapters.get(experiment.builderProvider);
    if (!adapter) throw new Error(`${experiment.builderProvider} adapter is unavailable.`);
    this.usageSafety?.assertReady(experiment.builderProvider, { combined: true });

    const prompt = replace(builderTemplate, {
      TITLE: task.title,
      PROJECT_CONTEXT: project.projectContext ?? "No project context was supplied.",
      HYPOTHESIS: experiment.hypothesis,
    });
    const run = this.buildAgentRun(experiment, task, project, worktree, {
      provider: experiment.builderProvider, targetProvider: null,
      prompt, promptVersion: BUILD_VERSION, permissionProfile: "WORKTREE_WRITE", options,
    });
    this.db.insert(agentRuns).values(run).run();
    this.db.update(experiments).set({ builderRunId: run.id, updatedAt: new Date().toISOString() }).where(eq(experiments.id, experiment.id)).run();
    await this.manager.start(run, adapter, this.agentRunInput(run, worktree.path, task, options));

    if (this.isCancelled(experiment.id)) return null;
    const completed = this.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()!;
    if (completed.status !== "COMPLETED") {
      this.fail(experiment.id, "The builder run did not complete successfully.");
      return null;
    }
    return completed;
  }

  private async collectDiff(experiment: ExperimentRecord, worktree: WorktreeRecord) {
    const diff = await this.worktreeService.diffIncludingUntracked(worktree.path);
    this.db.update(experiments).set({
      diffUnstaged: diff.unstaged, diffStaged: diff.staged, updatedAt: new Date().toISOString(),
    }).where(eq(experiments.id, experiment.id)).run();
  }

  private async runReviewer(
    experiment: ExperimentRecord, task: TaskRecord, project: ProjectRecord, worktree: WorktreeRecord, options: ExperimentOptions,
  ) {
    this.assertPhaseReady([experiment.builderProvider, experiment.reviewerProvider]);
    const adapter = this.adapters.get(experiment.reviewerProvider);
    if (!adapter) throw new Error(`${experiment.reviewerProvider} adapter is unavailable.`);
    this.usageSafety?.assertReady(experiment.reviewerProvider, { combined: true });

    const builderRun = experiment.builderRunId ? this.db.select().from(agentRuns).where(eq(agentRuns.id, experiment.builderRunId)).get() : null;
    const diffText = `${experiment.diffStaged ?? ""}${experiment.diffUnstaged ?? ""}`.trim() || "(no changes were detected in the worktree)";
    const prompt = replace(reviewerTemplate, {
      TITLE: task.title, HYPOTHESIS: experiment.hypothesis,
      BUILDER_SUMMARY: builderRun?.output.trim() || "(no builder summary was recorded)",
      DIFF: diffText,
    });
    const run = this.buildAgentRun(experiment, task, project, worktree, {
      provider: experiment.reviewerProvider, targetProvider: experiment.builderProvider,
      prompt, promptVersion: REVIEW_VERSION, permissionProfile: "READ_ONLY", options,
    });
    this.db.insert(agentRuns).values(run).run();
    this.db.update(experiments).set({ reviewerRunId: run.id, updatedAt: new Date().toISOString() }).where(eq(experiments.id, experiment.id)).run();
    await this.manager.start(run, adapter, this.agentRunInput(run, worktree.path, task, options));

    if (this.isCancelled(experiment.id)) return;
    const completed = this.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()!;
    if (completed.status !== "COMPLETED") {
      this.fail(experiment.id, "The reviewer run did not complete successfully.");
      return;
    }
    this.storeVerdict(experiment, task, completed);
  }

  private buildAgentRun(
    experiment: ExperimentRecord, task: TaskRecord, project: ProjectRecord, worktree: WorktreeRecord,
    input: {
      provider: AgentProvider; targetProvider: AgentProvider | null; prompt: string; promptVersion: string;
      permissionProfile: "WORKTREE_WRITE" | "READ_ONLY"; options: ExperimentOptions;
    },
  ): AgentRunRecord {
    const now = new Date().toISOString();
    const requestedModel = input.options.models?.[input.provider]?.trim() || "(provider default)";
    return {
      id: randomUUID(), projectId: project.id, taskId: task.id, worktreeId: worktree.id,
      provider: input.provider, role: input.permissionProfile === "WORKTREE_WRITE" ? "BUILD" : "REVIEW",
      targetProvider: input.targetProvider,
      prompt: input.prompt, promptVersion: input.promptVersion, requestedModel, actualModel: null,
      effort: input.provider === "CLAUDE" ? input.options.claudeEffort?.trim() || null : null,
      permissionProfile: input.permissionProfile,
      webAccessPolicy: task.webAccessPolicy, webAccessPermitted: task.webAccessPermitted,
      status: "QUEUED", output: "", rawOutput: "", errorOutput: "", errorMessage: null,
      exitCode: null, cliVersion: null, durationMs: null, startedAt: null, completedAt: null,
      createdAt: now, updatedAt: now,
    };
  }

  private agentRunInput(run: AgentRunRecord, cwd: string, task: TaskRecord, options: ExperimentOptions): AgentRunInput {
    return {
      runId: run.id, cwd, prompt: run.prompt, promptVersion: run.promptVersion, permissionProfile: run.permissionProfile,
      webAccess: {
        policy: task.webAccessPolicy, permitted: task.webAccessPermitted,
        decidedAt: task.webAccessDecidedAt, decidedBy: "USER",
      },
      outputFormat: "JSONL", timeoutMs: options.timeoutMs ?? 900_000, environment: {},
      model: { requested: run.requestedModel, effort: run.effort ?? undefined },
    };
  }

  private storeVerdict(experiment: ExperimentRecord, task: TaskRecord, run: AgentRunRecord) {
    let data: ExperimentVerdictArtifact | null = null;
    let parseError: string | null = null;
    try { data = parseVerdict(run.output); } catch (error) { parseError = error instanceof Error ? error.message : "Could not parse the experiment verdict."; }
    this.db.insert(taskArtifacts).values({
      id: randomUUID(), taskId: task.id, runId: run.id, kind: "EXPERIMENT_RESULT", provider: run.provider,
      targetProvider: run.targetProvider, structuredData: data, rawOutput: run.output, parseError, createdAt: new Date().toISOString(),
    }).run();
    if (!data) {
      this.fail(experiment.id, `The reviewer's verdict could not be parsed: ${parseError}`);
      return;
    }

    const now = new Date().toISOString();
    const evidenceItem = {
      id: randomUUID(), taskId: task.id, type: "EXPERIMENT_RESULT" as const,
      content: `Hypothesis: ${experiment.hypothesis}\nVerdict: ${data.verdict}\nConclusion: ${data.conclusion}`,
      sourceProvider: run.provider, sourceArtifactId: null, createdAt: now, updatedAt: now,
    };
    this.db.insert(evidenceItems).values(evidenceItem).run();
    this.db.update(experiments).set({
      status: "COMPLETED", testExecuted: data.result, result: data.result, conclusion: data.conclusion,
      verdict: data.verdict, evidenceItemId: evidenceItem.id, errorMessage: null, updatedAt: now,
    }).where(eq(experiments.id, experiment.id)).run();
    this.releaseLease(experiment.id);
  }

  private handleWorkflowError(experimentId: string, error: unknown) {
    if (error instanceof UsageCheckpointError) {
      this.db.update(experiments).set({ status: "CHECKPOINTED", errorMessage: error.message, updatedAt: new Date().toISOString() }).where(eq(experiments.id, experimentId)).run();
      return;
    }
    this.fail(experimentId, error instanceof Error ? error.message : "The experiment workflow failed.");
  }

  private fail(experimentId: string, message: string) {
    this.db.update(experiments).set({ status: "FAILED", errorMessage: message, updatedAt: new Date().toISOString() }).where(eq(experiments.id, experimentId)).run();
    this.releaseLease(experimentId);
  }

  private releaseLease(experimentId: string) {
    const experiment = this.getExperiment(experimentId);
    if (experiment?.worktreeId) this.worktreeUsageManager.release(experiment.worktreeId, "AGENT_RUN", experimentId);
  }

  private updateStatus(experimentId: string, status: ExperimentStatus) {
    this.db.update(experiments).set({ status, errorMessage: null, updatedAt: new Date().toISOString() }).where(eq(experiments.id, experimentId)).run();
  }

  private isCancelled(experimentId: string) {
    return this.getExperiment(experimentId)?.status === "CANCELLED";
  }

  private getExperiment(experimentId: string) {
    return this.db.select().from(experiments).where(eq(experiments.id, experimentId)).get();
  }
}
