import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentProvider, AgentRunInput } from "@aiew/agents";
import { WorktreeService } from "@aiew/git";
import { and, eq, inArray } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns,
  buildRuns,
  projects,
  reviewFindings,
  taskArtifacts,
  tasks,
  validationRuns,
  worktrees,
  type AgentRunRecord,
  type BuildRunRecord,
  type BuildRunStatus,
  type FindingCategory,
  type FindingConfidence,
  type FindingSeverity,
  type ParsedFinding,
  type ProjectRecord,
  type ReviewFindingsArtifact,
  type TaskRecord,
  type WorktreeRecord,
} from "../db/schema.js";
import { AgentRunManager } from "./agent-run-manager.js";
import { extractJson, record } from "./structured-output.js";
import { UsageCheckpointError, type UsageSafetyService } from "./usage-safety.js";
import { ValidationRunner } from "./validation-runner.js";
import type { WorktreeUsageManager } from "./worktree-usage-manager.js";

const BUILD_VERSION = "build:v1";
const REVIEW_VERSION = "code-review:v1";
const MAX_FINDINGS = 100;
const MAX_TITLE_CHARS = 300;
const MAX_FINDING_TEXT_CHARS = 5_000;
const MAX_FILE_CHARS = 1_024;

const promptRoot = fileURLToPath(new URL("../../../../prompts/", import.meta.url));
const builderTemplate = readFileSync(`${promptRoot}builder.md`, "utf8");
const reviewerTemplate = readFileSync(`${promptRoot}code-reviewer.md`, "utf8");

const SEVERITIES = new Set<FindingSeverity>(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);
const CATEGORIES = new Set<FindingCategory>([
  "CORRECTNESS", "RACE_CONDITION", "SECURITY", "DATA_INTEGRITY", "PERFORMANCE",
  "TESTING", "MAINTAINABILITY", "MIGRATION", "COMPATIBILITY",
]);
const CONFIDENCES = new Set<FindingConfidence>(["LOW", "MEDIUM", "HIGH"]);

type BuildWorkflowOptions = {
  models?: Partial<Record<AgentProvider, string>>;
  claudeEffort?: string;
  timeoutMs?: number;
  validationTimeoutMs?: number;
  validationCommandIds?: string[];
};

function replace(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength) throw new Error("A finding field is invalid.");
  return value.trim() || null;
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error("A finding field is invalid.");
  return value.trim();
}

function optionalLine(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("A finding line number is invalid.");
  return value;
}

function parseFinding(candidate: unknown): ParsedFinding {
  const item = record(candidate);
  if (!item) throw new Error("A finding must be an object.");
  const { severity, category, confidence } = item;
  if (typeof severity !== "string" || !SEVERITIES.has(severity as FindingSeverity)) throw new Error("A finding has an invalid severity.");
  if (typeof category !== "string" || !CATEGORIES.has(category as FindingCategory)) throw new Error("A finding has an invalid category.");
  if (typeof confidence !== "string" || !CONFIDENCES.has(confidence as FindingConfidence)) throw new Error("A finding has an invalid confidence.");
  const startLine = optionalLine(item.startLine);
  const endLine = optionalLine(item.endLine);
  if (startLine !== null && endLine !== null && endLine < startLine) throw new Error("A finding's endLine must be >= startLine.");
  return {
    severity: severity as FindingSeverity,
    category: category as FindingCategory,
    file: optionalString(item.file, MAX_FILE_CHARS),
    startLine,
    endLine,
    title: requiredString(item.title, MAX_TITLE_CHARS),
    description: requiredString(item.description, MAX_FINDING_TEXT_CHARS),
    evidence: requiredString(item.evidence, MAX_FINDING_TEXT_CHARS),
    impact: requiredString(item.impact, MAX_FINDING_TEXT_CHARS),
    suggestedFix: optionalString(item.suggestedFix, MAX_FINDING_TEXT_CHARS),
    suggestedTest: optionalString(item.suggestedTest, MAX_FINDING_TEXT_CHARS),
    confidence: confidence as FindingConfidence,
  };
}

/**
 * All-or-nothing, matching parseAnalysis/parseReview's strictness: a single invalid finding fails
 * the whole parse. The raw output is still retained on the taskArtifacts row regardless (see
 * storeFindings) — nothing the reviewer said is ever silently dropped, even when it can't be used.
 */
function parseFindings(text: string): ReviewFindingsArtifact {
  const value = record(extractJson(text));
  if (!value || !Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) {
    throw new Error("The review JSON does not match code-review:v1.");
  }
  return { findings: value.findings.map(parseFinding) };
}

export class BuildReviewWorkflow {
  constructor(
    private readonly db: WorkspaceDatabase,
    private readonly manager: AgentRunManager,
    private readonly adapters: Map<AgentProvider, AgentAdapter>,
    private readonly worktreeService: WorktreeService,
    private readonly worktreeUsageManager: WorktreeUsageManager,
    private readonly usageSafety?: UsageSafetyService,
  ) {}

  async start(buildRunId: string, options: BuildWorkflowOptions = {}) {
    const build = this.getBuild(buildRunId);
    if (!build || build.status !== "BUILDING") return;
    try {
      await this.pipeline(build, options);
    } catch (error) {
      this.handleWorkflowError(build.id, error);
    }
  }

  /**
   * Resume a build paused by a usage-safety checkpoint. A checkpoint can only occur before a
   * provider call actually starts (assertReady is checked before the agentRuns row is inserted), so
   * either nothing about the current phase was persisted yet (restart it), or the diff was already
   * collected (builder+validation are done — resume straight into review, recheck usage first).
   */
  async resume(buildRunId: string, options: BuildWorkflowOptions = {}) {
    const build = this.getBuild(buildRunId);
    if (!build || build.status !== "CHECKPOINTED") return;
    try {
      this.updateStatus(build.id, build.diffUnstaged !== null ? "REVIEWING" : "BUILDING");
      await this.pipeline(this.getBuild(build.id)!, options);
    } catch (error) {
      this.handleWorkflowError(build.id, error);
    }
  }

  async cancel(buildRunId: string): Promise<boolean> {
    const build = this.getBuild(buildRunId);
    if (!build || !["BUILDING", "VALIDATING", "REVIEWING", "CHECKPOINTED"].includes(build.status)) return false;
    const runIds = [build.builderRunId, build.reviewerRunId].filter((id): id is string => Boolean(id));
    const activeRuns = runIds.length
      ? this.db.select().from(agentRuns).where(and(
        inArray(agentRuns.id, runIds), inArray(agentRuns.status, ["QUEUED", "RUNNING"]),
      )).all()
      : [];
    await Promise.all(activeRuns.map((run) => this.manager.cancel(run.id, this.adapters.get(run.provider)!)));
    this.db.update(buildRuns).set({ status: "CANCELLED", updatedAt: new Date().toISOString() }).where(eq(buildRuns.id, buildRunId)).run();
    if (build.worktreeId) this.worktreeUsageManager.release(build.worktreeId, "AGENT_RUN", buildRunId);
    return true;
  }

  /** See BrainstormWorkflow.assertPhaseReady: check every provider a phase needs, together, first. */
  private assertPhaseReady(providers: readonly AgentProvider[]) {
    for (const provider of providers) this.usageSafety?.assertReady(provider, { combined: true });
  }

  private async pipeline(initial: BuildRunRecord, options: BuildWorkflowOptions) {
    const task = this.db.select().from(tasks).where(eq(tasks.id, initial.taskId)).get();
    if (!task) return this.fail(initial.id, "The task no longer exists.");
    const project = this.db.select().from(projects).where(eq(projects.id, initial.projectId)).get();
    if (!project) return this.fail(initial.id, "The registered project no longer exists.");
    const worktree = initial.worktreeId ? this.db.select().from(worktrees).where(eq(worktrees.id, initial.worktreeId)).get() : null;
    if (!worktree) return this.fail(initial.id, "The builder worktree no longer exists.");

    // First production caller of acquire/release: one continuous lease spans build+validate+review,
    // released only on a terminal outcome. Idempotent, so a resumed run re-acquiring is a no-op.
    this.worktreeUsageManager.acquire(worktree.id, "AGENT_RUN", initial.id);

    let build = initial;
    if (build.status === "BUILDING") {
      const builderRun = await this.runBuilder(build, task, project, worktree, options);
      if (!builderRun) return;
      this.updateStatus(build.id, "VALIDATING");
      await this.runValidation(build, project, worktree, options);
      await this.collectDiff(build, worktree);
      this.updateStatus(build.id, "REVIEWING");
      build = this.getBuild(build.id)!;
    }
    if (build.status === "REVIEWING") {
      await this.runReviewer(build, task, project, worktree, options);
    }
  }

  private async runBuilder(
    build: BuildRunRecord,
    task: TaskRecord,
    project: ProjectRecord,
    worktree: WorktreeRecord,
    options: BuildWorkflowOptions,
  ): Promise<AgentRunRecord | null> {
    this.assertPhaseReady([build.builderProvider, build.reviewerProvider]);
    const adapter = this.adapters.get(build.builderProvider);
    if (!adapter) throw new Error(`${build.builderProvider} adapter is unavailable.`);
    // Recheck immediately before this specific call, same as every per-call recheck in
    // BrainstormWorkflow.run — usage can change while a phase is already in flight.
    this.usageSafety?.assertReady(build.builderProvider, { combined: true });

    const prompt = replace(builderTemplate, {
      TITLE: task.title,
      TYPE: task.type,
      RISK_LEVEL: task.riskLevel,
      PROJECT_CONTEXT: project.projectContext ?? "No project context was supplied.",
      PROBLEM_STATEMENT: task.problemStatement,
    });
    const run = this.buildAgentRun(build, task, project, worktree, {
      provider: build.builderProvider, role: "BUILD", targetProvider: null,
      prompt, promptVersion: BUILD_VERSION, permissionProfile: "WORKTREE_WRITE", options,
    });
    this.db.insert(agentRuns).values(run).run();
    this.db.update(buildRuns).set({ builderRunId: run.id, updatedAt: new Date().toISOString() }).where(eq(buildRuns.id, build.id)).run();
    await this.manager.start(run, adapter, this.agentRunInput(run, worktree.path, task, options));

    if (this.isCancelled(build.id)) return null;
    const completed = this.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()!;
    if (completed.status !== "COMPLETED") {
      this.fail(build.id, "The builder run did not complete successfully.");
      return null;
    }
    return completed;
  }

  private async runValidation(build: BuildRunRecord, project: ProjectRecord, worktree: WorktreeRecord, options: BuildWorkflowOptions) {
    const commands = options.validationCommandIds?.length
      ? project.validationCommands.filter((command) => options.validationCommandIds!.includes(command.id))
      : project.validationCommands;
    const runner = new ValidationRunner();
    // A failing validation command does not fail the build_run — it is recorded truthfully (per
    // PROJECT_SPEC.md §24, never claim a pass that didn't happen) and review proceeds regardless,
    // matching the straight-line flow in §21's diagram.
    const results = await runner.run(worktree.path, worktree.id, commands, options.validationTimeoutMs ?? 600_000);
    const now = new Date().toISOString();
    for (const result of results) {
      this.db.insert(validationRuns).values({ ...result, buildRunId: build.id, createdAt: now }).run();
    }
  }

  private async collectDiff(build: BuildRunRecord, worktree: WorktreeRecord) {
    const diff = await this.worktreeService.diffIncludingUntracked(worktree.path);
    this.db.update(buildRuns).set({
      diffUnstaged: diff.unstaged, diffStaged: diff.staged, updatedAt: new Date().toISOString(),
    }).where(eq(buildRuns.id, build.id)).run();
  }

  private async runReviewer(
    build: BuildRunRecord,
    task: TaskRecord,
    project: ProjectRecord,
    worktree: WorktreeRecord,
    options: BuildWorkflowOptions,
  ) {
    this.assertPhaseReady([build.builderProvider, build.reviewerProvider]);
    const adapter = this.adapters.get(build.reviewerProvider);
    if (!adapter) throw new Error(`${build.reviewerProvider} adapter is unavailable.`);
    this.usageSafety?.assertReady(build.reviewerProvider, { combined: true });

    const diffText = `${build.diffStaged ?? ""}${build.diffUnstaged ?? ""}`.trim() || "(no changes were detected in the worktree)";
    const prompt = replace(reviewerTemplate, { TITLE: task.title, PROBLEM_STATEMENT: task.problemStatement, DIFF: diffText });
    const run = this.buildAgentRun(build, task, project, worktree, {
      provider: build.reviewerProvider, role: "REVIEW", targetProvider: build.builderProvider,
      prompt, promptVersion: REVIEW_VERSION, permissionProfile: "READ_ONLY", options,
    });
    this.db.insert(agentRuns).values(run).run();
    this.db.update(buildRuns).set({ reviewerRunId: run.id, updatedAt: new Date().toISOString() }).where(eq(buildRuns.id, build.id)).run();
    await this.manager.start(run, adapter, this.agentRunInput(run, worktree.path, task, options));

    if (this.isCancelled(build.id)) return;
    const completed = this.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()!;
    if (completed.status !== "COMPLETED") {
      this.fail(build.id, "The reviewer run did not complete successfully.");
      return;
    }
    this.storeFindings(build, completed);
  }

  private buildAgentRun(
    build: BuildRunRecord,
    task: TaskRecord,
    project: ProjectRecord,
    worktree: WorktreeRecord,
    input: {
      provider: AgentProvider;
      role: "BUILD" | "REVIEW";
      targetProvider: AgentProvider | null;
      prompt: string;
      promptVersion: string;
      permissionProfile: "WORKTREE_WRITE" | "READ_ONLY";
      options: BuildWorkflowOptions;
    },
  ): AgentRunRecord {
    const now = new Date().toISOString();
    const requestedModel = input.options.models?.[input.provider]?.trim() || "(provider default)";
    return {
      id: randomUUID(), projectId: project.id, taskId: task.id, worktreeId: worktree.id,
      provider: input.provider, role: input.role, targetProvider: input.targetProvider,
      prompt: input.prompt, promptVersion: input.promptVersion, requestedModel, actualModel: null,
      effort: input.provider === "CLAUDE" ? input.options.claudeEffort?.trim() || null : null,
      permissionProfile: input.permissionProfile,
      webAccessPolicy: task.webAccessPolicy, webAccessPermitted: task.webAccessPermitted,
      status: "QUEUED", output: "", rawOutput: "", errorOutput: "", errorMessage: null,
      exitCode: null, cliVersion: null, durationMs: null, startedAt: null, completedAt: null,
      createdAt: now, updatedAt: now,
    };
  }

  private agentRunInput(run: AgentRunRecord, cwd: string, task: TaskRecord, options: BuildWorkflowOptions): AgentRunInput {
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

  private storeFindings(build: BuildRunRecord, run: AgentRunRecord) {
    let data: ReviewFindingsArtifact | null = null;
    let parseError: string | null = null;
    try { data = parseFindings(run.output); } catch (error) { parseError = error instanceof Error ? error.message : "Could not parse review findings."; }
    this.db.insert(taskArtifacts).values({
      id: randomUUID(), taskId: build.taskId, runId: run.id, kind: "REVIEW_FINDINGS", provider: run.provider,
      targetProvider: run.targetProvider, structuredData: data, rawOutput: run.output, parseError, createdAt: new Date().toISOString(),
    }).run();
    if (!data) {
      // Unlike the builder's tolerance for free text, the reviewer's entire deliverable is its
      // structured findings — an unparseable response has produced nothing usable.
      this.fail(build.id, `The reviewer's response could not be parsed: ${parseError}`);
      return;
    }
    const now = new Date().toISOString();
    data.findings.forEach((finding, ordinal) => {
      this.db.insert(reviewFindings).values({
        id: randomUUID(), buildRunId: build.id, reviewerRunId: run.id, ordinal, status: "OPEN", createdAt: now, ...finding,
      }).run();
    });
    this.complete(build.id);
  }

  private handleWorkflowError(buildRunId: string, error: unknown) {
    if (error instanceof UsageCheckpointError) {
      this.checkpoint(buildRunId, error.message);
      return;
    }
    this.fail(buildRunId, error instanceof Error ? error.message : "The build/review workflow failed.");
  }

  private complete(buildRunId: string) {
    this.db.update(buildRuns).set({ status: "COMPLETED", errorMessage: null, updatedAt: new Date().toISOString() }).where(eq(buildRuns.id, buildRunId)).run();
    this.releaseLease(buildRunId);
  }

  private fail(buildRunId: string, message: string) {
    this.db.update(buildRuns).set({ status: "FAILED", errorMessage: message, updatedAt: new Date().toISOString() }).where(eq(buildRuns.id, buildRunId)).run();
    this.releaseLease(buildRunId);
  }

  /**
   * Pause for a usage-safety checkpoint rather than fail. The lease is deliberately not released
   * here: the existing stale-after-6h + explicit-release mechanism already covers an abandoned
   * checkpoint, and resume() re-acquires the same (idempotent) lease when it picks the build back up.
   */
  private checkpoint(buildRunId: string, message: string) {
    this.db.update(buildRuns).set({ status: "CHECKPOINTED", errorMessage: message, updatedAt: new Date().toISOString() }).where(eq(buildRuns.id, buildRunId)).run();
  }

  private releaseLease(buildRunId: string) {
    const build = this.getBuild(buildRunId);
    if (build?.worktreeId) this.worktreeUsageManager.release(build.worktreeId, "AGENT_RUN", buildRunId);
  }

  private updateStatus(buildRunId: string, status: BuildRunStatus) {
    this.db.update(buildRuns).set({ status, errorMessage: null, updatedAt: new Date().toISOString() }).where(eq(buildRuns.id, buildRunId)).run();
  }

  private isCancelled(buildRunId: string) {
    return this.getBuild(buildRunId)?.status === "CANCELLED";
  }

  private getBuild(buildRunId: string) {
    return this.db.select().from(buildRuns).where(eq(buildRuns.id, buildRunId)).get();
  }
}
