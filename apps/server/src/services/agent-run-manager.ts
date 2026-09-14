import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  classifyAgentFailure,
  extractRateLimitReadings,
  extractTokenUsage,
  modelSubstitutionFailure,
  type AgentAdapter,
  type AgentEvent,
  type AgentRunInput,
  type TokenUsage,
} from "@aiew/agents";
import { and, asc, eq, notInArray } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { agentRunEvents, agentRuns, usageRecords, type AgentRunEventRecord, type AgentRunRecord } from "../db/schema.js";
import type { UsageSafetyService } from "./usage-safety.js";
import { usageRecordValues } from "./usage-cost.js";

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;
const MAX_STORED_TEXT = 5 * 1024 * 1024;

function appendBounded(current: string, addition: string) {
  const joined = current + addition;
  return joined.length <= MAX_STORED_TEXT ? joined : joined.slice(joined.length - MAX_STORED_TEXT);
}

function payloadFor(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case "stdout":
    case "stderr": return { chunk: event.chunk };
    case "structured_output": return { value: event.value };
    case "completed": return { exitCode: event.exitCode, metadata: event.metadata };
    case "failed": return {
      message: event.message,
      exitCode: event.exitCode,
      failureKind: event.failureKind,
      actualModel: event.actualModel,
    };
    default: return {};
  }
}

export class AgentRunManager {
  private readonly emitter = new EventEmitter();
  private readonly cancellationRequested = new Set<string>();
  private readonly sequenceByRun = new Map<string, number>();
  private readonly latestTokenUsage = new Map<string, TokenUsage>();
  private readonly sawRateLimitReading = new Set<string>();

  constructor(private readonly db: WorkspaceDatabase, private readonly usageSafety?: UsageSafetyService) {
    this.emitter.setMaxListeners(100);
  }

  listEvents(runId: string): AgentRunEventRecord[] {
    return this.db.select().from(agentRunEvents)
      .where(eq(agentRunEvents.runId, runId))
      .orderBy(asc(agentRunEvents.sequence)).all();
  }

  subscribe(runId: string, listener: (event: AgentRunEventRecord) => void) {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }

  async start(run: AgentRunRecord, adapter: AgentAdapter, input: AgentRunInput): Promise<void> {
    const started = Date.now();
    try {
      for await (const event of adapter.run(input)) {
        if (this.cancellationRequested.has(run.id)) {
          await adapter.cancel(run.id);
          break;
        }
        this.persistEvent(run.id, this.normalizeEvent(run, event), started);
      }
    } catch (error) {
      if (this.cancellationRequested.has(run.id)) return;
      const occurredAt = new Date().toISOString();
      const event: AgentEvent = {
        type: "failed",
        runId: run.id,
        occurredAt,
        message: error instanceof Error ? error.message : "Agent run failed.",
        exitCode: null,
      };
      this.persistEvent(run.id, this.normalizeEvent(run, event), started);
    } finally {
      // A provider may expose account usage separately from run output (Codex App Server). Refresh
      // after every attempted run so the dashboard reflects the quota that the run just consumed.
      await this.usageSafety?.refresh(run.provider);
      this.cancellationRequested.delete(run.id);
      this.sequenceByRun.delete(run.id);
    }
  }

  private normalizeEvent(run: AgentRunRecord, event: AgentEvent): AgentEvent {
    if (event.type === "completed") {
      const substitution = modelSubstitutionFailure(run.provider, run.requestedModel, event.metadata.actualModel);
      if (!substitution) return event;
      return {
        type: "failed",
        runId: run.id,
        occurredAt: event.occurredAt,
        message: substitution.message,
        exitCode: event.exitCode,
        failureKind: substitution.kind,
        actualModel: event.metadata.actualModel,
      };
    }
    if (event.type !== "failed") return event;
    const current = this.db.select({ errorOutput: agentRuns.errorOutput }).from(agentRuns)
      .where(eq(agentRuns.id, run.id)).get();
    const classified = classifyAgentFailure(run.provider, `${event.message}\n${current?.errorOutput ?? ""}`);
    return { ...event, message: classified.message, failureKind: classified.kind };
  }

  async cancel(runId: string, adapter: AgentAdapter): Promise<boolean> {
    const run = this.db.select().from(agentRuns).where(and(
      eq(agentRuns.id, runId),
      notInArray(agentRuns.status, [...TERMINAL_STATUSES]),
    )).get();
    if (!run) return false;
    this.cancellationRequested.add(runId);
    await adapter.cancel(runId);
    const started = run.startedAt ? Date.parse(run.startedAt) : Date.now();
    this.persistEvent(runId, { type: "cancelled", runId, occurredAt: new Date().toISOString() }, started);
    return true;
  }

  private persistEvent(runId: string, event: AgentEvent, started: number) {
    const sequence = (this.sequenceByRun.get(runId) ?? this.listEvents(runId).at(-1)?.sequence ?? 0) + 1;
    this.sequenceByRun.set(runId, sequence);
    const stored = {
      id: randomUUID(), runId, sequence, type: event.type,
      payload: payloadFor(event), occurredAt: event.occurredAt,
    };
    this.db.insert(agentRunEvents).values(stored).run();
    this.applyEvent(runId, event, started);
    this.emitter.emit(runId, stored);
  }

  private applyEvent(runId: string, event: AgentEvent, started: number) {
    const current = this.db.select().from(agentRuns).where(eq(agentRuns.id, runId)).get();
    if (!current) return;
    const updatedAt = event.occurredAt;
    if (event.type === "started") {
      this.db.update(agentRuns).set({ status: "RUNNING", startedAt: event.occurredAt, updatedAt }).where(eq(agentRuns.id, runId)).run();
    } else if (event.type === "stdout") {
      this.db.update(agentRuns).set({ output: appendBounded(current.output, event.chunk), updatedAt }).where(eq(agentRuns.id, runId)).run();
    } else if (event.type === "stderr") {
      this.db.update(agentRuns).set({ errorOutput: appendBounded(current.errorOutput, event.chunk), updatedAt }).where(eq(agentRuns.id, runId)).run();
      this.usageSafety?.recordRateLimitError(current.provider, event.chunk);
    } else if (event.type === "structured_output") {
      this.db.update(agentRuns).set({ rawOutput: appendBounded(current.rawOutput, `${JSON.stringify(event.value)}\n`), updatedAt }).where(eq(agentRuns.id, runId)).run();
      const readings = extractRateLimitReadings(current.provider, event.value);
      if (readings.length) {
        this.sawRateLimitReading.add(runId);
        this.usageSafety?.recordCliReportedUsage(current.provider, readings);
      }
      const tokenUsage = extractTokenUsage(current.provider, event.value);
      if (tokenUsage) this.latestTokenUsage.set(runId, tokenUsage);
    } else if (event.type === "completed") {
      this.db.update(agentRuns).set({
        status: "COMPLETED",
        exitCode: event.exitCode,
        actualModel: event.metadata.actualModel,
        cliVersion: event.metadata.cliVersion,
        durationMs: Date.now() - started,
        completedAt: event.occurredAt,
        updatedAt,
      }).where(eq(agentRuns.id, runId)).run();
      this.recordUsage(runId, current, event.metadata.actualModel);
    } else if (event.type === "failed") {
      const actualModel = event.actualModel === undefined ? current.actualModel : event.actualModel;
      this.db.update(agentRuns).set({
        status: "FAILED", errorMessage: event.message, exitCode: event.exitCode,
        actualModel, durationMs: Date.now() - started, completedAt: event.occurredAt, updatedAt,
      }).where(eq(agentRuns.id, runId)).run();
      this.usageSafety?.recordRateLimitError(current.provider, event.message);
      this.recordUsage(runId, current, actualModel);
    } else if (event.type === "cancelled") {
      this.db.update(agentRuns).set({
        status: "CANCELLED", durationMs: Date.now() - started, completedAt: event.occurredAt, updatedAt,
      }).where(eq(agentRuns.id, runId)).run();
      this.recordUsage(runId, current, current.actualModel);
    }
  }

  /**
   * Phase 8: exactly one `usage_records` row per run, always — `unavailable` when nothing was
   * recoverable, so later aggregation can rely on "one row per run" rather than "sometimes one."
   * `billingMode` is only ever inferred, never guessed at random: a run that surfaced a real
   * rate-limit/plan-usage reading is on a subscription-style plan by definition (API billing has no
   * such concept), so it's marked `subscription`; otherwise `unknown`, never assumed `api`.
   */
  private recordUsage(runId: string, current: AgentRunRecord, actualModel: string | null) {
    const tokenUsage = this.latestTokenUsage.get(runId) ?? null;
    const billingMode = this.sawRateLimitReading.has(runId) ? "subscription" : "unknown";
    this.latestTokenUsage.delete(runId);
    this.sawRateLimitReading.delete(runId);
    this.db.insert(usageRecords).values(usageRecordValues(
      this.db,
      { ...current, id: runId },
      tokenUsage,
      billingMode,
      actualModel,
    )).run();
  }
}
