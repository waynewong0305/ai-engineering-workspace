import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { agentRuns, pricingEntries, projects, usageRecords, type PricingEntryRecord } from "../db/schema.js";
import {
  calculateApiEquivalentCost,
  calculateMissingUsageCosts,
  resolvePricingEntry,
  usageRecordValues,
} from "./usage-cost.js";

const databases: Array<ReturnType<typeof createDatabase>["sqlite"]> = [];

function price(overrides: Partial<PricingEntryRecord> = {}): PricingEntryRecord {
  return {
    id: randomUUID(), provider: "CLAUDE", model: "model-v1",
    inputPricePerMillion: 3, cachedInputPricePerMillion: 0.3,
    cacheCreationInputPricePerMillion: 3.75, outputPricePerMillion: 15,
    reasoningPricePerMillion: 20, effectiveFrom: "2026-01-01T00:00:00.000Z",
    source: "Fixture pricing", createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function databaseWithRun() {
  const { db, sqlite } = createDatabase(":memory:");
  databases.push(sqlite);
  const now = "2026-06-01T00:00:00.000Z";
  const projectId = randomUUID();
  db.insert(projects).values({
    id: projectId, name: "Fixture", repositoryPath: `/tmp/${projectId}`, defaultBranch: "main",
    currentBranch: "main", worktreeRoot: `/tmp/${projectId}-worktrees`, projectContext: null,
    validationCommands: [], gitStatus: "CLEAN", createdAt: now, updatedAt: now,
  }).run();
  const run = {
    id: randomUUID(), projectId, taskId: null, worktreeId: null,
    provider: "CLAUDE" as const, role: "REPOSITORY_EXPLANATION" as const,
    targetProvider: null, prompt: "Explain", promptVersion: "test:v1", requestedModel: "model-v1",
    actualModel: "model-v1", effort: null, permissionProfile: "READ_ONLY" as const,
    webAccessPolicy: "DISABLED" as const, webAccessPermitted: false,
    status: "COMPLETED" as const, output: "", rawOutput: "", errorOutput: "", errorMessage: null,
    exitCode: 0, cliVersion: "test", durationMs: 1, startedAt: now, completedAt: now,
    createdAt: now, updatedAt: now,
  };
  db.insert(agentRuns).values(run).run();
  return { db, run, now };
}

afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe("calculateApiEquivalentCost", () => {
  it("calculates and exposes every separately priced Claude category", () => {
    const result = calculateApiEquivalentCost("CLAUDE", "model-v1", {
      inputTokens: 1_000_000,
      cachedInputTokens: 200_000,
      cacheCreationTokens: 100_000,
      outputTokens: 500_000,
      reasoningOutputTokens: 100_000,
    }, price());

    expect(result).toMatchObject({ available: true, totalUsd: 11.435 });
    if (!result.available) throw new Error(result.reason);
    expect(result.breakdown.categories).toEqual([
      { category: "INPUT", tokens: 1_000_000, pricePerMillion: 3, subtotalUsd: 3 },
      { category: "CACHED_INPUT", tokens: 200_000, pricePerMillion: 0.3, subtotalUsd: 0.06 },
      { category: "CACHE_CREATION_INPUT", tokens: 100_000, pricePerMillion: 3.75, subtotalUsd: 0.375 },
      { category: "OUTPUT", tokens: 400_000, pricePerMillion: 15, subtotalUsd: 6 },
      { category: "REASONING_OUTPUT", tokens: 100_000, pricePerMillion: 20, subtotalUsd: 2 },
    ]);
  });

  it("does not double-charge Codex cached input, which is included in its input counter", () => {
    const result = calculateApiEquivalentCost("CODEX", "model-v1", {
      inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 200_000,
    }, price({ provider: "CODEX", inputPricePerMillion: 2, cachedInputPricePerMillion: 0.5, outputPricePerMillion: 8, reasoningPricePerMillion: null }));

    expect(result).toMatchObject({ available: true, totalUsd: 3 });
    if (!result.available) throw new Error(result.reason);
    expect(result.breakdown.categories[0]).toMatchObject({ category: "INPUT", tokens: 600_000, subtotalUsd: 1.2 });
  });

  it("returns unavailable instead of a partial total when a reported category has no price", () => {
    expect(calculateApiEquivalentCost("CLAUDE", "model-v1", {
      inputTokens: 10, cachedInputTokens: 10, outputTokens: 10,
    }, price({ cachedInputPricePerMillion: null }))).toEqual({
      available: false,
      reason: "Missing prices for: CACHED_INPUT.",
    });
  });
});

describe("pricing persistence", () => {
  it("selects the latest effective version and leaves an existing cost snapshot unchanged", () => {
    const { db, run, now } = databaseWithRun();
    const oldPrice = price();
    const newPrice = price({ id: randomUUID(), inputPricePerMillion: 6, effectiveFrom: "2026-05-01T00:00:00.000Z" });
    db.insert(pricingEntries).values([oldPrice, newPrice]).run();

    expect(resolvePricingEntry(db, "CLAUDE", "model-v1", now)?.id).toBe(newPrice.id);
    const values = usageRecordValues(db, run, { inputTokens: 1_000_000 }, "subscription", run.actualModel, now);
    db.insert(usageRecords).values(values).run();
    expect(values).toMatchObject({ apiEquivalentCostUsd: 6, pricingEntryId: newPrice.id, costSource: "calculated" });

    db.insert(pricingEntries).values(price({
      id: randomUUID(), inputPricePerMillion: 99, effectiveFrom: "2026-05-15T00:00:00.000Z",
    })).run();
    expect(calculateMissingUsageCosts(db)).toEqual({ scanned: 0, calculated: 0, unavailable: 0 });
    expect(db.select().from(usageRecords).get()).toMatchObject({ apiEquivalentCostUsd: 6, pricingEntryId: newPrice.id });
  });

  it("calculates an unpriced historical record once a matching price exists", () => {
    const { db, run, now } = databaseWithRun();
    db.insert(usageRecords).values(usageRecordValues(db, run, { inputTokens: 500_000, outputTokens: 100_000 }, "unknown", run.actualModel, now)).run();
    expect(db.select().from(usageRecords).get()?.costSource).toBe("unavailable");

    const entry = price({ effectiveFrom: "2026-01-01T00:00:00.000Z" });
    db.insert(pricingEntries).values(entry).run();
    expect(calculateMissingUsageCosts(db)).toEqual({ scanned: 1, calculated: 1, unavailable: 0 });
    expect(db.select().from(usageRecords).get()).toMatchObject({
      apiEquivalentCostUsd: 3,
      pricingEntryId: entry.id,
      costSource: "calculated",
    });
  });

  it("stores provider-reported cost as actual only when API billing is known", () => {
    const { db, run, now } = databaseWithRun();
    const tokenUsage = { inputTokens: 1, totalCostUsd: 1.25 };
    expect(usageRecordValues(db, run, tokenUsage, "subscription", run.actualModel, now).actualCostUsd).toBeNull();
    expect(usageRecordValues(db, run, tokenUsage, "api", run.actualModel, now).actualCostUsd).toBe(1.25);
  });
});
