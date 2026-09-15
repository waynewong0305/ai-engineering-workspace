import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, AgentProvider, AgentRunInput } from "@aiew/agents";
import { eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { agentRuns, taskArtifacts, type AgentRunRecord, type ReportSynthesis } from "../db/schema.js";
import { AgentRunManager } from "./agent-run-manager.js";
import { buildBrainstormPlanReport } from "./brainstorm-report.js";
import { extractJson, MAX_ITEM_CHARS, record, strings } from "./structured-output.js";

export const REPORT_SYNTHESIS_VERSION = "report-synthesis:v1";
const promptRoot = fileURLToPath(new URL("../../../../prompts/", import.meta.url));
const synthesisTemplate = readFileSync(`${promptRoot}report-synthesis.md`, "utf8");

function replace(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

function requiredString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new Error("A required field is missing or invalid.");
  return value.trim();
}

function parseSynthesis(text: string): ReportSynthesis {
  const value = record(extractJson(text));
  if (!value) throw new Error("The response does not match report-synthesis:v1.");
  const keyRisks = strings(value.keyRisks);
  if (!keyRisks) throw new Error("keyRisks must be an array of strings.");
  return {
    executiveSummary: requiredString(value.executiveSummary, MAX_ITEM_CHARS),
    keyRisks,
    recommendation: requiredString(value.recommendation, MAX_ITEM_CHARS),
  };
}

/**
 * Human-triggered, single-provider synthesis of the current plan report — never automatic, never
 * folded into the free "Generate report" action. The caller (routes/tasks.ts) checks usage-safety
 * before calling this and fires it with `void` so the HTTP response returns immediately; the result
 * is discovered later the same way any other task artifact is, through the task's own `artifacts`
 * list — no dedicated polling endpoint needed. A parse failure stores `parseError` and no valid
 * synthesis, mirroring BrainstormWorkflow.storeAnalysis/storeReview's existing failure handling —
 * never a fabricated result.
 */
export async function generateReportSynthesis(
  db: WorkspaceDatabase,
  manager: AgentRunManager,
  adapters: Map<AgentProvider, AgentAdapter>,
  taskId: string,
  projectId: string,
  repositoryPath: string,
  provider: AgentProvider,
) {
  const report = buildBrainstormPlanReport(db, taskId);
  const adapter = adapters.get(provider);
  if (!report || !adapter) return;

  const analysisSummaries = report.analyses
    .map((entry) => `${entry.provider}: ${entry.data?.summary ?? "(could not be parsed)"}${entry.data?.recommendation ? ` Recommendation: ${entry.data.recommendation}` : ""}`)
    .join("\n\n") || "None available.";
  const questionCounts = `${report.evidence.questions.open.length} open, ${report.evidence.questions.answered.length} answered, `
    + `${report.evidence.questions.deferred.length} deferred, ${report.evidence.questions.notApplicable.length} not applicable, `
    + `${report.evidence.questions.duplicateGroups.length} duplicate group(s)`;
  const prompt = replace(synthesisTemplate, {
    TITLE: report.taskTitle,
    PROBLEM_STATEMENT: report.problemStatement,
    ANALYSIS_SUMMARIES: analysisSummaries,
    COMPARISON_JSON: report.comparison ? JSON.stringify(report.comparison, null, 2) : "Not available yet.",
    QUESTION_COUNTS: questionCounts,
  });

  const now = new Date().toISOString();
  const run: AgentRunRecord = {
    id: randomUUID(), projectId, taskId, worktreeId: null, provider,
    role: "REPORT_SYNTHESIS", targetProvider: null, prompt, promptVersion: REPORT_SYNTHESIS_VERSION,
    requestedModel: "(provider default)", actualModel: null, effort: null,
    permissionProfile: "READ_ONLY", webAccessPolicy: "DISABLED", webAccessPermitted: false,
    status: "QUEUED", output: "", rawOutput: "", errorOutput: "", errorMessage: null,
    exitCode: null, cliVersion: null, durationMs: null, startedAt: null, completedAt: null,
    createdAt: now, updatedAt: now,
  };
  db.insert(agentRuns).values(run).run();
  const input: AgentRunInput = {
    runId: run.id, cwd: repositoryPath, prompt, promptVersion: REPORT_SYNTHESIS_VERSION, permissionProfile: "READ_ONLY",
    webAccess: { policy: "DISABLED", permitted: false, decidedAt: now, decidedBy: "SYSTEM" },
    outputFormat: "JSONL", timeoutMs: 300_000, environment: {},
    model: { requested: run.requestedModel },
  };
  await manager.start(run, adapter, input);
  const completed = db.select().from(agentRuns).where(eq(agentRuns.id, run.id)).get()!;

  let structuredData: ReportSynthesis | null = null;
  let parseError: string | null = null;
  if (completed.status === "COMPLETED") {
    try { structuredData = parseSynthesis(completed.output); } catch (error) { parseError = error instanceof Error ? error.message : "Could not parse the synthesis."; }
  } else {
    parseError = completed.errorMessage ?? "The synthesis run did not complete.";
  }
  db.insert(taskArtifacts).values({
    id: randomUUID(), taskId, runId: run.id, kind: "REPORT_SYNTHESIS", provider,
    targetProvider: null, structuredData, rawOutput: completed.output, parseError, createdAt: new Date().toISOString(),
  }).run();
}
