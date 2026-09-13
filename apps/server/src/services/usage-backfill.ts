import { randomUUID } from "node:crypto";
import { extractTokenUsage } from "@aiew/agents";
import { asc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { agentRunEvents, agentRuns, usageRecords } from "../db/schema.js";

export type UsageBackfillReport = {
  scanned: number;
  exact: number;
  unavailable: number;
  backfilled: number;
};

/**
 * Historical runs already have their raw structured output stored in `agent_run_events` — every
 * `structured_output` event's payload was persisted verbatim from the day this workspace started
 * recording agent runs, long before anything extracted usage from it (see the Phase 8 Step 0
 * investigation record in IMPLEMENTATION_STATUS.md). This walks every run without a usage record
 * yet and derives one retroactively, the same way `AgentRunManager` does for a live run — never
 * estimating a historical token count, only ever recovering what a provider actually reported.
 * Idempotent: a run already backfilled (or captured live since) is never reprocessed.
 */
export function backfillUsageRecords(db: WorkspaceDatabase): UsageBackfillReport {
  const alreadyCaptured = new Set(db.select({ runId: usageRecords.runId }).from(usageRecords).all().map((row) => row.runId));
  const runs = db.select().from(agentRuns).all().filter((run) => !alreadyCaptured.has(run.id));

  const report: UsageBackfillReport = { scanned: runs.length, exact: 0, unavailable: 0, backfilled: 0 };
  const now = new Date().toISOString();

  for (const run of runs) {
    const events = db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, run.id)).orderBy(asc(agentRunEvents.sequence)).all();
    let tokenUsage = null as ReturnType<typeof extractTokenUsage>;
    for (const event of events) {
      if (event.type !== "structured_output") continue;
      const value = (event.payload as { value?: unknown }).value;
      const found = extractTokenUsage(run.provider, value);
      if (found) tokenUsage = found;
    }

    db.insert(usageRecords).values({
      id: randomUUID(), runId: run.id, taskId: run.taskId, projectId: run.projectId,
      provider: run.provider, role: run.role,
      modelRequested: run.requestedModel, modelActual: run.actualModel,
      inputTokens: tokenUsage?.inputTokens ?? null,
      cachedInputTokens: tokenUsage?.cachedInputTokens ?? null,
      cacheCreationTokens: tokenUsage?.cacheCreationTokens ?? null,
      outputTokens: tokenUsage?.outputTokens ?? null,
      reasoningOutputTokens: tokenUsage?.reasoningOutputTokens ?? null,
      totalTokens: tokenUsage?.totalTokens ?? null,
      billingMode: "unknown",
      usageSource: tokenUsage ? "provider_reported" : "unavailable",
      rawUsageMetadata: tokenUsage ? (tokenUsage as unknown as Record<string, unknown>) : null,
      createdAt: now,
    }).run();

    report.backfilled += 1;
    if (tokenUsage) report.exact += 1;
    else report.unavailable += 1;
  }

  return report;
}
