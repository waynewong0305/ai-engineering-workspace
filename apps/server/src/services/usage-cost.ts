import { randomUUID } from "node:crypto";
import { billableUncachedInputTokens, type AgentProvider, type TokenUsage } from "@aiew/agents";
import { and, desc, eq, isNull, lte } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  pricingEntries,
  usageRecords,
  type AgentRunRecord,
  type PricingEntryRecord,
  type UsageCostBreakdown,
  type UsageCostCategory,
} from "../db/schema.js";

export type CostCalculation =
  | { available: true; totalUsd: number; breakdown: UsageCostBreakdown }
  | { available: false; reason: string };

function rounded(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function category(
  categoryName: UsageCostCategory["category"],
  tokens: number | null,
  pricePerMillion: number | null,
): UsageCostCategory | null | string {
  if (tokens === null || tokens === 0) return null;
  if (pricePerMillion === null) return categoryName;
  return {
    category: categoryName,
    tokens,
    pricePerMillion,
    subtotalUsd: rounded((tokens * pricePerMillion) / 1_000_000),
  };
}

export function calculateApiEquivalentCost(
  provider: AgentProvider,
  model: string,
  usage: TokenUsage,
  price: PricingEntryRecord,
): CostCalculation {
  const outputIncludesReasoning = usage.outputTokens !== undefined && usage.reasoningOutputTokens !== undefined;
  const ordinaryOutputTokens = outputIncludesReasoning && price.reasoningPricePerMillion !== null
    ? Math.max(usage.outputTokens! - usage.reasoningOutputTokens!, 0)
    : (usage.outputTokens ?? null);
  const reasoningTokens = price.reasoningPricePerMillion === null ? null : (usage.reasoningOutputTokens ?? null);

  const candidates = [
    category("INPUT", billableUncachedInputTokens(provider, usage), price.inputPricePerMillion),
    category("CACHED_INPUT", usage.cachedInputTokens ?? null, price.cachedInputPricePerMillion),
    category("CACHE_CREATION_INPUT", usage.cacheCreationTokens ?? null, price.cacheCreationInputPricePerMillion),
    category("OUTPUT", ordinaryOutputTokens, price.outputPricePerMillion),
    category("REASONING_OUTPUT", reasoningTokens, price.reasoningPricePerMillion),
  ];
  const missing = candidates.filter((candidate): candidate is string => typeof candidate === "string");
  if (missing.length) {
    return { available: false, reason: `Missing prices for: ${missing.join(", ")}.` };
  }
  const categories = candidates.filter((candidate): candidate is UsageCostCategory => candidate !== null);
  if (!categories.length) return { available: false, reason: "No priced token categories were reported." };
  const totalUsd = rounded(categories.reduce((sum, item) => sum + item.subtotalUsd, 0));
  return {
    available: true,
    totalUsd,
    breakdown: {
      model,
      pricingEntryId: price.id,
      pricingEffectiveFrom: price.effectiveFrom,
      pricingSource: price.source,
      categories,
      totalUsd,
    },
  };
}

export function resolvePricingEntry(
  db: WorkspaceDatabase,
  provider: AgentProvider,
  model: string | null,
  calculatedAt: string,
): PricingEntryRecord | null {
  if (!model || model === "(provider default)") return null;
  return db.select().from(pricingEntries).where(and(
    eq(pricingEntries.provider, provider),
    eq(pricingEntries.model, model),
    lte(pricingEntries.effectiveFrom, calculatedAt),
  )).orderBy(desc(pricingEntries.effectiveFrom)).get() ?? null;
}

export function usageRecordValues(
  db: WorkspaceDatabase,
  run: AgentRunRecord,
  tokenUsage: TokenUsage | null,
  billingMode: "subscription" | "api" | "credits" | "unknown",
  actualModel: string | null,
  createdAt = new Date().toISOString(),
) {
  const model = actualModel ?? (run.requestedModel === "(provider default)" ? null : run.requestedModel);
  const price = tokenUsage ? resolvePricingEntry(db, run.provider, model, createdAt) : null;
  const calculated = tokenUsage && price && model
    ? calculateApiEquivalentCost(run.provider, model, tokenUsage, price)
    : null;
  const cost = calculated?.available === true ? calculated : null;
  const providerReportedCost = tokenUsage?.totalCostUsd;
  return {
    id: randomUUID(),
    runId: run.id,
    taskId: run.taskId,
    projectId: run.projectId,
    provider: run.provider,
    role: run.role,
    modelRequested: run.requestedModel,
    modelActual: actualModel,
    inputTokens: tokenUsage?.inputTokens ?? null,
    cachedInputTokens: tokenUsage?.cachedInputTokens ?? null,
    cacheCreationTokens: tokenUsage?.cacheCreationTokens ?? null,
    outputTokens: tokenUsage?.outputTokens ?? null,
    reasoningOutputTokens: tokenUsage?.reasoningOutputTokens ?? null,
    totalTokens: tokenUsage?.totalTokens ?? null,
    actualCostUsd: billingMode === "api" ? (providerReportedCost ?? null) : null,
    apiEquivalentCostUsd: cost?.totalUsd ?? null,
    pricingEntryId: cost?.breakdown.pricingEntryId ?? null,
    costSource: cost ? "calculated" as const : "unavailable" as const,
    costBreakdown: cost?.breakdown ?? null,
    costCalculatedAt: cost ? createdAt : null,
    billingMode,
    usageSource: tokenUsage ? "provider_reported" as const : "unavailable" as const,
    rawUsageMetadata: tokenUsage ? (tokenUsage as unknown as Record<string, unknown>) : null,
    createdAt,
  };
}

export type CostBackfillReport = {
  scanned: number;
  calculated: number;
  unavailable: number;
};

/** Calculates only records that have never received a cost snapshot; existing totals are immutable. */
export function calculateMissingUsageCosts(db: WorkspaceDatabase): CostBackfillReport {
  const records = db.select().from(usageRecords).where(isNull(usageRecords.costCalculatedAt)).all();
  const report: CostBackfillReport = { scanned: records.length, calculated: 0, unavailable: 0 };
  const calculatedAt = new Date().toISOString();

  for (const record of records) {
    const model = record.modelActual ?? (record.modelRequested === "(provider default)" ? null : record.modelRequested);
    const price = resolvePricingEntry(db, record.provider, model, calculatedAt);
    const usage: TokenUsage = {
      ...(record.inputTokens === null ? {} : { inputTokens: record.inputTokens }),
      ...(record.cachedInputTokens === null ? {} : { cachedInputTokens: record.cachedInputTokens }),
      ...(record.cacheCreationTokens === null ? {} : { cacheCreationTokens: record.cacheCreationTokens }),
      ...(record.outputTokens === null ? {} : { outputTokens: record.outputTokens }),
      ...(record.reasoningOutputTokens === null ? {} : { reasoningOutputTokens: record.reasoningOutputTokens }),
      ...(record.totalTokens === null ? {} : { totalTokens: record.totalTokens }),
    };
    const result = model && price ? calculateApiEquivalentCost(record.provider, model, usage, price) : null;
    if (!result?.available) {
      report.unavailable += 1;
      continue;
    }
    db.update(usageRecords).set({
      apiEquivalentCostUsd: result.totalUsd,
      pricingEntryId: price!.id,
      costSource: "calculated",
      costBreakdown: result.breakdown,
      costCalculatedAt: calculatedAt,
    }).where(eq(usageRecords.id, record.id)).run();
    report.calculated += 1;
  }
  return report;
}
