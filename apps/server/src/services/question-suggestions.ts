import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentProvider, AgentRunInput } from "@aiew/agents";
import { asc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns, evidenceItems, questionDetails, taskArtifacts,
  type AgentRunRecord, type QuestionPriority, type QuestionSuggestion, type QuestionSuggestions,
} from "../db/schema.js";
import { AgentRunManager } from "./agent-run-manager.js";
import { extractJson, MAX_ITEM_CHARS, QUESTION_PRIORITIES, record, strings } from "./structured-output.js";

export const QUESTION_SUGGESTIONS_VERSION = "question-suggestions:v1";
const promptRoot = fileURLToPath(new URL("../../../../prompts/", import.meta.url));
const questionSuggestionsTemplate = readFileSync(`${promptRoot}question-suggestions.md`, "utf8");

function replace(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error("A required field is missing or invalid.");
  return value.trim();
}

function parseOrdinal(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("A question suggestion has an invalid ordinal.");
  return value;
}

/**
 * The model must supply exactly one suggestion for every question it was asked about — no invented
 * extra, no silently skipped question — matching build-review-workflow.ts's assertExactOrdinals
 * strictness for the same "respond to every numbered item" contract.
 */
function assertExactOrdinals(actual: readonly number[], expected: readonly number[]) {
  const actualSet = new Set(actual);
  if (actualSet.size !== actual.length) throw new Error("The response lists the same question more than once.");
  const expectedSet = new Set(expected);
  const missing = expected.filter((ordinal) => !actualSet.has(ordinal));
  const unexpected = actual.filter((ordinal) => !expectedSet.has(ordinal));
  if (missing.length || unexpected.length) {
    throw new Error(
      `The response must cover exactly the questions asked about `
      + `(missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}).`,
    );
  }
}

function parseSuggestion(candidate: unknown, ordinalToId: Map<number, string>): QuestionSuggestion & { ordinal: number } {
  const item = record(candidate);
  if (!item) throw new Error("A question suggestion must be an object.");
  const ordinal = parseOrdinal(item.ordinal);
  if (!ordinalToId.has(ordinal)) throw new Error("A question suggestion references an ordinal that was not asked about.");
  const priority = item.priority;
  if (typeof priority !== "string" || !QUESTION_PRIORITIES.has(priority as QuestionPriority)) {
    throw new Error("A question suggestion has an invalid priority.");
  }
  const expectedEvidence = strings(item.expectedEvidence);
  const suggestedAnswers = strings(item.suggestedAnswers);
  if (!expectedEvidence || !suggestedAnswers) throw new Error("A question suggestion's expectedEvidence/suggestedAnswers must be string arrays.");
  return {
    ordinal,
    questionId: ordinalToId.get(ordinal)!,
    priority: priority as QuestionPriority,
    whyItMatters: requiredString(item.whyItMatters, MAX_ITEM_CHARS),
    suggestedAction: requiredString(item.suggestedAction, MAX_ITEM_CHARS),
    expectedEvidence,
    suggestedAnswers,
  };
}

function parseQuestionSuggestions(text: string, ordinalToId: Map<number, string>): QuestionSuggestions {
  const value = record(extractJson(text));
  if (!value || !Array.isArray(value.suggestions)) throw new Error("The response does not match question-suggestions:v1.");
  const parsed = value.suggestions.map((candidate) => parseSuggestion(candidate, ordinalToId));
  assertExactOrdinals(parsed.map((entry) => entry.ordinal), Array.from(ordinalToId.keys()));
  return { suggestions: parsed.map(({ ordinal: _ordinal, ...suggestion }) => suggestion) };
}

export type GenerateQuestionSuggestionsResult =
  | { ok: true; suggestions: QuestionSuggestion[] }
  | { ok: false; message: string };

/**
 * Human-triggered, single-provider backfill of the six suggestion fields for questions that predate
 * (or otherwise missed) v2 analysis/cross-review — see structured-output.ts's structuredQuestions().
 * Unlike report-synthesis.ts/duplicate-detection.ts, the caller (routes/questions.ts) awaits this
 * directly and returns the parsed preview in the HTTP response instead of firing-and-forgetting a
 * 202: a human must review (and may edit) a suggestion before anything is written to question_details,
 * so there is no useful "discover it later via polling" step here. The taskArtifacts audit row is
 * still persisted unconditionally, so usage is never spent invisibly even if every suggestion is
 * ultimately rejected — mirrors storeAnalysis/storeReview's failure handling: a parse failure stores
 * parseError and no valid suggestions, never a fabricated result.
 */
export async function generateQuestionSuggestions(
  db: WorkspaceDatabase,
  manager: AgentRunManager,
  adapters: Map<AgentProvider, AgentAdapter>,
  taskId: string,
  projectId: string,
  repositoryPath: string,
  provider: AgentProvider,
): Promise<GenerateQuestionSuggestionsResult> {
  const adapter = adapters.get(provider);
  if (!adapter) return { ok: false, message: `${provider} is not available.` };

  const blankQuestions = db.select().from(evidenceItems).where(eq(evidenceItems.taskId, taskId)).orderBy(asc(evidenceItems.createdAt)).all()
    .filter((item) => item.type === "QUESTION")
    .flatMap((item) => {
      const detail = db.select().from(questionDetails).where(eq(questionDetails.questionId, item.id)).get();
      return detail && detail.status === "OPEN" && detail.whyItMatters === null ? [item] : [];
    });
  if (!blankQuestions.length) return { ok: true, suggestions: [] };

  const ordinalToId = new Map<number, string>();
  const lines = blankQuestions.map((item, index) => {
    const ordinal = index + 1;
    ordinalToId.set(ordinal, item.id);
    return `${ordinal}. ${item.content}`;
  }).join("\n");
  const prompt = replace(questionSuggestionsTemplate, { QUESTIONS: lines });

  const now = new Date().toISOString();
  const run: AgentRunRecord = {
    id: randomUUID(), projectId, taskId, worktreeId: null, provider,
    role: "QUESTION_SUGGESTION_GENERATION", targetProvider: null, prompt, promptVersion: QUESTION_SUGGESTIONS_VERSION,
    requestedModel: "(provider default)", actualModel: null, effort: null,
    permissionProfile: "READ_ONLY", webAccessPolicy: "DISABLED", webAccessPermitted: false,
    status: "QUEUED", output: "", rawOutput: "", errorOutput: "", errorMessage: null,
    exitCode: null, cliVersion: null, durationMs: null, startedAt: null, completedAt: null,
    createdAt: now, updatedAt: now,
  };
  db.insert(agentRuns).values(run).run();
  const input: AgentRunInput = {
    runId: run.id, cwd: repositoryPath, prompt, promptVersion: QUESTION_SUGGESTIONS_VERSION, permissionProfile: "READ_ONLY",
    webAccess: { policy: "DISABLED", permitted: false, decidedAt: now, decidedBy: "SYSTEM" },
    outputFormat: "JSONL", timeoutMs: 300_000, environment: {},
    model: { requested: run.requestedModel },
  };
  await manager.start(run, adapter, input);
  const completed = db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()!;

  let structuredData: QuestionSuggestions | null = null;
  let parseError: string | null = null;
  if (completed.status === "COMPLETED") {
    try { structuredData = parseQuestionSuggestions(completed.output, ordinalToId); } catch (error) {
      parseError = error instanceof Error ? error.message : "Could not parse the question suggestions.";
    }
  } else {
    parseError = completed.errorMessage ?? "The question-suggestion run did not complete.";
  }
  db.insert(taskArtifacts).values({
    id: randomUUID(), taskId, runId: run.id, kind: "QUESTION_SUGGESTIONS", provider,
    targetProvider: null, structuredData, rawOutput: completed.output, parseError, createdAt: new Date().toISOString(),
  }).run();

  return structuredData ? { ok: true, suggestions: structuredData.suggestions } : { ok: false, message: parseError ?? "Could not generate question suggestions." };
}
