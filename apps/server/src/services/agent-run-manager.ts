import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AgentAdapter, AgentEvent, AgentRunInput } from "@aiew/agents";
import { and, asc, eq, notInArray } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { agentRunEvents, agentRuns, type AgentRunEventRecord, type AgentRunRecord } from "../db/schema.js";
import type { UsageSafetyService } from "./usage-safety.js";

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
    case "failed": return { message: event.message, exitCode: event.exitCode };
    default: return {};
  }
}

export class AgentRunManager {
  private readonly emitter = new EventEmitter();
  private readonly cancellationRequested = new Set<string>();
  private readonly sequenceByRun = new Map<string, number>();

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
        this.persistEvent(run.id, event, started);
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
      this.persistEvent(run.id, event, started);
    } finally {
      this.cancellationRequested.delete(run.id);
      this.sequenceByRun.delete(run.id);
    }
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
    } else if (event.type === "failed") {
      this.db.update(agentRuns).set({
        status: "FAILED", errorMessage: event.message, exitCode: event.exitCode,
        durationMs: Date.now() - started, completedAt: event.occurredAt, updatedAt,
      }).where(eq(agentRuns.id, runId)).run();
      this.usageSafety?.recordRateLimitError(current.provider, event.message);
    } else if (event.type === "cancelled") {
      this.db.update(agentRuns).set({
        status: "CANCELLED", durationMs: Date.now() - started, completedAt: event.occurredAt, updatedAt,
      }).where(eq(agentRuns.id, runId)).run();
    }
  }
}
