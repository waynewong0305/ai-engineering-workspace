import { describe, expect, it } from "vitest";
import { extractRateLimitReadings, extractTokenUsage } from "./usage-extraction.js";

// Real shapes captured from the installed CLIs during Phase 8 Step 0 investigation (2026-09-13):
// Claude 2.1.269's actual `--output-format stream-json` output, and Codex 0.154.0's real local
// session logs (~/.codex/sessions). Codex's exact `codex exec --json` wrapping is not yet
// separately confirmed — see usage-extraction.ts's findCodexShaped doc comment.
const CLAUDE_RATE_LIMIT_EVENT = {
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    unifiedWindows: {
      five_hour: { utilization: 0.62, resetsAt: 1789322400 },
      seven_day: { utilization: 0.33, resetsAt: 1789581600 },
    },
  },
};

const CLAUDE_RESULT_EVENT = {
  type: "result",
  subtype: "success",
  total_cost_usd: 0.187368,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 45521,
    cache_read_input_tokens: 0,
    output_tokens: 528,
    output_tokens_details: { thinking_tokens: 514 },
  },
  result: "USAGE_TEST_OK",
};

const CODEX_TOKEN_COUNT_EVENT = {
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: { input_tokens: 29496, cached_input_tokens: 18944, output_tokens: 97, total_tokens: 29593 },
      last_token_usage: { input_tokens: 29496, cached_input_tokens: 18944, output_tokens: 97, total_tokens: 29593 },
      model_context_window: 258400,
    },
    rate_limits: {
      limit_id: "codex",
      primary: { used_percent: 25.0, window_minutes: 300, resets_at: 1788862031 },
      secondary: { used_percent: 4.0, window_minutes: 10_080, resets_at: 1789448831 },
      plan_type: "plus",
    },
  },
};

const CODEX_TOKEN_USAGE_RECORD = {
  type: "token_usage_record",
  payload: {
    thread_id: "01a07fb8-f3f7-7412-bfcc-7940539391a9",
    usage: {
      input_tokens: 29496,
      cached_input_tokens: 18944,
      cache_write_input_tokens: 0,
      output_tokens: 97,
      reasoning_output_tokens: 0,
      total_tokens: 29593,
    },
    turn_token_usage: { input_tokens: 63721, cached_input_tokens: 48256, cache_write_input_tokens: 0, output_tokens: 201, reasoning_output_tokens: 0, total_tokens: 63922 },
    thread_token_usage: { input_tokens: 63721, cached_input_tokens: 48256, cache_write_input_tokens: 0, output_tokens: 201, reasoning_output_tokens: 0, total_tokens: 63922 },
  },
};

describe("extractRateLimitReadings", () => {
  it("extracts both windows from a real Claude rate_limit_event", () => {
    expect(extractRateLimitReadings("CLAUDE", CLAUDE_RATE_LIMIT_EVENT)).toEqual([
      { windowId: "5H", windowLabel: "5-hour usage window", usedPercent: 62, resetAt: new Date(1789322400 * 1000).toISOString() },
      { windowId: "WEEKLY", windowLabel: "weekly usage window", usedPercent: 33, resetAt: new Date(1789581600 * 1000).toISOString() },
    ]);
  });

  it("returns nothing for a Claude event that isn't a rate_limit_event", () => {
    expect(extractRateLimitReadings("CLAUDE", CLAUDE_RESULT_EVENT)).toEqual([]);
  });

  it("extracts both windows from a real Codex token_count event", () => {
    expect(extractRateLimitReadings("CODEX", CODEX_TOKEN_COUNT_EVENT)).toEqual([
      { windowId: "5H", windowLabel: "5-hour usage window", usedPercent: 25, resetAt: new Date(1788862031 * 1000).toISOString() },
      { windowId: "WEEKLY", windowLabel: "weekly usage window", usedPercent: 4, resetAt: new Date(1789448831 * 1000).toISOString() },
    ]);
  });

  it("returns nothing for a Codex event with no rate_limits", () => {
    expect(extractRateLimitReadings("CODEX", CODEX_TOKEN_USAGE_RECORD)).toEqual([]);
  });

  it("never throws on garbage input", () => {
    expect(extractRateLimitReadings("CLAUDE", null)).toEqual([]);
    expect(extractRateLimitReadings("CLAUDE", "not an object")).toEqual([]);
    expect(extractRateLimitReadings("CODEX", { rate_limit_info: {} })).toEqual([]);
    expect(extractRateLimitReadings("CODEX", {})).toEqual([]);
  });

  it("ignores a window whose duration doesn't match the expected 5-hour/weekly mapping", () => {
    const oddWindow = { rate_limits: { primary: { used_percent: 10, window_minutes: 60, resets_at: 1 } } };
    expect(extractRateLimitReadings("CODEX", oddWindow)).toEqual([]);
  });
});

describe("extractTokenUsage", () => {
  it("extracts every reported field from a real Claude result event, including cost", () => {
    expect(extractTokenUsage("CLAUDE", CLAUDE_RESULT_EVENT)).toEqual({
      inputTokens: 2,
      cachedInputTokens: 0,
      cacheCreationTokens: 45521,
      outputTokens: 528,
      reasoningOutputTokens: 514,
      totalCostUsd: 0.187368,
    });
  });

  it("returns null for a Claude event that isn't a result event", () => {
    expect(extractTokenUsage("CLAUDE", CLAUDE_RATE_LIMIT_EVENT)).toBeNull();
  });

  it("extracts every reported field from a real Codex token_usage_record event", () => {
    expect(extractTokenUsage("CODEX", CODEX_TOKEN_USAGE_RECORD)).toEqual({
      inputTokens: 29496,
      cachedInputTokens: 18944,
      cacheCreationTokens: 0,
      outputTokens: 97,
      reasoningOutputTokens: 0,
      totalTokens: 29593,
    });
  });

  it("returns null for a Codex event with no usage object", () => {
    expect(extractTokenUsage("CODEX", { payload: { type: "task_started" } })).toBeNull();
  });

  it("never derives a field the payload didn't actually report", () => {
    const partial = { type: "result", usage: { input_tokens: 5 } };
    expect(extractTokenUsage("CLAUDE", partial)).toEqual({ inputTokens: 5 });
  });

  it("never throws on garbage input", () => {
    expect(extractTokenUsage("CLAUDE", null)).toBeNull();
    expect(extractTokenUsage("CODEX", "not an object")).toBeNull();
    expect(extractTokenUsage("CODEX", {})).toBeNull();
  });
});
