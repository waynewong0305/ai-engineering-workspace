import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { agentRuns, projects, tasks } from "../db/schema.js";
import {
  UsageBudgetCheckpointError,
  UsageBudgetService,
  UsageCostSettingsService,
  UsageSettingsValidationError,
} from "./usage-settings.js";

const openDatabases: Array<ReturnType<typeof createDatabase>> = [];

function fixture() {
  const database = createDatabase(":memory:");
  openDatabases.push(database);
  const now = "2026-09-14T00:00:00.000Z";
  database.db.insert(projects).values({
    id: "project", name: "Project", repositoryPath: "/tmp/project", defaultBranch: "main",
    currentBranch: "main", worktreeRoot: "/tmp/worktrees", projectContext: null,
    validationCommands: [], gitStatus: "CLEAN", createdAt: now, updatedAt: now,
  }).run();
  database.db.insert(tasks).values({
    id: "task", projectId: "project", title: "Task", problemStatement: "Test budgets", type: "BRAINSTORM",
    status: "DRAFT", riskLevel: "LOW", webAccessPolicy: "DISABLED", webAccessPermitted: false,
    webAccessDecidedAt: now, webAccessDecidedBy: "USER", originAdrId: null, planPhase: null,
    errorMessage: null, createdAt: now, updatedAt: now,
  }).run();
  return database.db;
}

function insertRun(db: ReturnType<typeof fixture>, id: string) {
  const now = "2026-09-14T00:00:00.000Z";
  db.insert(agentRuns).values({
    id, projectId: "project", taskId: "task", worktreeId: null, provider: "CODEX",
    role: "INDEPENDENT_ANALYSIS", targetProvider: null, prompt: "test", promptVersion: "test:v1",
    requestedModel: "test", actualModel: "test", effort: null, permissionProfile: "READ_ONLY",
    webAccessPolicy: "DISABLED", webAccessPermitted: false, status: "COMPLETED", output: "done",
    rawOutput: "", errorOutput: "", errorMessage: null, exitCode: 0, cliVersion: "test",
    durationMs: 1, startedAt: now, completedAt: now, createdAt: now, updatedAt: now,
  }).run();
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.sqlite.close();
});

describe("usage and cost settings", () => {
  it("persists collection preferences and validates configurable presets", () => {
    const service = new UsageCostSettingsService(fixture());
    expect(service.get()).toMatchObject({ trackUsage: true, defaultBudgetPreset: "BALANCED" });

    const updated = service.update({
      trackUsage: false,
      showApiEquivalentCost: false,
      storeRawTelemetry: false,
      defaultBudgetPreset: "ECONOMY",
      budgetPresets: {
        ECONOMY: { maxAgentRuns: 2, maxReviewRounds: 1, warningPercent: 70 },
        BALANCED: { maxAgentRuns: 6, maxReviewRounds: 2, warningPercent: 80 },
        DEEP: { maxAgentRuns: 12, maxReviewRounds: 5, warningPercent: 90 },
      },
    });
    expect(updated).toMatchObject({ trackUsage: false, showApiEquivalentCost: false, defaultBudgetPreset: "ECONOMY" });
    expect(() => service.update({ budgetPresets: { ...updated.budgetPresets, ECONOMY: { maxAgentRuns: 0 } } }))
      .toThrow(UsageSettingsValidationError);
  });
});

describe("task usage budgets", () => {
  it("snapshots presets and does not rewrite existing task budgets when settings change", () => {
    const db = fixture();
    const settings = new UsageCostSettingsService(db);
    const budgets = new UsageBudgetService(db, settings);
    const budget = budgets.getOrCreate("task", "BALANCED");
    expect(budget).toMatchObject({ maxAgentRuns: 8, maxReviewRounds: 3, warningPercent: 80 });

    settings.update({ budgetPresets: {
      ...settings.get().budgetPresets,
      BALANCED: { maxAgentRuns: 20, maxReviewRounds: 8, warningPercent: 60 },
    } });
    expect(budgets.getOrCreate("task")).toMatchObject({ maxAgentRuns: 8, maxReviewRounds: 3, warningPercent: 80 });
  });

  it("checkpoints before the next run and consumes a one-run human allowance exactly once", () => {
    const db = fixture();
    const budgets = new UsageBudgetService(db);
    budgets.set("task", { preset: "CUSTOM", maxAgentRuns: 1, warningPercent: 80 });
    insertRun(db, "run-1");

    expect(budgets.evaluate("task")).toMatchObject({ allowed: false, status: "CHECKPOINT_REQUIRED" });
    expect(() => budgets.assertReady("task")).toThrow(UsageBudgetCheckpointError);
    expect(budgets.detail("task").budget.state).toBe("CHECKPOINTED");

    budgets.decide("task", "CONTINUE_ONE_RUN");
    expect(budgets.assertReady("task")).toMatchObject({ allowed: true, status: "WARNING" });
    expect(budgets.detail("task").budget.continueRunsRemaining).toBe(0);
    expect(() => budgets.assertReady("task")).toThrow(UsageBudgetCheckpointError);
    expect(budgets.detail("task").audit.map((entry) => entry.eventType)).toContain("ACKNOWLEDGEMENT");
  });
});
