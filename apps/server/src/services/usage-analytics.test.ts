import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { agentRuns, projects, tasks, usageRecords } from "../db/schema.js";
import { buildUsageDashboard, workflowForPrompt } from "./usage-analytics.js";

const databases: Array<ReturnType<typeof createDatabase>["sqlite"]> = [];

function fixture() {
  const { db, sqlite } = createDatabase(":memory:");
  databases.push(sqlite);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const now = "2026-09-14T12:00:00.000Z";
  db.insert(projects).values({
    id: projectId, name: "Fixture", repositoryPath: `/tmp/${projectId}`, defaultBranch: "main",
    currentBranch: "main", worktreeRoot: `/tmp/${projectId}-worktrees`, projectContext: null,
    validationCommands: [], gitStatus: "CLEAN", createdAt: now, updatedAt: now,
  }).run();
  db.insert(tasks).values({
    id: taskId, projectId, title: "Measured task", problemStatement: "Measure it", type: "BRAINSTORM",
    status: "READY", riskLevel: "LOW", webAccessPolicy: "DISABLED", webAccessPermitted: false,
    webAccessDecidedAt: now, webAccessDecidedBy: "USER", originAdrId: null, planPhase: null,
    errorMessage: null, createdAt: now, updatedAt: now,
  }).run();
  return { db, projectId, taskId, now };
}

function seedUsage(
  db: ReturnType<typeof createDatabase>["db"],
  input: {
    projectId: string;
    taskId: string | null;
    provider: "CLAUDE" | "CODEX";
    promptVersion: string;
    createdAt: string;
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
    cost?: number;
    unavailable?: boolean;
    web?: boolean;
  },
) {
  const runId = randomUUID();
  const role = input.promptVersion.startsWith("cross-review") ? "CROSS_REVIEW" : "INDEPENDENT_ANALYSIS";
  db.insert(agentRuns).values({
    id: runId, projectId: input.projectId, taskId: input.taskId, worktreeId: null,
    provider: input.provider, role, targetProvider: null, prompt: "Fixture", promptVersion: input.promptVersion,
    requestedModel: "fixture-model", actualModel: "fixture-model", effort: null,
    permissionProfile: "READ_ONLY", webAccessPolicy: input.web ? "ENABLED_FOR_TASK" : "DISABLED",
    webAccessPermitted: input.web ?? false, status: "COMPLETED", output: "", rawOutput: "",
    errorOutput: "", errorMessage: null, exitCode: 0, cliVersion: "fixture", durationMs: 100,
    startedAt: input.createdAt, completedAt: input.createdAt, createdAt: input.createdAt, updatedAt: input.createdAt,
  }).run();
  db.insert(usageRecords).values({
    id: randomUUID(), runId, taskId: input.taskId, projectId: input.projectId,
    provider: input.provider, role, modelRequested: "fixture-model", modelActual: "fixture-model",
    inputTokens: input.inputTokens ?? null, cachedInputTokens: input.cachedInputTokens ?? null,
    cacheCreationTokens: null, outputTokens: input.outputTokens ?? null, reasoningOutputTokens: null,
    totalTokens: null, actualCostUsd: null, apiEquivalentCostUsd: input.cost ?? null,
    pricingEntryId: null, costSource: input.cost === undefined ? "unavailable" : "calculated",
    costBreakdown: null, costCalculatedAt: input.cost === undefined ? null : input.createdAt,
    billingMode: "unknown", usageSource: input.unavailable ? "unavailable" : "provider_reported",
    rawUsageMetadata: null, createdAt: input.createdAt,
  }).run();
  return runId;
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("buildUsageDashboard", () => {
  it("aggregates exact provider counters without double-counting Codex cache", () => {
    const { db, projectId, taskId } = fixture();
    seedUsage(db, {
      projectId, taskId, provider: "CLAUDE", promptVersion: "brainstorm-analysis:v1",
      createdAt: "2026-09-14T09:00:00.000Z", inputTokens: 100, cachedInputTokens: 50,
      outputTokens: 25, cost: 0.001, web: true,
    });
    seedUsage(db, {
      projectId, taskId, provider: "CODEX", promptVersion: "cross-review:v1",
      createdAt: "2026-09-14T10:00:00.000Z", inputTokens: 200, cachedInputTokens: 100,
      outputTokens: 50, cost: 0.002,
    });
    seedUsage(db, {
      projectId, taskId, provider: "CLAUDE", promptVersion: "brainstorm-analysis:v1",
      createdAt: "2026-09-14T11:00:00.000Z", unavailable: true,
    });

    const result = buildUsageDashboard(db, { period: "today" }, new Date("2026-09-14T12:00:00.000Z"));
    expect(result.summary).toMatchObject({
      runs: 3, totalTokens: 425, exactTokenRuns: 2, unavailableTokenRuns: 1,
      apiEquivalentCostUsd: 0.003, calculatedCostRuns: 2, unavailableCostRuns: 1,
      browserEnabledRuns: 1, averageTokensPerTask: 425,
    });
    expect(result.byProvider).toEqual([
      { key: "CODEX", label: "Codex", runs: 1, tokens: 250, apiEquivalentCostUsd: 0.002, calculatedCostRuns: 1, unavailableCostRuns: 0 },
      { key: "CLAUDE", label: "Claude Code", runs: 2, tokens: 175, apiEquivalentCostUsd: 0.001, calculatedCostRuns: 1, unavailableCostRuns: 1 },
    ]);
    expect(result.byWorkflow.map((row) => [row.key, row.tokens])).toEqual([
      ["CROSS_REVIEW", 250], ["INDEPENDENT_ANALYSIS", 175],
    ]);
    expect(result.efficiency.cacheHitRatio).toBeCloseTo(150 / 350);
    expect(result.highestUsageTasks[0]).toMatchObject({ taskId, label: "Measured task", tokens: 425 });
  });

  it("filters by project, task, and custom date range", () => {
    const { db, projectId, taskId } = fixture();
    seedUsage(db, {
      projectId, taskId, provider: "CLAUDE", promptVersion: "brainstorm-analysis:v1",
      createdAt: "2026-09-01T09:00:00.000Z", inputTokens: 100,
    });
    seedUsage(db, {
      projectId, taskId, provider: "CLAUDE", promptVersion: "brainstorm-analysis:v1",
      createdAt: "2026-09-14T09:00:00.000Z", inputTokens: 200,
    });
    const result = buildUsageDashboard(db, {
      period: "custom", projectId, taskId,
      from: "2026-09-10T00:00:00.000Z", to: "2026-09-15T00:00:00.000Z",
    }, new Date("2026-09-14T12:00:00.000Z"));
    expect(result.summary).toMatchObject({ runs: 1, totalTokens: 200 });
  });
});

describe("workflowForPrompt", () => {
  it("distinguishes initial review, re-review, implementation response, and experiments", () => {
    expect(workflowForPrompt("code-review:v1").key).toBe("CODE_REVIEW");
    expect(workflowForPrompt("code-review-recheck:v1").key).toBe("RE_REVIEW");
    expect(workflowForPrompt("build-response:v1").key).toBe("IMPLEMENTATION_RESPONSE");
    expect(workflowForPrompt("experiment-reviewer:v1").key).toBe("EXPERIMENT");
  });
});
