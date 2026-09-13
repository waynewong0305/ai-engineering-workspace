import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { agentRunEvents, agentRuns, projects, usageRecords } from "../db/schema.js";
import { backfillUsageRecords } from "./usage-backfill.js";

const databases: Array<ReturnType<typeof createDatabase>["sqlite"]> = [];

function databaseWithProject() {
  const { db, sqlite } = createDatabase(":memory:");
  databases.push(sqlite);
  const now = new Date().toISOString();
  const projectId = randomUUID();
  db.insert(projects).values({
    id: projectId, name: "Fixture", repositoryPath: `/tmp/fixture-${projectId}`, defaultBranch: "main",
    currentBranch: "main", worktreeRoot: `/tmp/fixture-${projectId}-worktrees`, projectContext: null,
    validationCommands: [], gitStatus: "CLEAN", createdAt: now, updatedAt: now,
  }).run();
  return { db, projectId, now };
}

function seedRun(db: ReturnType<typeof createDatabase>["db"], projectId: string, now: string, structuredOutputs: unknown[]) {
  const runId = randomUUID();
  db.insert(agentRuns).values({
    id: runId, projectId, taskId: null, worktreeId: null, provider: "CLAUDE", role: "REPOSITORY_EXPLANATION",
    targetProvider: null, prompt: "Explain.", promptVersion: "explain:v1", requestedModel: "(provider default)",
    actualModel: "claude-sonnet-5", effort: null, permissionProfile: "READ_ONLY",
    webAccessPolicy: "DISABLED", webAccessPermitted: false, status: "COMPLETED",
    output: "done", rawOutput: "", errorOutput: "", errorMessage: null, exitCode: 0, cliVersion: "2.1.269",
    durationMs: 100, startedAt: now, completedAt: now, createdAt: now, updatedAt: now,
  }).run();
  structuredOutputs.forEach((value, index) => {
    db.insert(agentRunEvents).values({
      id: randomUUID(), runId, sequence: index + 1, type: "structured_output",
      payload: { value }, occurredAt: now,
    }).run();
  });
  return runId;
}

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
});

describe("backfillUsageRecords", () => {
  it("recovers exact usage from a historical run's already-stored raw events", () => {
    const { db, projectId, now } = databaseWithProject();
    const runId = seedRun(db, projectId, now, [
      { type: "system", subtype: "init" },
      { type: "result", usage: { input_tokens: 10, output_tokens: 20 } },
    ]);

    const report = backfillUsageRecords(db);
    expect(report).toEqual({ scanned: 1, exact: 1, unavailable: 0, backfilled: 1 });

    const record = db.select().from(usageRecords).all().find((row) => row.runId === runId);
    expect(record).toMatchObject({ runId, usageSource: "provider_reported", inputTokens: 10, outputTokens: 20 });
  });

  it("marks a run unavailable when nothing recoverable is stored, but still backfills exactly one row", () => {
    const { db, projectId, now } = databaseWithProject();
    const runId = seedRun(db, projectId, now, [{ type: "assistant", message: { content: [] } }]);

    const report = backfillUsageRecords(db);
    expect(report).toEqual({ scanned: 1, exact: 0, unavailable: 1, backfilled: 1 });
    const record = db.select().from(usageRecords).all().find((row) => row.runId === runId);
    expect(record).toMatchObject({ usageSource: "unavailable", inputTokens: null });
  });

  it("never reprocesses a run that already has a usage record", () => {
    const { db, projectId, now } = databaseWithProject();
    seedRun(db, projectId, now, [{ type: "result", usage: { input_tokens: 1, output_tokens: 1 } }]);

    const first = backfillUsageRecords(db);
    expect(first.backfilled).toBe(1);
    const second = backfillUsageRecords(db);
    expect(second).toEqual({ scanned: 0, exact: 0, unavailable: 0, backfilled: 0 });
    expect(db.select().from(usageRecords).all()).toHaveLength(1);
  });
});
