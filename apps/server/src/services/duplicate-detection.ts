import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentProvider, AgentRunInput } from "@aiew/agents";
import { asc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns, evidenceItems, questionDetails, taskArtifacts, type AgentRunRecord, type DuplicateSuggestions,
} from "../db/schema.js";
import { AgentRunManager } from "./agent-run-manager.js";
import { extractJson, record } from "./structured-output.js";

export const DUPLICATE_DETECTION_VERSION = "duplicate-detection:v1";
const promptRoot = fileURLToPath(new URL("../../../../prompts/", import.meta.url));
const duplicateDetectionTemplate = readFileSync(`${promptRoot}duplicate-detection.md`, "utf8");

function replace(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

/**
 * Every ordinal the model mentions (as canonical or duplicate, across every group) must be one of
 * the ordinals it was actually given, and no ordinal may appear more than once across all groups —
 * a question can't be simultaneously canonical in one group and a duplicate in another. A violation
 * fails the whole response rather than silently dropping or reinterpreting a group.
 */
function parseDuplicateSuggestions(text: string, ordinalToId: Map<number, string>): DuplicateSuggestions {
  const value = record(extractJson(text));
  if (!value || !Array.isArray(value.groups)) throw new Error("The response does not match duplicate-detection:v1.");
  const usedOrdinals = new Set<number>();
  const groups: DuplicateSuggestions["groups"] = [];
  for (const candidate of value.groups) {
    const group = record(candidate);
    const canonicalOrdinal = group?.canonicalOrdinal;
    const duplicateOrdinals = group?.duplicateOrdinals;
    if (typeof canonicalOrdinal !== "number" || !ordinalToId.has(canonicalOrdinal)) {
      throw new Error("A group references an invalid or missing canonical ordinal.");
    }
    if (
      !Array.isArray(duplicateOrdinals) || !duplicateOrdinals.length
      || duplicateOrdinals.some((ordinal) => typeof ordinal !== "number" || !ordinalToId.has(ordinal) || ordinal === canonicalOrdinal)
    ) {
      throw new Error("A group references invalid, missing, or self-referential duplicate ordinals.");
    }
    const allOrdinals: number[] = [canonicalOrdinal, ...duplicateOrdinals];
    if (allOrdinals.some((ordinal) => usedOrdinals.has(ordinal))) throw new Error("An ordinal appears in more than one group.");
    for (const ordinal of allOrdinals) usedOrdinals.add(ordinal);
    groups.push({
      canonicalQuestionId: ordinalToId.get(canonicalOrdinal)!,
      duplicateQuestionIds: duplicateOrdinals.map((ordinal: number) => ordinalToId.get(ordinal)!),
    });
  }
  return { groups };
}

/**
 * Human-triggered, single-provider AI-judged scan for OPEN questions asking substantively the same
 * thing — a suggestion only, never applied automatically (unlike the free exact-match grouping in
 * routes/questions.ts). Modeled on report-synthesis.ts's shape: one AgentRunManager-managed call,
 * parsed and stored as a taskArtifacts row (or a parseError, never a fabricated result); confirming a
 * suggested group still goes through the normal confirm-duplicate route, one pair at a time.
 */
export async function generateDuplicateSuggestions(
  db: WorkspaceDatabase,
  manager: AgentRunManager,
  adapters: Map<AgentProvider, AgentAdapter>,
  taskId: string,
  projectId: string,
  repositoryPath: string,
  provider: AgentProvider,
) {
  const adapter = adapters.get(provider);
  if (!adapter) return;
  const openQuestions = db.select().from(evidenceItems).where(eq(evidenceItems.taskId, taskId)).orderBy(asc(evidenceItems.createdAt)).all()
    .filter((item) => item.type === "QUESTION")
    .flatMap((item) => {
      const detail = db.select().from(questionDetails).where(eq(questionDetails.questionId, item.id)).get();
      return detail?.status === "OPEN" ? [item] : [];
    });
  if (openQuestions.length < 2) return;

  const ordinalToId = new Map<number, string>();
  const lines = openQuestions.map((item, index) => {
    const ordinal = index + 1;
    ordinalToId.set(ordinal, item.id);
    return `${ordinal}. ${item.content}`;
  }).join("\n");
  const prompt = replace(duplicateDetectionTemplate, { QUESTIONS: lines });

  const now = new Date().toISOString();
  const run: AgentRunRecord = {
    id: randomUUID(), projectId, taskId, worktreeId: null, provider,
    role: "DUPLICATE_DETECTION", targetProvider: null, prompt, promptVersion: DUPLICATE_DETECTION_VERSION,
    requestedModel: "(provider default)", actualModel: null, effort: null,
    permissionProfile: "READ_ONLY", webAccessPolicy: "DISABLED", webAccessPermitted: false,
    status: "QUEUED", output: "", rawOutput: "", errorOutput: "", errorMessage: null,
    exitCode: null, cliVersion: null, durationMs: null, startedAt: null, completedAt: null,
    createdAt: now, updatedAt: now,
  };
  db.insert(agentRuns).values(run).run();
  const input: AgentRunInput = {
    runId: run.id, cwd: repositoryPath, prompt, promptVersion: DUPLICATE_DETECTION_VERSION, permissionProfile: "READ_ONLY",
    webAccess: { policy: "DISABLED", permitted: false, decidedAt: now, decidedBy: "SYSTEM" },
    outputFormat: "JSONL", timeoutMs: 300_000, environment: {},
    model: { requested: run.requestedModel },
  };
  await manager.start(run, adapter, input);
  const completed = db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()!;

  let structuredData: DuplicateSuggestions | null = null;
  let parseError: string | null = null;
  if (completed.status === "COMPLETED") {
    try { structuredData = parseDuplicateSuggestions(completed.output, ordinalToId); } catch (error) {
      parseError = error instanceof Error ? error.message : "Could not parse the duplicate suggestions.";
    }
  } else {
    parseError = completed.errorMessage ?? "The duplicate-detection run did not complete.";
  }
  db.insert(taskArtifacts).values({
    id: randomUUID(), taskId, runId: run.id, kind: "DUPLICATE_SUGGESTIONS", provider,
    targetProvider: null, structuredData, rawOutput: completed.output, parseError, createdAt: new Date().toISOString(),
  }).run();
}
