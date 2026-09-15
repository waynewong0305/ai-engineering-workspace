import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentProvider, AgentRunInput } from "@aiew/agents";
import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns,
  evidenceItems,
  projects,
  questionDetails,
  questionResponses,
  taskArtifacts,
  taskComparisons,
  tasks,
  type AgentRunRecord,
  type BrainstormAnalysis,
  type CrossReview,
  type EvidenceType,
  type StructuredQuestion,
  type TaskComparison,
  type TaskRecord,
} from "../db/schema.js";
import { AgentRunManager } from "./agent-run-manager.js";
import { ensureQuestionDetails } from "./question-details.js";
import { extractJson, MAX_ITEM_CHARS, record, strings, structuredQuestions } from "./structured-output.js";
import { UsageCheckpointError, type UsageSafetyService } from "./usage-safety.js";
import { UsageBudgetCheckpointError, type UsageBudgetService } from "./usage-settings.js";

const ANALYSIS_VERSION = "brainstorm-analysis:v2";
const REVISE_ANALYSIS_VERSION = "brainstorm-analysis-revise:v2";
const REVIEW_VERSION = "cross-review:v2";
const promptRoot = fileURLToPath(new URL("../../../../prompts/", import.meta.url));
const analysisTemplate = readFileSync(`${promptRoot}brainstorm-analysis.md`, "utf8");
const reviseAnalysisTemplate = readFileSync(`${promptRoot}brainstorm-analysis-revise.md`, "utf8");
const reviewTemplate = readFileSync(`${promptRoot}cross-review.md`, "utf8");

type WorkflowOptions = {
  models?: Partial<Record<AgentProvider, string>>;
  claudeEffort?: string;
  timeoutMs?: number;
};

/**
 * Both phase methods default to today's plain behavior (reuse whatever artifacts already exist for
 * a provider, original template/version) so `start`/`resume` need no changes. `reviseWithAnswers`
 * passes `force: true` so a fresh round always re-runs both providers instead of treating a prior
 * round's artifact as "already done" — the actual fix for the otherwise no-op problem of re-entering
 * a READY task — plus a different analysis template/version and extra prompt values.
 */
type PhaseOptions = { force?: boolean; template?: string; promptVersion?: string; extraValues?: Record<string, string> };

function replace(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

function parseAnalysis(text: string): BrainstormAnalysis {
  const value = record(extractJson(text));
  const summary = typeof value?.summary === "string" ? value.summary.trim() : "";
  const facts = strings(value?.facts);
  const assumptions = strings(value?.assumptions);
  const unknowns = structuredQuestions(value?.unknowns);
  const experiments = strings(value?.recommendedExperiments);
  if (
    !value || !summary || summary.length > MAX_ITEM_CHARS || !facts || !assumptions || !unknowns || !experiments
    || !Array.isArray(value.options) || value.options.length > 25
  ) {
    throw new Error("The analysis JSON does not match brainstorm-analysis:v2.");
  }
  const options = value.options.map((candidate) => {
    const item = record(candidate);
    const advantages = strings(item?.advantages);
    const disadvantages = strings(item?.disadvantages);
    const risks = strings(item?.risks);
    if (
      !item || typeof item.name !== "string" || !item.name.trim() || item.name.length > 500
      || typeof item.description !== "string" || !item.description.trim() || item.description.length > MAX_ITEM_CHARS
      || !advantages || !disadvantages || !risks
    ) {
      throw new Error("The analysis contains an invalid option.");
    }
    return { name: item.name.trim(), description: item.description.trim(), advantages, disadvantages, risks };
  });
  if (value.recommendation !== null && (typeof value.recommendation !== "string" || value.recommendation.length > MAX_ITEM_CHARS)) {
    throw new Error("The analysis recommendation must be a string or null.");
  }
  return { summary, facts, assumptions, unknowns, options, recommendedExperiments: experiments, recommendation: value.recommendation?.trim() || null };
}

function parseReview(text: string): CrossReview {
  const value = record(extractJson(text));
  const summary = typeof value?.summary === "string" ? value.summary.trim() : "";
  const plainFields = [
    "agreements", "disagreements", "factualErrors", "unsupportedAssumptions", "missingFailureCases",
    "hiddenOperationalCosts", "migrationRisks", "missingEvidence", "recommendedExperiments",
  ] as const;
  if (!value || !summary || summary.length > MAX_ITEM_CHARS) throw new Error("The review JSON does not match cross-review:v2.");
  const parsed = Object.fromEntries(plainFields.map((field) => [field, strings(value[field])])) as Record<typeof plainFields[number], string[] | null>;
  const openQuestions = structuredQuestions(value.openQuestions);
  if (plainFields.some((field) => !parsed[field]) || !openQuestions) throw new Error("The review JSON is missing one or more required lists.");
  return { summary, ...parsed, openQuestions } as CrossReview;
}

function questionText(item: string | StructuredQuestion): string {
  return typeof item === "string" ? item : item.question;
}

function unique(items: Array<string | null | undefined>) {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const value = item?.trim();
    if (!value) return [];
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [value];
  });
}

function compare(analyses: BrainstormAnalysis[], reviews: CrossReview[]): TaskComparison {
  return {
    consensus: unique(reviews.flatMap((review) => review.agreements)),
    disagreements: unique(reviews.flatMap((review) => [
      ...review.disagreements,
      ...review.factualErrors.map((item) => `Factual concern: ${item}`),
      ...review.unsupportedAssumptions.map((item) => `Unsupported assumption: ${item}`),
    ])),
    openQuestions: unique([
      ...analyses.flatMap((analysis) => analysis.unknowns.map(questionText)),
      ...reviews.flatMap((review) => review.openQuestions.map(questionText)),
    ]),
    missingEvidence: unique(reviews.flatMap((review) => review.missingEvidence)),
    recommendedExperiments: unique([
      ...analyses.flatMap((analysis) => analysis.recommendedExperiments),
      ...reviews.flatMap((review) => review.recommendedExperiments),
    ]),
  };
}

type StoredAnalysis = { provider: AgentProvider; data: BrainstormAnalysis | null };
type StoredReview = { provider: AgentProvider; data: CrossReview | null };

export class BrainstormWorkflow {
  constructor(
    private readonly db: WorkspaceDatabase,
    private readonly manager: AgentRunManager,
    private readonly adapters: Map<AgentProvider, AgentAdapter>,
    private readonly usageSafety?: UsageSafetyService,
    private readonly usageBudgets?: UsageBudgetService,
  ) {}

  async start(taskId: string, options: WorkflowOptions = {}) {
    const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task || task.status !== "DRAFT") return;
    const project = this.db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!project) return this.fail(task.id, "The registered project no longer exists.");
    this.updateStatus(task.id, "ANALYZING");

    try {
      const analyses = await this.runAnalysisPhase(task, project.repositoryPath, project.projectContext, options);
      if (!analyses) return;
      await this.runCrossReviewPhase(task, project.repositoryPath, analyses, options);
    } catch (error) {
      this.handleWorkflowError(task.id, error);
    }
  }

  /**
   * Resume a task paused by a usage-safety checkpoint. If both independent analyses already
   * completed and persisted before the checkpoint, nothing already done is re-run or lost: the
   * workflow proceeds straight to cross-review (rechecking usage again first). Otherwise it
   * restarts the analysis phase, which is safe to redo since a checkpoint before analysis means
   * no provider run for this task had started.
   */
  async resume(taskId: string, options: WorkflowOptions = {}) {
    const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task || task.status !== "CHECKPOINTED") return;
    const project = this.db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!project) return this.fail(task.id, "The registered project no longer exists.");

    try {
      const existing = this.db.select().from(taskArtifacts).where(and(
        eq(taskArtifacts.taskId, task.id), eq(taskArtifacts.kind, "ANALYSIS"),
      )).all();
      const byProvider = new Map(existing.map((artifact) => [artifact.provider, artifact.structuredData as BrainstormAnalysis | null]));
      const analyses: StoredAnalysis[] = (["CLAUDE", "CODEX"] as const).map((provider) => ({ provider, data: byProvider.get(provider) ?? null }));
      if (analyses.every((entry) => entry.data)) {
        this.updateStatus(task.id, "CROSS_REVIEW");
        await this.runCrossReviewPhase(task, project.repositoryPath, analyses, options);
      } else {
        this.updateStatus(task.id, "ANALYZING");
        const restarted = await this.runAnalysisPhase(task, project.repositoryPath, project.projectContext, options);
        if (!restarted) return;
        await this.runCrossReviewPhase(task, project.repositoryPath, restarted, options);
      }
    } catch (error) {
      this.handleWorkflowError(task.id, error);
    }
  }

  /**
   * Check every provider this phase is about to call, together, before starting any of them.
   * Without this, Promise.all lets a ready provider's process actually start and spend usage even
   * though its sibling call is refused a moment later — wasting a call whose result can never be
   * used once the phase as a whole cannot complete. The per-call check inside `run()` remains as
   * well, since usage can still change while a phase is already in flight.
   */
  private async assertPhaseReady(providers: readonly AgentProvider[]) {
    await Promise.all(providers.map((provider) => this.usageSafety?.assertReady(provider, { combined: true })));
  }

  private async runAnalysisPhase(
    task: TaskRecord,
    repositoryPath: string,
    projectContext: string | null,
    options: WorkflowOptions,
    phaseOptions: PhaseOptions = {},
  ): Promise<StoredAnalysis[] | null> {
    await this.assertPhaseReady(["CLAUDE", "CODEX"]);
    const analysisPrompt = replace(phaseOptions.template ?? analysisTemplate, {
      TITLE: task.title,
      TYPE: task.type,
      RISK_LEVEL: task.riskLevel,
      PROJECT_CONTEXT: projectContext ?? "No project context was supplied.",
      PROBLEM_STATEMENT: task.problemStatement,
      ...phaseOptions.extraValues,
    });
    const promptVersion = phaseOptions.promptVersion ?? ANALYSIS_VERSION;
    const existing = phaseOptions.force ? [] : this.db.select().from(taskArtifacts).where(and(
      eq(taskArtifacts.taskId, task.id), eq(taskArtifacts.kind, "ANALYSIS"),
    )).all();
    const analysesByProvider = new Map<AgentProvider, StoredAnalysis>(existing.flatMap((artifact) => artifact.structuredData
      ? [[artifact.provider, { provider: artifact.provider, data: artifact.structuredData as BrainstormAnalysis }] as const]
      : []));
    const missingProviders = (["CLAUDE", "CODEX"] as const).filter((provider) => !analysesByProvider.has(provider));
    const parallel = this.usageBudgets?.assertBatchReady(task.id, missingProviders.length) ?? true;
    const storeRun = (run: AgentRunRecord) => {
      const stored = this.storeAnalysis(task, run);
      if (run.status !== "COMPLETED" || !stored.data) {
        this.fail(task.id, "One or more independent analyses failed or returned invalid structured output.");
        return false;
      }
      analysesByProvider.set(run.provider, stored);
      return true;
    };
    if (parallel) {
      const runs = await Promise.all(missingProviders.map((provider) =>
        this.run(task, repositoryPath, provider, "INDEPENDENT_ANALYSIS", null, promptVersion, analysisPrompt, options)));
      if (runs.some((run) => !storeRun(run))) return null;
    } else {
      for (const provider of missingProviders) {
        const run = await this.run(task, repositoryPath, provider, "INDEPENDENT_ANALYSIS", null, promptVersion, analysisPrompt, options);
        if (!storeRun(run)) return null;
      }
    }
    if (this.isCancelled(task.id)) return null;
    const analyses = (["CLAUDE", "CODEX"] as const).map((provider) => analysesByProvider.get(provider)!);
    this.updateStatus(task.id, "CROSS_REVIEW");
    return analyses;
  }

  private async runCrossReviewPhase(
    task: TaskRecord,
    repositoryPath: string,
    analyses: StoredAnalysis[],
    options: WorkflowOptions,
    phaseOptions: PhaseOptions = {},
  ) {
    await this.assertPhaseReady(["CLAUDE", "CODEX"]);
    const byProvider = new Map(analyses.map((entry) => [entry.provider, entry]));
    const existing = phaseOptions.force ? [] : this.db.select().from(taskArtifacts).where(and(
      eq(taskArtifacts.taskId, task.id), eq(taskArtifacts.kind, "CROSS_REVIEW"),
    )).all();
    const reviewsByProvider = new Map<AgentProvider, StoredReview>(existing.flatMap((artifact) => artifact.structuredData
      ? [[artifact.provider, { provider: artifact.provider, data: artifact.structuredData as CrossReview }] as const]
      : []));
    const missingProviders = (["CLAUDE", "CODEX"] as const).filter((provider) => !reviewsByProvider.has(provider));
    const parallel = this.usageBudgets?.assertBatchReady(task.id, missingProviders.length) ?? true;
    const runReview = (provider: AgentProvider) => {
      const targetProvider = provider === "CLAUDE" ? "CODEX" : "CLAUDE";
      const target = byProvider.get(targetProvider)!;
      const prompt = replace(reviewTemplate, {
        TITLE: task.title,
        PROBLEM_STATEMENT: task.problemStatement,
        TARGET_PROVIDER: targetProvider,
        ANALYSIS: JSON.stringify(target.data, null, 2),
      });
      return this.run(task, repositoryPath, provider, "CROSS_REVIEW", targetProvider, REVIEW_VERSION, prompt, options);
    };
    const storeRun = (run: AgentRunRecord) => {
      const stored = this.storeReview(task, run);
      if (run.status !== "COMPLETED" || !stored.data) {
        this.fail(task.id, "One or more cross-reviews failed or returned invalid structured output.");
        return false;
      }
      reviewsByProvider.set(run.provider, stored);
      return true;
    };
    if (parallel) {
      const runs = await Promise.all(missingProviders.map(runReview));
      if (runs.some((run) => !storeRun(run))) return;
    } else {
      for (const provider of missingProviders) {
        const run = await runReview(provider);
        if (!storeRun(run)) return;
      }
    }
    if (this.isCancelled(task.id)) return;
    const reviews = (["CLAUDE", "CODEX"] as const).map((provider) => reviewsByProvider.get(provider)!);

    const comparison = compare(
      analyses.map((entry) => entry.data!),
      reviews.map((entry) => entry.data!),
    );
    const nextVersion = (this.db.select({ highest: max(taskComparisons.version) }).from(taskComparisons)
      .where(eq(taskComparisons.taskId, task.id)).get()?.highest ?? 0) + 1;
    this.db.insert(taskComparisons).values({
      id: randomUUID(), taskId: task.id, version: nextVersion, content: comparison, generatedAt: new Date().toISOString(),
    }).run();
    this.updateStatus(task.id, "READY");
  }

  /**
   * Human-triggered: once one or more questions are answered, revise the plan with those answers
   * folded in rather than leaving the original analysis looking stale. Unlike `start`/`resume`, this
   * always re-runs both providers (`force: true`) — a READY task already has ANALYSIS/CROSS_REVIEW
   * artifacts from the prior round, and the ordinary phase methods would otherwise treat those as
   * "already done" and skip re-running anyone. Every past `taskComparisons` version stays reachable;
   * this never overwrites one. See routes/tasks.ts's `/revise` route for the human-facing guards
   * (only a READY task, only with at least one answered question) — this method itself stays a
   * silent no-op otherwise, matching `start`/`resume`'s own convention.
   */
  async reviseWithAnswers(taskId: string, options: WorkflowOptions = {}) {
    const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task || task.status !== "READY") return;
    const project = this.db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!project) return this.fail(task.id, "The registered project no longer exists.");
    const resolvedQuestions = this.gatherResolvedQuestionsText(task.id);
    if (!resolvedQuestions) return;

    this.db.update(tasks).set({ planRevisionRound: task.planRevisionRound + 1, updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id)).run();
    this.updateStatus(task.id, "ANALYZING");
    try {
      const analyses = await this.runAnalysisPhase(task, project.repositoryPath, project.projectContext, options, {
        force: true, template: reviseAnalysisTemplate, promptVersion: REVISE_ANALYSIS_VERSION,
        extraValues: { RESOLVED_QUESTIONS: resolvedQuestions },
      });
      if (!analyses) return;
      await this.runCrossReviewPhase(task, project.repositoryPath, analyses, options, { force: true });
    } catch (error) {
      this.handleWorkflowError(task.id, error);
    }
  }

  /** One `Q: ...\nA: ...` block per ANSWERED question, latest response's answer text. Empty string ("nothing to revise with") when no question has been answered yet. */
  private gatherResolvedQuestionsText(taskId: string): string {
    const answered = this.db.select().from(questionDetails).where(and(
      eq(questionDetails.taskId, taskId), eq(questionDetails.status, "ANSWERED"),
    )).all();
    if (!answered.length) return "";
    const blocks = answered.map((detail) => {
      const question = this.db.select({ content: evidenceItems.content }).from(evidenceItems).where(eq(evidenceItems.id, detail.questionId)).get();
      const latestResponse = this.db.select().from(questionResponses).where(eq(questionResponses.questionId, detail.questionId))
        .orderBy(desc(questionResponses.createdAt)).get();
      return `Q: ${question?.content ?? "(question no longer available)"}\nA: ${latestResponse?.answer ?? "(no answer recorded)"}`;
    });
    return blocks.join("\n\n");
  }

  private handleWorkflowError(taskId: string, error: unknown) {
    if (error instanceof UsageCheckpointError || error instanceof UsageBudgetCheckpointError) {
      this.checkpoint(taskId, error.message);
      return;
    }
    this.fail(taskId, error instanceof Error ? error.message : "The brainstorming workflow failed.");
  }

  async cancel(taskId: string) {
    const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task || !["ANALYZING", "CROSS_REVIEW", "CHECKPOINTED"].includes(task.status)) return false;
    const runs = this.db.select().from(agentRuns).where(and(
      eq(agentRuns.taskId, taskId),
      inArray(agentRuns.status, ["QUEUED", "RUNNING"]),
    )).all();
    await Promise.all(runs.map((run) => this.manager.cancel(run.id, this.adapters.get(run.provider)!)));
    this.updateStatus(taskId, "CANCELLED");
    return true;
  }

  private async run(
    task: TaskRecord,
    cwd: string,
    provider: AgentProvider,
    role: "INDEPENDENT_ANALYSIS" | "CROSS_REVIEW",
    targetProvider: AgentProvider | null,
    promptVersion: string,
    prompt: string,
    options: WorkflowOptions,
  ) {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new Error(`${provider} adapter is unavailable.`);
    // Recheck usage immediately before every provider process this workflow starts, not only once
    // at the start of the workflow: this call site covers both independent-analysis and
    // cross-review runs for both providers.
    await this.usageSafety?.assertReady(provider, { combined: true });
    this.usageBudgets?.assertReady(task.id);
    const now = new Date().toISOString();
    const requestedModel = options.models?.[provider]?.trim() || "(provider default)";
    const run: AgentRunRecord = {
      id: randomUUID(), projectId: task.projectId, taskId: task.id, worktreeId: null, provider, role, targetProvider,
      prompt, promptVersion, requestedModel, actualModel: null,
      effort: provider === "CLAUDE" ? options.claudeEffort?.trim() || null : null,
      permissionProfile: "READ_ONLY", webAccessPolicy: task.webAccessPolicy,
      webAccessPermitted: task.webAccessPermitted, status: "QUEUED",
      output: "", rawOutput: "", errorOutput: "", errorMessage: null,
      exitCode: null, cliVersion: null, durationMs: null, startedAt: null, completedAt: null,
      createdAt: now, updatedAt: now,
    };
    this.db.insert(agentRuns).values(run).run();
    const input: AgentRunInput = {
      runId: run.id, cwd, prompt, promptVersion, permissionProfile: "READ_ONLY",
      webAccess: {
        policy: task.webAccessPolicy,
        permitted: task.webAccessPermitted,
        decidedAt: task.webAccessDecidedAt,
        decidedBy: "USER",
      },
      outputFormat: "JSONL", timeoutMs: options.timeoutMs ?? 600_000, environment: {},
      model: { requested: requestedModel, effort: run.effort ?? undefined },
    };
    await this.manager.start(run, adapter, input);
    return this.db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()!;
  }

  private storeAnalysis(task: TaskRecord, run: AgentRunRecord) {
    let data: BrainstormAnalysis | null = null;
    let parseError: string | null = null;
    try { data = parseAnalysis(run.output); } catch (error) { parseError = error instanceof Error ? error.message : "Could not parse analysis."; }
    const artifactId = randomUUID();
    this.db.insert(taskArtifacts).values({
      id: artifactId, taskId: task.id, runId: run.id, kind: "ANALYSIS", provider: run.provider,
      targetProvider: null, structuredData: data, rawOutput: run.output, parseError, createdAt: new Date().toISOString(),
    }).run();
    if (data) this.addAnalysisEvidence(task.id, artifactId, run.provider, data);
    return { provider: run.provider, data };
  }

  private storeReview(task: TaskRecord, run: AgentRunRecord) {
    let data: CrossReview | null = null;
    let parseError: string | null = null;
    try { data = parseReview(run.output); } catch (error) { parseError = error instanceof Error ? error.message : "Could not parse review."; }
    this.db.insert(taskArtifacts).values({
      id: randomUUID(), taskId: task.id, runId: run.id, kind: "CROSS_REVIEW", provider: run.provider,
      targetProvider: run.targetProvider, structuredData: data, rawOutput: run.output, parseError, createdAt: new Date().toISOString(),
    }).run();
    return { provider: run.provider, data };
  }

  private addAnalysisEvidence(taskId: string, artifactId: string, provider: AgentProvider, analysis: BrainstormAnalysis) {
    const now = new Date().toISOString();
    const groups: Array<[EvidenceType, string[]]> = [
      ["FACT", analysis.facts], ["ASSUMPTION", analysis.assumptions],
    ];
    for (const [type, values] of groups) {
      for (const content of values) {
        this.db.insert(evidenceItems).values({
          id: randomUUID(), taskId, type, content, sourceProvider: provider,
          sourceArtifactId: artifactId, createdAt: now, updatedAt: now,
        }).run();
      }
    }
    // v2 analyses may raise a plain string (v1 shape, and a v2 model's defensive fallback) or a fully
    // structured question — either way it becomes the same QUESTION evidence item, but a structured
    // one also gets its question_details pre-populated with real suggestions instead of a blank row.
    for (const item of analysis.unknowns) {
      const id = randomUUID();
      this.db.insert(evidenceItems).values({
        id, taskId, type: "QUESTION", content: questionText(item), sourceProvider: provider,
        sourceArtifactId: artifactId, createdAt: now, updatedAt: now,
      }).run();
      ensureQuestionDetails(this.db, id, taskId, typeof item === "string" ? undefined : {
        priority: item.priority, whyItMatters: item.whyItMatters, suggestedAction: item.suggestedAction,
        expectedEvidence: item.expectedEvidence, suggestedAnswers: item.suggestedAnswers, suggestionSource: provider,
      });
    }
  }

  private updateStatus(taskId: string, status: TaskRecord["status"]) {
    this.db.update(tasks).set({ status, errorMessage: null, updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId)).run();
  }

  private fail(taskId: string, message: string) {
    this.db.update(tasks).set({ status: "FAILED", errorMessage: message, updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId)).run();
  }

  /**
   * Pause for a usage-safety checkpoint rather than fail. Whatever analyses/reviews already
   * persisted (via storeAnalysis/storeReview, which run before the next stage starts) remain
   * intact; `resume` picks the workflow back up once a fresh reading or an explicit override
   * clears the checkpoint.
   */
  private checkpoint(taskId: string, message: string) {
    this.db.update(tasks).set({ status: "CHECKPOINTED", errorMessage: message, updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId)).run();
  }

  private isCancelled(taskId: string) {
    return this.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get()?.status === "CANCELLED";
  }
}
