import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentProvider, AgentRunInput } from "@aiew/agents";
import { and, eq, inArray } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns,
  evidenceItems,
  projects,
  taskArtifacts,
  taskComparisons,
  tasks,
  type AgentRunRecord,
  type BrainstormAnalysis,
  type CrossReview,
  type EvidenceType,
  type TaskComparison,
  type TaskRecord,
} from "../db/schema.js";
import { AgentRunManager } from "./agent-run-manager.js";

const ANALYSIS_VERSION = "brainstorm-analysis:v1";
const REVIEW_VERSION = "cross-review:v1";
const MAX_STRUCTURED_RESPONSE_CHARS = 160_000;
const MAX_LIST_ITEMS = 100;
const MAX_ITEM_CHARS = 5_000;
const promptRoot = fileURLToPath(new URL("../../../../prompts/", import.meta.url));
const analysisTemplate = readFileSync(`${promptRoot}brainstorm-analysis.md`, "utf8");
const reviewTemplate = readFileSync(`${promptRoot}cross-review.md`, "utf8");

type WorkflowOptions = {
  models?: Partial<Record<AgentProvider, string>>;
  claudeEffort?: string;
  timeoutMs?: number;
};

function replace(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(value: unknown): string[] | null {
  if (
    !Array.isArray(value)
    || value.length > MAX_LIST_ITEMS
    || value.some((item) => typeof item !== "string" || item.length > MAX_ITEM_CHARS)
  ) return null;
  return value.map((item) => item.trim()).filter(Boolean);
}

function extractJson(text: string): unknown {
  if (text.length > MAX_STRUCTURED_RESPONSE_CHARS) {
    throw new Error(`The structured response exceeds ${MAX_STRUCTURED_RESPONSE_CHARS.toLocaleString()} characters.`);
  }
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* Try the next candidate. */ }
  }
  throw new Error("The agent did not return a parseable JSON object.");
}

function parseAnalysis(text: string): BrainstormAnalysis {
  const value = record(extractJson(text));
  const summary = typeof value?.summary === "string" ? value.summary.trim() : "";
  const facts = strings(value?.facts);
  const assumptions = strings(value?.assumptions);
  const unknowns = strings(value?.unknowns);
  const experiments = strings(value?.recommendedExperiments);
  if (
    !value || !summary || summary.length > MAX_ITEM_CHARS || !facts || !assumptions || !unknowns || !experiments
    || !Array.isArray(value.options) || value.options.length > 25
  ) {
    throw new Error("The analysis JSON does not match brainstorm-analysis:v1.");
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
  const fields = [
    "agreements", "disagreements", "factualErrors", "unsupportedAssumptions", "missingFailureCases",
    "hiddenOperationalCosts", "migrationRisks", "openQuestions", "missingEvidence", "recommendedExperiments",
  ] as const;
  if (!value || !summary || summary.length > MAX_ITEM_CHARS) throw new Error("The review JSON does not match cross-review:v1.");
  const parsed = Object.fromEntries(fields.map((field) => [field, strings(value[field])])) as Record<typeof fields[number], string[] | null>;
  if (fields.some((field) => !parsed[field])) throw new Error("The review JSON is missing one or more required lists.");
  return { summary, ...parsed } as CrossReview;
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
      ...analyses.flatMap((analysis) => analysis.unknowns),
      ...reviews.flatMap((review) => review.openQuestions),
    ]),
    missingEvidence: unique(reviews.flatMap((review) => review.missingEvidence)),
    recommendedExperiments: unique([
      ...analyses.flatMap((analysis) => analysis.recommendedExperiments),
      ...reviews.flatMap((review) => review.recommendedExperiments),
    ]),
  };
}

export class BrainstormWorkflow {
  constructor(
    private readonly db: WorkspaceDatabase,
    private readonly manager: AgentRunManager,
    private readonly adapters: Map<AgentProvider, AgentAdapter>,
  ) {}

  async start(taskId: string, options: WorkflowOptions = {}) {
    const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task || task.status !== "DRAFT") return;
    const project = this.db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!project) return this.fail(task.id, "The registered project no longer exists.");
    this.updateStatus(task.id, "ANALYZING");

    try {
      const analysisPrompt = replace(analysisTemplate, {
        TITLE: task.title,
        TYPE: task.type,
        RISK_LEVEL: task.riskLevel,
        PROJECT_CONTEXT: project.projectContext ?? "No project context was supplied.",
        PROBLEM_STATEMENT: task.problemStatement,
      });
      const analysisRuns = await Promise.all((["CLAUDE", "CODEX"] as const).map((provider) =>
        this.run(task, project.repositoryPath, provider, "INDEPENDENT_ANALYSIS", null, ANALYSIS_VERSION, analysisPrompt, options),
      ));
      if (this.isCancelled(task.id)) return;
      const analyses = analysisRuns.map((run) => this.storeAnalysis(task, run));
      if (analysisRuns.some((run) => run.status !== "COMPLETED") || analyses.some((entry) => !entry.data)) {
        return this.fail(task.id, "One or more independent analyses failed or returned invalid structured output.");
      }

      this.updateStatus(task.id, "CROSS_REVIEW");
      const byProvider = new Map(analyses.map((entry) => [entry.provider, entry]));
      const reviewRuns = await Promise.all((["CLAUDE", "CODEX"] as const).map((provider) => {
        const targetProvider = provider === "CLAUDE" ? "CODEX" : "CLAUDE";
        const target = byProvider.get(targetProvider)!;
        const prompt = replace(reviewTemplate, {
          TITLE: task.title,
          PROBLEM_STATEMENT: task.problemStatement,
          TARGET_PROVIDER: targetProvider,
          ANALYSIS: JSON.stringify(target.data, null, 2),
        });
        return this.run(task, project.repositoryPath, provider, "CROSS_REVIEW", targetProvider, REVIEW_VERSION, prompt, options);
      }));
      if (this.isCancelled(task.id)) return;
      const reviews = reviewRuns.map((run) => this.storeReview(task, run));
      if (reviewRuns.some((run) => run.status !== "COMPLETED") || reviews.some((entry) => !entry.data)) {
        return this.fail(task.id, "One or more cross-reviews failed or returned invalid structured output.");
      }

      const comparison = compare(
        analyses.map((entry) => entry.data!),
        reviews.map((entry) => entry.data!),
      );
      this.db.insert(taskComparisons).values({ taskId: task.id, content: comparison, generatedAt: new Date().toISOString() }).run();
      this.updateStatus(task.id, "READY");
    } catch (error) {
      this.fail(task.id, error instanceof Error ? error.message : "The brainstorming workflow failed.");
    }
  }

  async cancel(taskId: string) {
    const task = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task || !["ANALYZING", "CROSS_REVIEW"].includes(task.status)) return false;
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
      ["FACT", analysis.facts], ["ASSUMPTION", analysis.assumptions], ["QUESTION", analysis.unknowns],
    ];
    for (const [type, values] of groups) {
      for (const content of values) {
        this.db.insert(evidenceItems).values({
          id: randomUUID(), taskId, type, content, sourceProvider: provider,
          sourceArtifactId: artifactId, createdAt: now, updatedAt: now,
        }).run();
      }
    }
  }

  private updateStatus(taskId: string, status: TaskRecord["status"]) {
    this.db.update(tasks).set({ status, errorMessage: null, updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId)).run();
  }

  private fail(taskId: string, message: string) {
    this.db.update(tasks).set({ status: "FAILED", errorMessage: message, updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId)).run();
  }

  private isCancelled(taskId: string) {
    return this.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get()?.status === "CANCELLED";
  }
}
