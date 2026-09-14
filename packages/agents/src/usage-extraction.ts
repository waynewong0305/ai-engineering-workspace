import type { AgentProvider } from "./types.js";

export type RateLimitWindowReading = {
  windowId: string;
  windowLabel: string;
  windowDurationMs?: number | null;
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

/**
 * Normalizes the installed CLIs' different input-counter semantics for pricing. Claude's
 * `input_tokens` excludes its separately reported cache reads/writes; Codex's `input_tokens`
 * includes its cached input and cache-write counters.
 */
export function billableUncachedInputTokens(provider: AgentProvider, usage: TokenUsage): number | null {
  if (usage.inputTokens === undefined) return null;
  if (provider === "CLAUDE") return usage.inputTokens;
  return Math.max(
    usage.inputTokens - (usage.cachedInputTokens ?? 0) - (usage.cacheCreationTokens ?? 0),
    0,
  );
}

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
 * Confirmed against a real `codex exec --json` completion (0.154.0): its `turn.completed` event
 * carries `usage` directly at the top level — `{ input_tokens, cached_input_tokens,
 * cache_write_input_tokens, output_tokens, reasoning_output_tokens }`, no wrapper. Real Codex
 * *session-log* telemetry (`~/.codex/sessions/**`, the interactive/desktop-app format) additionally
 * nests an equivalent shape under a `payload` key and separately reports a `rate_limits` object —
 * but a live `codex exec --json` run producing the same simple prompt emitted no such rate-limit
 * event at all: `exec` mode's non-interactive, single-turn `usage_records`-equivalent stream simply
 * doesn't surface plan-usage percentages (also checked `codex doctor --json` — no rate-limit/usage
 * check exists there either). So `extractRateLimitReadings("CODEX", ...)` below will reliably
 * return `[]` for anything this app actually invokes today; it stays shape-based (rather than
 * deleted) in case a future CLI version starts including it in `exec`'s stream, and stays tolerant
 * of the session-log wrapper shape too, since both are harmless to check for.
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
