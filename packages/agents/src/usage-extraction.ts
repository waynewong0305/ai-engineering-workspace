import type { AgentProvider } from "./types.js";

export type RateLimitWindowReading = {
  windowId: "5H" | "WEEKLY";
  windowLabel: string;
  usedPercent: number;
  resetAt: string | null;
};

export type TokenUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  totalCostUsd?: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch seconds (both CLIs report `resetsAt`/`resets_at` this way) to an ISO string. */
function epochSecondsToIso(value: unknown): string | null {
  const seconds = num(value);
  return seconds === undefined ? null : new Date(seconds * 1000).toISOString();
}

/**
 * Codex's rate-limit/usage payloads were only confirmed against its interactive session-log
 * format (`~/.codex/sessions/**`), not yet against `codex exec --json`'s own event wrapping — its
 * usage limit was exhausted for real during verification, before a successful completion could be
 * inspected directly. This searches for the recognizable data shape at the top level or one level
 * of nesting under a handful of plausible wrapper keys, rather than requiring one exact event
 * envelope, so it tolerates a wrapping difference between the two formats. Tighten this once a
 * real `codex exec --json` completion confirms the exact shape.
 */
function findCodexShaped(value: unknown, key: string): Record<string, unknown> | null {
  const top = record(value);
  if (!top) return null;
  const direct = record(top[key]);
  if (direct) return direct;
  for (const wrapperKey of ["payload", "info", "msg", "message"]) {
    const nested = record(top[wrapperKey]);
    const found = nested && record(nested[key]);
    if (found) return found;
  }
  return null;
}

export function extractRateLimitReadings(provider: AgentProvider, value: unknown): RateLimitWindowReading[] {
  if (provider === "CLAUDE") {
    const event = record(value);
    if (!event || event.type !== "rate_limit_event") return [];
    const windows = record(record(event.rate_limit_info)?.unifiedWindows);
    if (!windows) return [];
    const readings: RateLimitWindowReading[] = [];
    const fiveHour = record(windows.five_hour);
    const fiveHourPercent = num(fiveHour?.utilization);
    if (fiveHourPercent !== undefined) {
      readings.push({ windowId: "5H", windowLabel: "5-hour usage window", usedPercent: fiveHourPercent * 100, resetAt: epochSecondsToIso(fiveHour?.resetsAt) });
    }
    const sevenDay = record(windows.seven_day);
    const sevenDayPercent = num(sevenDay?.utilization);
    if (sevenDayPercent !== undefined) {
      readings.push({ windowId: "WEEKLY", windowLabel: "weekly usage window", usedPercent: sevenDayPercent * 100, resetAt: epochSecondsToIso(sevenDay?.resetsAt) });
    }
    return readings;
  }

  const rateLimits = findCodexShaped(value, "rate_limits");
  if (!rateLimits) return [];
  const readings: RateLimitWindowReading[] = [];
  const primary = record(rateLimits.primary);
  const primaryPercent = num(primary?.used_percent);
  if (primaryPercent !== undefined && primary?.window_minutes === 300) {
    readings.push({ windowId: "5H", windowLabel: "5-hour usage window", usedPercent: primaryPercent, resetAt: epochSecondsToIso(primary?.resets_at) });
  }
  const secondary = record(rateLimits.secondary);
  const secondaryPercent = num(secondary?.used_percent);
  if (secondaryPercent !== undefined && secondary?.window_minutes === 10_080) {
    readings.push({ windowId: "WEEKLY", windowLabel: "weekly usage window", usedPercent: secondaryPercent, resetAt: epochSecondsToIso(secondary?.resets_at) });
  }
  return readings;
}

export function extractTokenUsage(provider: AgentProvider, value: unknown): TokenUsage | null {
  if (provider === "CLAUDE") {
    const event = record(value);
    if (!event || event.type !== "result") return null;
    const usage = record(event.usage);
    if (!usage) return null;
    const details = record(usage.output_tokens_details);
    const result: TokenUsage = {};
    const inputTokens = num(usage.input_tokens);
    if (inputTokens !== undefined) result.inputTokens = inputTokens;
    const cacheReadTokens = num(usage.cache_read_input_tokens);
    if (cacheReadTokens !== undefined) result.cachedInputTokens = cacheReadTokens;
    const cacheCreationTokens = num(usage.cache_creation_input_tokens);
    if (cacheCreationTokens !== undefined) result.cacheCreationTokens = cacheCreationTokens;
    const outputTokens = num(usage.output_tokens);
    if (outputTokens !== undefined) result.outputTokens = outputTokens;
    const reasoningTokens = num(details?.thinking_tokens);
    if (reasoningTokens !== undefined) result.reasoningOutputTokens = reasoningTokens;
    const totalCostUsd = num(event.total_cost_usd);
    if (totalCostUsd !== undefined) result.totalCostUsd = totalCostUsd;
    return Object.keys(result).length ? result : null;
  }

  const usage = findCodexShaped(value, "usage");
  if (!usage) return null;
  const result: TokenUsage = {};
  const inputTokens = num(usage.input_tokens);
  if (inputTokens !== undefined) result.inputTokens = inputTokens;
  const cachedInputTokens = num(usage.cached_input_tokens);
  if (cachedInputTokens !== undefined) result.cachedInputTokens = cachedInputTokens;
  const cacheWriteTokens = num(usage.cache_write_input_tokens);
  if (cacheWriteTokens !== undefined) result.cacheCreationTokens = cacheWriteTokens;
  const outputTokens = num(usage.output_tokens);
  if (outputTokens !== undefined) result.outputTokens = outputTokens;
  const reasoningTokens = num(usage.reasoning_output_tokens);
  if (reasoningTokens !== undefined) result.reasoningOutputTokens = reasoningTokens;
  const totalTokens = num(usage.total_tokens);
  if (totalTokens !== undefined) result.totalTokens = totalTokens;
  return Object.keys(result).length ? result : null;
}
