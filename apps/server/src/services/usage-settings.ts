import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns,
  taskUsageBudgets,
  tasks,
  usageBudgetAudit,
  usageCostSettings,
  usageRecords,
  type TaskUsageBudgetRecord,
  type UsageBudgetPreset,
  type UsageBudgetPresets,
  type UsageCostSettingsRecord,
} from "../db/schema.js";

export const DEFAULT_BUDGET_PRESETS: UsageBudgetPresets = {
  ECONOMY: { maxAgentRuns: 4, maxReviewRounds: 1, warningPercent: 75 },
  BALANCED: { maxAgentRuns: 8, maxReviewRounds: 3, warningPercent: 80 },
  DEEP: { maxAgentRuns: 16, maxReviewRounds: 5, warningPercent: 85 },
};

export const DEFAULT_USAGE_COST_SETTINGS = {
  trackUsage: true,
  showApiEquivalentCost: true,
  storeRawTelemetry: true,
  defaultBudgetPreset: "BALANCED" as const,
  budgetPresets: DEFAULT_BUDGET_PRESETS,
};

export class UsageSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageSettingsValidationError";
  }
}

function finiteInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new UsageSettingsValidationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new UsageSettingsValidationError(`${label} must be a number between ${minimum} and ${maximum}.`);
  }
  return value;
}

function nullableInteger(value: unknown, label: string, maximum: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  return finiteInteger(value, label, 1, maximum);
}

function nullableMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return finiteNumber(value, "apiEquivalentCostWarningUsd", 0.000001, 1_000_000);
}

function validatePresetLimits(value: unknown, name: string) {
  if (!value || typeof value !== "object") throw new UsageSettingsValidationError(`${name} preset settings are required.`);
  const input = value as Record<string, unknown>;
  return {
    maxAgentRuns: finiteInteger(input.maxAgentRuns, `${name}.maxAgentRuns`, 1, 1_000),
    maxReviewRounds: finiteInteger(input.maxReviewRounds, `${name}.maxReviewRounds`, 1, 10),
    warningPercent: finiteNumber(input.warningPercent, `${name}.warningPercent`, 1, 99),
  };
}

export class UsageCostSettingsService {
  constructor(private readonly db: WorkspaceDatabase) {}

  get(): UsageCostSettingsRecord {
    const existing = this.db.select().from(usageCostSettings).where(eq(usageCostSettings.id, "default")).get();
    if (existing) return existing;
    const created: UsageCostSettingsRecord = {
      id: "default",
      ...DEFAULT_USAGE_COST_SETTINGS,
      updatedAt: new Date().toISOString(),
    };
    this.db.insert(usageCostSettings).values(created).run();
    return created;
  }

  update(input: Record<string, unknown>): UsageCostSettingsRecord {
    const current = this.get();
    const booleanValue = (key: "trackUsage" | "showApiEquivalentCost" | "storeRawTelemetry") => {
      if (input[key] === undefined) return current[key];
      if (typeof input[key] !== "boolean") throw new UsageSettingsValidationError(`${key} must be true or false.`);
      return input[key];
    };
    const defaultPreset = input.defaultBudgetPreset === undefined ? current.defaultBudgetPreset : input.defaultBudgetPreset;
    if (!(["NONE", "ECONOMY", "BALANCED", "DEEP"] as unknown[]).includes(defaultPreset)) {
      throw new UsageSettingsValidationError("defaultBudgetPreset must be NONE, ECONOMY, BALANCED, or DEEP.");
    }
    const presetsInput = input.budgetPresets === undefined ? current.budgetPresets : input.budgetPresets;
    if (!presetsInput || typeof presetsInput !== "object") throw new UsageSettingsValidationError("budgetPresets must be an object.");
    const presets = presetsInput as Record<string, unknown>;
    const next: UsageCostSettingsRecord = {
      id: "default",
      trackUsage: booleanValue("trackUsage"),
      showApiEquivalentCost: booleanValue("showApiEquivalentCost"),
      storeRawTelemetry: booleanValue("storeRawTelemetry"),
      defaultBudgetPreset: defaultPreset as UsageCostSettingsRecord["defaultBudgetPreset"],
      budgetPresets: {
        ECONOMY: validatePresetLimits(presets.ECONOMY, "ECONOMY"),
        BALANCED: validatePresetLimits(presets.BALANCED, "BALANCED"),
        DEEP: validatePresetLimits(presets.DEEP, "DEEP"),
      },
      updatedAt: new Date().toISOString(),
    };
    this.db.update(usageCostSettings).set(next).where(eq(usageCostSettings.id, "default")).run();
    return next;
  }
}

export type UsageBudgetProgress = {
  agentRuns: number;
  totalTokens: number;
  apiEquivalentCostUsd: number;
  unavailableTokenRuns: number;
  unavailableCostRuns: number;
  utilizationPercent: number;
};

export type UsageBudgetDecision = {
  allowed: boolean;
  status: "SAFE" | "WARNING" | "CHECKPOINT_REQUIRED";
  reason: string;
  budget: TaskUsageBudgetRecord;
  progress: UsageBudgetProgress;
};

export class UsageBudgetCheckpointError extends Error {
  constructor(message: string, readonly decision: UsageBudgetDecision) {
    super(message);
    this.name = "UsageBudgetCheckpointError";
  }
}

export class UsageBudgetService {
  constructor(
    private readonly db: WorkspaceDatabase,
    private readonly settings = new UsageCostSettingsService(db),
  ) {}

  private taskExists(taskId: string) {
    return Boolean(this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get());
  }

  getOrCreate(taskId: string, initialPreset?: UsageBudgetPreset): TaskUsageBudgetRecord {
    const existing = this.db.select().from(taskUsageBudgets).where(eq(taskUsageBudgets.taskId, taskId)).get();
    if (existing) return existing;
    if (!this.taskExists(taskId)) throw new UsageSettingsValidationError("Task not found.");
    return this.set(taskId, { preset: initialPreset ?? this.settings.get().defaultBudgetPreset }, false);
  }

  set(taskId: string, input: Record<string, unknown>, audit = true): TaskUsageBudgetRecord {
    if (!this.taskExists(taskId)) throw new UsageSettingsValidationError("Task not found.");
    const preset = input.preset as UsageBudgetPreset;
    if (!(["NONE", "ECONOMY", "BALANCED", "DEEP", "CUSTOM"] as unknown[]).includes(preset)) {
      throw new UsageSettingsValidationError("preset must be NONE, ECONOMY, BALANCED, DEEP, or CUSTOM.");
    }
    const configured = preset === "ECONOMY" || preset === "BALANCED" || preset === "DEEP"
      ? this.settings.get().budgetPresets[preset]
      : null;
    const maxTokens = preset === "CUSTOM" ? nullableInteger(input.maxTokens, "maxTokens", 10_000_000_000) : null;
    const costWarning = preset === "CUSTOM" ? nullableMoney(input.apiEquivalentCostWarningUsd) : null;
    const maxAgentRuns = preset === "CUSTOM"
      ? nullableInteger(input.maxAgentRuns, "maxAgentRuns", 1_000)
      : configured?.maxAgentRuns ?? null;
    const maxReviewRounds = preset === "CUSTOM"
      ? nullableInteger(input.maxReviewRounds, "maxReviewRounds", 10)
      : configured?.maxReviewRounds ?? null;
    if (preset === "CUSTOM" && maxTokens === null && costWarning === null && maxAgentRuns === null && maxReviewRounds === null) {
      throw new UsageSettingsValidationError("A custom budget needs at least one limit.");
    }
    const warningPercent = preset === "CUSTOM"
      ? finiteNumber(input.warningPercent ?? 80, "warningPercent", 1, 99)
      : configured?.warningPercent ?? 80;
    const now = new Date().toISOString();
    const record: TaskUsageBudgetRecord = {
      taskId,
      preset,
      state: "ACTIVE",
      maxTokens,
      apiEquivalentCostWarningUsd: costWarning,
      maxAgentRuns,
      maxReviewRounds,
      warningPercent,
      continueRunsRemaining: 0,
      checkpointReason: null,
      createdAt: this.db.select({ createdAt: taskUsageBudgets.createdAt }).from(taskUsageBudgets).where(eq(taskUsageBudgets.taskId, taskId)).get()?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.insert(taskUsageBudgets).values(record).onConflictDoUpdate({
      target: taskUsageBudgets.taskId,
      set: { ...record, createdAt: undefined },
    }).run();
    if (audit) this.audit(taskId, "BUDGET_UPDATED", "INCREASE_BUDGET", "Task budget was set by the human.", record);
    return this.db.select().from(taskUsageBudgets).where(eq(taskUsageBudgets.taskId, taskId)).get()!;
  }

  progress(taskId: string, budget = this.getOrCreate(taskId)): UsageBudgetProgress {
    const runs = this.db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.taskId, taskId)).all();
    const usage = this.db.select().from(usageRecords).where(eq(usageRecords.taskId, taskId)).all();
    const totalTokens = usage.reduce((sum, row) => sum + (row.totalTokens ?? 0), 0);
    const apiEquivalentCostUsd = usage.reduce((sum, row) => sum + (row.apiEquivalentCostUsd ?? 0), 0);
    const ratios = [
      budget.maxAgentRuns ? runs.length / budget.maxAgentRuns : 0,
      budget.maxTokens ? totalTokens / budget.maxTokens : 0,
      budget.apiEquivalentCostWarningUsd ? apiEquivalentCostUsd / budget.apiEquivalentCostWarningUsd : 0,
    ];
    return {
      agentRuns: runs.length,
      totalTokens,
      apiEquivalentCostUsd,
      unavailableTokenRuns: usage.filter((row) => row.totalTokens === null).length,
      unavailableCostRuns: usage.filter((row) => row.apiEquivalentCostUsd === null).length,
      utilizationPercent: Math.min(100, Math.max(...ratios) * 100),
    };
  }

  detail(taskId: string) {
    const budget = this.getOrCreate(taskId);
    return {
      budget,
      progress: this.progress(taskId, budget),
      audit: this.db.select().from(usageBudgetAudit).where(eq(usageBudgetAudit.taskId, taskId)).orderBy(desc(usageBudgetAudit.createdAt)).all(),
    };
  }

  evaluate(taskId: string): UsageBudgetDecision {
    const budget = this.getOrCreate(taskId);
    const progress = this.progress(taskId, budget);
    if (budget.preset === "NONE") return { allowed: true, status: "SAFE", reason: "This task has no usage budget.", budget, progress };
    if (budget.continueRunsRemaining > 0) {
      return { allowed: true, status: "WARNING", reason: "Proceeding under the human's one-run allowance.", budget, progress };
    }
    if (budget.state === "STOPPED") {
      return { allowed: false, status: "CHECKPOINT_REQUIRED", reason: "This task's budget was stopped by the human. Increase or replace the budget before another model run.", budget, progress };
    }
    const reached: string[] = [];
    if (budget.maxAgentRuns !== null && progress.agentRuns >= budget.maxAgentRuns) reached.push(`${progress.agentRuns}/${budget.maxAgentRuns} agent runs`);
    if (budget.maxTokens !== null && progress.unavailableTokenRuns > 0) reached.push("token usage cannot be verified because one or more runs have unavailable counters");
    else if (budget.maxTokens !== null && progress.totalTokens >= budget.maxTokens) reached.push(`${progress.totalTokens}/${budget.maxTokens} tokens`);
    if (budget.apiEquivalentCostWarningUsd !== null && progress.unavailableCostRuns > 0) reached.push("cost cannot be verified because one or more runs have no matching price");
    else if (budget.apiEquivalentCostWarningUsd !== null && progress.apiEquivalentCostUsd >= budget.apiEquivalentCostWarningUsd) {
      reached.push(`$${progress.apiEquivalentCostUsd.toFixed(4)}/$${budget.apiEquivalentCostWarningUsd.toFixed(4)} API-equivalent cost`);
    }
    if (reached.length) {
      return { allowed: false, status: "CHECKPOINT_REQUIRED", reason: `Task budget checkpoint: ${reached.join("; ")}. Choose Stop & Summarize, Continue One Run, or Increase Budget.`, budget, progress };
    }
    const warning = progress.utilizationPercent >= budget.warningPercent;
    return {
      allowed: true,
      status: warning ? "WARNING" : "SAFE",
      reason: warning ? `Task budget is ${progress.utilizationPercent.toFixed(0)}% utilized.` : "Task budget is within its limits.",
      budget,
      progress,
    };
  }

  assertReady(taskId: string): UsageBudgetDecision {
    const decision = this.evaluate(taskId);
    if (!decision.allowed) {
      this.checkpoint(taskId, decision);
    }
    if (decision.budget.continueRunsRemaining > 0) {
      this.db.update(taskUsageBudgets).set({
        continueRunsRemaining: decision.budget.continueRunsRemaining - 1,
        updatedAt: new Date().toISOString(),
      }).where(eq(taskUsageBudgets.taskId, taskId)).run();
    }
    return decision;
  }

  /**
   * A normal multi-provider phase may start together, but only when its exact run-count ceiling has
   * room for the whole batch. A one-run acknowledgement deliberately returns false so the caller
   * runs serially, persists that one result, and checkpoints before a second call.
   */
  assertBatchReady(taskId: string, runCount: number): boolean {
    const decision = this.evaluate(taskId);
    if (!decision.allowed) this.checkpoint(taskId, decision);
    if (decision.budget.continueRunsRemaining > 0) return false;
    if (decision.budget.maxAgentRuns !== null && decision.progress.agentRuns + runCount > decision.budget.maxAgentRuns) {
      const limited: UsageBudgetDecision = {
        ...decision,
        allowed: false,
        status: "CHECKPOINT_REQUIRED",
        reason: `Task budget checkpoint: starting this ${runCount}-run phase would exceed the ${decision.budget.maxAgentRuns}-run limit. Choose Stop & Summarize, Continue One Run, or Increase Budget.`,
      };
      this.checkpoint(taskId, limited);
    }
    return true;
  }

  private checkpoint(taskId: string, decision: UsageBudgetDecision): never {
    const now = new Date().toISOString();
    this.db.update(taskUsageBudgets).set({ state: "CHECKPOINTED", checkpointReason: decision.reason, updatedAt: now })
      .where(eq(taskUsageBudgets.taskId, taskId)).run();
    const budget = this.db.select().from(taskUsageBudgets).where(eq(taskUsageBudgets.taskId, taskId)).get()!;
    this.audit(taskId, "CHECKPOINT_TRIGGERED", null, decision.reason, budget);
    throw new UsageBudgetCheckpointError(decision.reason, { ...decision, budget });
  }

  decide(taskId: string, action: unknown) {
    const current = this.getOrCreate(taskId);
    if (current.state !== "CHECKPOINTED") {
      throw new UsageSettingsValidationError("A budget decision can only be recorded for a checkpointed task budget.");
    }
    if (action !== "STOP_AND_SUMMARIZE" && action !== "CONTINUE_ONE_RUN") {
      throw new UsageSettingsValidationError("action must be STOP_AND_SUMMARIZE or CONTINUE_ONE_RUN.");
    }
    const next = {
      state: action === "STOP_AND_SUMMARIZE" ? "STOPPED" as const : "ACTIVE" as const,
      continueRunsRemaining: action === "CONTINUE_ONE_RUN" ? 1 : 0,
      checkpointReason: action === "STOP_AND_SUMMARIZE" ? "Stopped by the human; accumulated results remain available." : null,
      updatedAt: new Date().toISOString(),
    };
    this.db.update(taskUsageBudgets).set(next).where(eq(taskUsageBudgets.taskId, taskId)).run();
    const budget = { ...current, ...next };
    this.audit(taskId, "ACKNOWLEDGEMENT", action, action === "STOP_AND_SUMMARIZE"
      ? "The human stopped further model runs and kept the accumulated results."
      : "The human allowed exactly one more model run.", budget);
    return { budget, progress: this.progress(taskId, budget) };
  }

  private audit(
    taskId: string,
    eventType: "CHECKPOINT_TRIGGERED" | "ACKNOWLEDGEMENT" | "BUDGET_UPDATED",
    userAction: "STOP_AND_SUMMARIZE" | "CONTINUE_ONE_RUN" | "INCREASE_BUDGET" | null,
    reason: string,
    budget: TaskUsageBudgetRecord,
  ) {
    this.db.insert(usageBudgetAudit).values({
      id: randomUUID(), taskId, eventType, userAction, reason,
      budgetSnapshot: budget as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    }).run();
  }
}
