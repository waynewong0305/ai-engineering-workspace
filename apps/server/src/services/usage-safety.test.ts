import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentProvider, RateLimitWindowReading } from "@aiew/agents";
import { createDatabase } from "../db/database.js";
import { providerUsageReadings } from "../db/schema.js";
import {
  DEFAULT_USAGE_POLICY,
  UsageCheckpointError,
  UsageSafetyService,
  UsageValidationError,
  parseRateLimitMessage,
} from "./usage-safety.js";

const databases: Array<ReturnType<typeof createDatabase>["sqlite"]> = [];

function service(adapters: AgentAdapter[] = []) {
  const { db, sqlite } = createDatabase(":memory:");
  databases.push(sqlite);
  return new UsageSafetyService(db, new Map(adapters.map((adapter) => [adapter.name, adapter])));
}

function adapterWithUsage(
  provider: AgentProvider,
  readings: RateLimitWindowReading[],
  options: { spendsProviderUsageToRead?: boolean } = {},
): AgentAdapter {
  return {
    name: provider,
    readUsage: async () => readings,
    spendsProviderUsageToRead: options.spendsProviderUsageToRead,
  } as AgentAdapter;
}

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
});

describe("UsageSafetyService", () => {
  it("reports UNAVAILABLE with no fabricated percentage when there is no reading yet", () => {
    const usage = service();
    const [view] = usage.getProviderUsage("CLAUDE");
    expect(view).toMatchObject({ status: "UNAVAILABLE", usedPercent: null, remainingPercent: null, source: null });
  });

  it("computes SAFE, WARNING, CHECKPOINT_REQUIRED, and EXHAUSTED from the configured thresholds", () => {
    const usage = service();
    const at = (usedPercent: number) => {
      usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent });
      return usage.getProviderUsage("CLAUDE").find((view) => view.windowId === "5H")!.status;
    };
    expect(at(10)).toBe("SAFE");
    expect(at(DEFAULT_USAGE_POLICY.warningThresholdPercent)).toBe("WARNING");
    expect(at(DEFAULT_USAGE_POLICY.checkpointThresholdPercent)).toBe("CHECKPOINT_REQUIRED");
    expect(at(100)).toBe("EXHAUSTED");
  });

  it("marks a reading STALE once it exceeds the configured freshness threshold, and never treats stale as safe", () => {
    const { db, sqlite } = createDatabase(":memory:");
    databases.push(sqlite);
    const usage = new UsageSafetyService(db);
    usage.updatePolicy({ staleAfterMs: 1_000 });
    const reading = usage.submitManualSnapshot({ provider: "CODEX", windowId: "5H", windowLabel: "5-hour window", usedPercent: 20 });
    expect(usage.getProviderUsage("CODEX")[0]!.status).toBe("SAFE");
    // Backdate the reading past the freshness window without going through the public API.
    const backdated = new Date(Date.now() - 10_000).toISOString();
    db.update(providerUsageReadings).set({ recordedAt: backdated }).where(eq(providerUsageReadings.id, reading.id)).run();
    const view = usage.getProviderUsage("CODEX").find((entry) => entry.windowId === "5H")!;
    expect(view.status).toBe("STALE");
    expect(view.readingId).toBe(reading.id);
  });

  it("supports multiple windows per provider independently", () => {
    const usage = service();
    usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 95 });
    usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "WEEKLY", windowLabel: "Weekly plan window", usedPercent: 10 });
    const views = usage.getProviderUsage("CLAUDE");
    expect(views).toHaveLength(2);
    expect(views.find((view) => view.windowId === "5H")?.status).toBe("CHECKPOINT_REQUIRED");
    expect(views.find((view) => view.windowId === "WEEKLY")?.status).toBe("SAFE");
  });

  it("supersedes an older reading for the same window with a newer one and reflects a reset-time transition", () => {
    const usage = service();
    const resetSoon = new Date(Date.now() + 5_000).toISOString();
    usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 100, resetAt: resetSoon });
    expect(usage.getProviderUsage("CLAUDE")[0]!.status).toBe("EXHAUSTED");
    usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 5 });
    const latest = usage.getProviderUsage("CLAUDE")[0]!;
    expect(latest.status).toBe("SAFE");
    expect(latest.usedPercent).toBe(5);
  });

  it("validates a manual snapshot", () => {
    const usage = service();
    expect(() => usage.submitManualSnapshot({ provider: "AWS", windowId: "5H", windowLabel: "x", usedPercent: 1 })).toThrow(UsageValidationError);
    expect(() => usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "", windowLabel: "x", usedPercent: 1 })).toThrow(UsageValidationError);
    expect(() => usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "", usedPercent: 1 })).toThrow(UsageValidationError);
    expect(() => usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "x", usedPercent: 101 })).toThrow(UsageValidationError);
    expect(() => usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "x", usedPercent: -1 })).toThrow(UsageValidationError);
    expect(() => usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "x", usedPercent: 1, resetAt: "not-a-date" })).toThrow(UsageValidationError);
    const ok = usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "x", usedPercent: 1 });
    expect(ok.source).toBe("MANUAL");
    expect(ok.sourceConfidence).toBe("ESTIMATED");
  });

  it("validates policy updates and rejects an inconsistent threshold pair", () => {
    const usage = service();
    expect(() => usage.updatePolicy({ warningThresholdPercent: 90, checkpointThresholdPercent: 50 })).toThrow(UsageValidationError);
    expect(() => usage.updatePolicy({ warningThresholdPercent: 150 })).toThrow(UsageValidationError);
    expect(() => usage.updatePolicy({ staleAfterMs: -1 })).toThrow(UsageValidationError);
    const updated = usage.updatePolicy({ warningThresholdPercent: 60, checkpointThresholdPercent: 80 });
    expect(updated).toMatchObject({ warningThresholdPercent: 60, checkpointThresholdPercent: 80 });
  });

  it("parses a plausible provider rate-limit refusal and marks that provider exhausted, without fabricating unrelated errors", () => {
    expect(parseRateLimitMessage("Some unrelated network error")).toBeNull();
    const parsed = parseRateLimitMessage("Claude AI usage limit reached. Your limit will reset at 2026-09-14T02:00:00.000Z.");
    expect(parsed).toMatchObject({ windowId: "5H", resetAt: "2026-09-14T02:00:00.000Z" });

    const usage = service();
    expect(usage.recordRateLimitError("CLAUDE", "A generic timeout occurred.")).toBeNull();
    const reading = usage.recordRateLimitError("CODEX", "You've hit your usage limit. Try again after 2026-09-14T03:00:00.000Z.");
    expect(reading).not.toBeNull();
    const view = usage.getProviderUsage("CODEX")[0]!;
    expect(view.status).toBe("EXHAUSTED");
    expect(view.source).toBe("RATE_LIMIT_ERROR");
    expect(view.sourceConfidence).toBe("EXACT");
  });

  it("records CLI-reported readings and picks them up through the normal evaluate/status pipeline with no special-casing", () => {
    const usage = service();
    const recorded = usage.recordCliReportedUsage("CLAUDE", [
      { windowId: "5H", windowLabel: "5-hour usage window", usedPercent: 80, resetAt: "2026-09-14T02:00:00.000Z" },
      { windowId: "WEEKLY", windowLabel: "weekly usage window", usedPercent: 33, resetAt: "2026-09-15T02:00:00.000Z" },
    ]);
    expect(recorded).toHaveLength(2);

    const views = usage.getProviderUsage("CLAUDE");
    const fiveHour = views.find((view) => view.windowId === "5H")!;
    expect(fiveHour).toMatchObject({ usedPercent: 80, status: "WARNING", source: "CLI_REPORTED", sourceConfidence: "EXACT" });
    const weekly = views.find((view) => view.windowId === "WEEKLY")!;
    expect(weekly).toMatchObject({ usedPercent: 33, status: "SAFE", source: "CLI_REPORTED", sourceConfidence: "EXACT" });

    const decision = usage.evaluate("CLAUDE", { combined: false });
    expect(decision.allowed).toBe(true);
    expect(decision.status).toBe("WARNING");
  });

  it("a later CLI-reported reading for the same window supersedes an earlier one, same as any other source", () => {
    const usage = service();
    usage.recordCliReportedUsage("CODEX", [{ windowId: "5H", windowLabel: "5-hour usage window", usedPercent: 10, resetAt: null }]);
    usage.recordCliReportedUsage("CODEX", [{ windowId: "5H", windowLabel: "5-hour usage window", usedPercent: 95, resetAt: null }]);
    const view = usage.getProviderUsage("CODEX").find((entry) => entry.windowId === "5H")!;
    expect(view.usedPercent).toBe(95);
    expect(view.status).toBe("CHECKPOINT_REQUIRED");
  });

  it("never confuses an API tokens/requests-per-minute throttle with the account usage window, even when it also says \"limit\"", () => {
    expect(parseRateLimitMessage("rate_limit_error: Number of request tokens has exceeded your per-minute rate limit.")).toBeNull();
    expect(parseRateLimitMessage("429 Too Many Requests: requests-per-minute limit exceeded, please slow down.")).toBeNull();
    expect(parseRateLimitMessage("Your organization has exceeded its tokens per minute (TPM) limit.")).toBeNull();
  });

  it("recognizes further plausible usage/quota/cap wording for the account allowance", () => {
    expect(parseRateLimitMessage("You have reached your usage cap for this plan. Resets in 2 hours.")).toMatchObject({ windowId: "5H" });
    expect(parseRateLimitMessage("Weekly limit reached. Try again after 2026-09-20T00:00:00.000Z.")).toMatchObject({ windowId: "WEEKLY" });
    expect(parseRateLimitMessage("Quota exceeded for this account until 2026-09-14T09:00:00.000Z.")).toMatchObject({
      windowId: "5H", resetAt: "2026-09-14T09:00:00.000Z",
    });
  });

  it("evaluate() never fabricates safety: unknown usage requires acknowledgement only for combined workflows", () => {
    const usage = service();
    const single = usage.evaluate("CLAUDE", { combined: false });
    expect(single).toMatchObject({ allowed: true, status: "UNAVAILABLE" });
    const combined = usage.evaluate("CLAUDE", { combined: true });
    expect(combined).toMatchObject({ allowed: false, requiresAcknowledgement: true, status: "UNAVAILABLE" });
  });

  it("persists an explicit acknowledgement with provider, reading, user action, and timestamp, and honors it until it expires", () => {
    const usage = service();
    usage.updatePolicy({ acknowledgementTtlMs: 50 });
    expect(usage.evaluate("CLAUDE", { combined: true }).allowed).toBe(false);
    const ack = usage.recordAcknowledgement({ provider: "CLAUDE", status: "UNAVAILABLE", userAction: "PROCEED", reason: "Operator confirmed it is fine to proceed." });
    expect(ack).toMatchObject({ provider: "CLAUDE", status: "UNAVAILABLE", userAction: "PROCEED", eventType: "ACKNOWLEDGEMENT" });
    expect(ack.createdAt).toBeTruthy();
    expect(usage.evaluate("CLAUDE", { combined: true }).allowed).toBe(true);
    expect(usage.getAuditHistory("CLAUDE")[0]).toMatchObject({ eventType: "ACKNOWLEDGEMENT", userAction: "PROCEED" });
  });

  it("checkpoints at the configured threshold and requires a fresh safe reading or an explicit override before continuing", () => {
    const usage = service();
    const reading = usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 95 });
    const blocked = usage.evaluate("CLAUDE", { combined: false });
    expect(blocked).toMatchObject({ allowed: false, requiresAcknowledgement: true, status: "CHECKPOINT_REQUIRED" });

    // A plain PROCEED acknowledgement for a different status does not clear a checkpoint.
    usage.recordAcknowledgement({ provider: "CLAUDE", status: "UNAVAILABLE", userAction: "PROCEED", reason: "irrelevant" });
    expect(usage.evaluate("CLAUDE", { combined: false }).allowed).toBe(false);

    // An explicit override tied to this exact reading clears it.
    usage.recordAcknowledgement({ provider: "CLAUDE", status: "CHECKPOINT_REQUIRED", relatedReadingId: reading.id, userAction: "OVERRIDE", reason: "Operator confirmed capacity remains." });
    expect(usage.evaluate("CLAUDE", { combined: false }).allowed).toBe(true);

    // A fresh safe reading also naturally clears the checkpoint without needing an override.
    usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 5 });
    expect(usage.evaluate("CLAUDE", { combined: false })).toMatchObject({ allowed: true, status: "SAFE" });
  });

  it("refuses any override once a provider is reliably exhausted, and assertReady throws and records the checkpoint", async () => {
    const usage = service();
    usage.submitManualSnapshot({ provider: "CODEX", windowId: "5H", windowLabel: "5-hour window", usedPercent: 100 });
    usage.recordAcknowledgement({ provider: "CODEX", status: "EXHAUSTED", userAction: "OVERRIDE", reason: "Please let me continue anyway." });
    expect(usage.evaluate("CODEX", { combined: false })).toMatchObject({ allowed: false, status: "EXHAUSTED" });

    await expect(usage.assertReady("CODEX", { combined: false })).rejects.toThrow(UsageCheckpointError);
    const audit = usage.getAuditHistory("CODEX");
    expect(audit[0]).toMatchObject({ eventType: "CHECKPOINT_TRIGGERED", status: "EXHAUSTED" });
  });

  it("resumes after reset: a fresh reading below the checkpoint threshold clears an exhausted status", () => {
    const usage = service();
    usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 100 });
    expect(usage.evaluate("CLAUDE", { combined: false }).status).toBe("EXHAUSTED");
    usage.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 0 });
    expect(usage.evaluate("CLAUDE", { combined: false })).toMatchObject({ allowed: true, status: "SAFE" });
  });

  it("refresh() never fabricates a percentage when no automatic source is supported", async () => {
    const usage = service();
    const result = await usage.refresh("CLAUDE");
    expect(result.updated).toBe(false);
    expect(usage.getProviderUsage("CLAUDE")[0]!.status).toBe("UNAVAILABLE");
  });

  it("refreshes exact Codex App Server readings with their real window durations", async () => {
    const usage = service([adapterWithUsage("CODEX", [{
      windowId: "5H", windowLabel: "5-hour usage window", windowDurationMs: 18_000_000,
      usedPercent: 72, resetAt: "2026-09-14T02:00:00.000Z",
    }])]);

    await expect(usage.refresh("CODEX")).resolves.toMatchObject({ updated: true });
    expect(usage.getProviderUsage("CODEX")[0]).toMatchObject({
      windowId: "5H", windowDurationMs: 18_000_000, usedPercent: 72,
      source: "APP_SERVER", sourceConfidence: "EXACT",
    });
  });

  it("refreshes immediately before evaluating whether a provider call is safe", async () => {
    const usage = service([adapterWithUsage("CODEX", [{
      windowId: "5H", windowLabel: "5-hour usage window", usedPercent: 95, resetAt: null,
    }])]);

    await expect(usage.assertReady("CODEX", { combined: false })).rejects.toThrow(UsageCheckpointError);
    expect(usage.getProviderUsage("CODEX")[0]).toMatchObject({ usedPercent: 95, status: "CHECKPOINT_REQUIRED" });
  });

  it("never auto-refreshes a reader that spends real provider usage (e.g. Claude's), but a manual refresh still calls it", async () => {
    const usage = service([adapterWithUsage("CLAUDE", [{
      windowId: "5H", windowLabel: "5-hour usage window", usedPercent: 40, resetAt: null,
    }], { spendsProviderUsageToRead: true })]);

    // assertReady's automatic pre-flight refresh must skip a reader that costs real usage.
    await usage.assertReady("CLAUDE", { combined: false });
    expect(usage.getProviderUsage("CLAUDE")[0]!.status).toBe("UNAVAILABLE");

    // An explicit, human-initiated refresh (the manual "Refresh" button) still calls it.
    await expect(usage.refresh("CLAUDE")).resolves.toMatchObject({ updated: true });
    expect(usage.getProviderUsage("CLAUDE")[0]).toMatchObject({ usedPercent: 40, source: "APP_SERVER" });
  });
});
