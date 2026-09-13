import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  providerUsageReadings,
  usageSafetyAudit,
  usageSafetySettings,
  type ProviderUsageReadingRecord,
  type UsageProvider,
  type UsageSafetyAuditRecord,
  type UsageSafetySettingsRecord,
  type UsageSafetyUserAction,
  type UsageSource,
  type UsageSourceConfidence,
  type UsageStatus,
} from "../db/schema.js";

/**
 * Default safety policy. There is no supported local CLI or API surface that exposes exact Claude
 * Code / Codex CLI usage percentages today (see IMPLEMENTATION_ROADMAP.md's CLI capability
 * findings), and this project's safety rules forbid probing further or calling an undocumented
 * endpoint to find one. Thresholds are therefore deliberately configurable rather than tuned
 * against a real provider response shape.
 */
export const DEFAULT_USAGE_POLICY = {
  warningThresholdPercent: 75,
  checkpointThresholdPercent: 90,
  staleAfterMs: 30 * 60 * 1000,
  acknowledgementTtlMs: 15 * 60 * 1000,
};

export type UsageWindowView = {
  provider: UsageProvider;
  windowId: string;
  windowLabel: string;
  windowDurationMs: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  timeUntilReset: string | null;
  source: UsageSource | null;
  sourceConfidence: UsageSourceConfidence | null;
  lastRefreshedAt: string | null;
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  status: UsageStatus;
  readingId: string | null;
};

export type UsageEvaluation = {
  allowed: boolean;
  requiresAcknowledgement: boolean;
  status: UsageStatus;
  provider: UsageProvider;
  windowId: string;
  readingId: string | null;
  reason: string;
};

export class UsageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageValidationError";
  }
}

export class UsageCheckpointError extends Error {
  constructor(message: string, readonly decision: UsageEvaluation) {
    super(message);
    this.name = "UsageCheckpointError";
  }
}

function humanizeDuration(ms: number): string {
  if (ms <= 0) return "now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

const EXHAUSTION_PATTERNS: Array<{ pattern: RegExp; windowId: string; windowLabel: string }> = [
  { pattern: /\b5[- ]hour (?:usage )?limit\b/i, windowId: "5H", windowLabel: "5-hour usage window" },
  { pattern: /\bweekly (?:usage )?limit\b/i, windowId: "WEEKLY", windowLabel: "weekly usage window" },
  { pattern: /\busage limit reached\b/i, windowId: "5H", windowLabel: "usage window" },
  { pattern: /\byou.?ve (?:hit|reached) your usage (?:limit|cap)\b/i, windowId: "5H", windowLabel: "usage window" },
  { pattern: /\busage cap\b/i, windowId: "5H", windowLabel: "usage window" },
  { pattern: /\b(?:quota|allowance) (?:exceeded|reached|exhausted)\b/i, windowId: "5H", windowLabel: "usage window" },
];

/**
 * Wording that indicates an API-level tokens-per-minute/requests-per-minute throttle, not the
 * Claude Code / ChatGPT subscription usage window this parser is meant to detect. A message
 * matching this must never be recorded as an exhausted usage window, even if it also happens to
 * contain the word "limit" — conflating the two is exactly the mistake this project must avoid.
 */
const API_RATE_LIMIT_EXCLUSIONS = /\b(tokens?[- ]per[- ]minute|requests?[- ]per[- ]minute|\btpm\b|\brpm\b|rate[_-]?limit[_-]?error|\b429\b)/i;

const RESET_PATTERNS = [
  /resets? (?:at|around)\s+([^\n]+)/i,
  /try again (?:after|at)\s+([^\n]+)/i,
  /available again (?:at|around)\s+([^\n]+)/i,
  /\buntil\s+([^\n]+)/i,
];

/**
 * Reset-time phrases are captured greedily to end of line (a timestamp's own "." before
 * milliseconds must not truncate the match), then parsed with progressively trimmed trailing
 * punctuation/words so a trailing sentence period or explanatory clause doesn't block parsing.
 */
function parseTrailingTimestamp(candidate: string): string | null {
  let text = candidate.trim();
  for (let attempt = 0; attempt < 6 && text; attempt += 1) {
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    text = text.replace(/[.,;]\s*$/, "").replace(/\s+\S+$/, "").trim();
  }
  return null;
}

/**
 * Heuristic, best-effort match against wording providers have historically used for a usage/rate
 * limit refusal. This cannot be validated against a real exhausted response without spending
 * provider usage, so treat matches as a helpful signal, not a certainty: it deliberately never
 * fabricates a percentage, it only ever records a 100%-used reading when text plausibly indicates
 * exhaustion, and callers should re-verify with a fresh reading before trusting it long-term.
 */
export function parseRateLimitMessage(message: string): { windowId: string; windowLabel: string; resetAt: string | null } | null {
  if (!message) return null;
  // An API-level tokens/requests-per-minute throttle is a different thing entirely from the
  // account usage window this parser targets; never let one masquerade as the other.
  if (API_RATE_LIMIT_EXCLUSIONS.test(message)) return null;
  const matched = EXHAUSTION_PATTERNS.find((entry) => entry.pattern.test(message));
  if (!matched) return null;
  let resetAt: string | null = null;
  for (const pattern of RESET_PATTERNS) {
    const found = message.match(pattern)?.[1];
    if (!found) continue;
    resetAt = parseTrailingTimestamp(found);
    if (resetAt) break;
  }
  return { windowId: matched.windowId, windowLabel: matched.windowLabel, resetAt };
}

export class UsageSafetyService {
  constructor(private readonly db: WorkspaceDatabase) {}

  getPolicy(): UsageSafetySettingsRecord {
    const existing = this.db.select().from(usageSafetySettings).where(eq(usageSafetySettings.id, "default")).get();
    if (existing) return existing;
    const created = { id: "default", ...DEFAULT_USAGE_POLICY, updatedAt: new Date().toISOString() };
    this.db.insert(usageSafetySettings).values(created).run();
    return created;
  }

  updatePolicy(patch: Partial<{
    warningThresholdPercent: number;
    checkpointThresholdPercent: number;
    staleAfterMs: number;
    acknowledgementTtlMs: number;
  }>): UsageSafetySettingsRecord {
    const current = this.getPolicy();
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    if (!Number.isFinite(next.warningThresholdPercent) || next.warningThresholdPercent < 0 || next.warningThresholdPercent > 100) {
      throw new UsageValidationError("warningThresholdPercent must be a number between 0 and 100.");
    }
    if (!Number.isFinite(next.checkpointThresholdPercent) || next.checkpointThresholdPercent < 0 || next.checkpointThresholdPercent > 100) {
      throw new UsageValidationError("checkpointThresholdPercent must be a number between 0 and 100.");
    }
    if (next.checkpointThresholdPercent < next.warningThresholdPercent) {
      throw new UsageValidationError("checkpointThresholdPercent must be greater than or equal to warningThresholdPercent.");
    }
    if (!Number.isFinite(next.staleAfterMs) || next.staleAfterMs <= 0) throw new UsageValidationError("staleAfterMs must be a positive number.");
    if (!Number.isFinite(next.acknowledgementTtlMs) || next.acknowledgementTtlMs <= 0) {
      throw new UsageValidationError("acknowledgementTtlMs must be a positive number.");
    }
    this.db.update(usageSafetySettings).set(next).where(eq(usageSafetySettings.id, "default")).run();
    return next;
  }

  private latestReadingsByWindow(provider: UsageProvider): ProviderUsageReadingRecord[] {
    // createdAt has millisecond resolution, so two readings recorded in quick succession (a test,
    // or a rate-limit error recorded right after a stdout chunk) can tie; break ties by insertion
    // order (SQLite's rowid) so the reading actually written last is always treated as latest.
    const rows = this.db.select().from(providerUsageReadings)
      .where(eq(providerUsageReadings.provider, provider))
      .orderBy(desc(providerUsageReadings.createdAt), desc(sql`rowid`)).all();
    const seen = new Set<string>();
    const latest: ProviderUsageReadingRecord[] = [];
    for (const row of rows) {
      if (seen.has(row.windowId)) continue;
      seen.add(row.windowId);
      latest.push(row);
    }
    return latest;
  }

  private statusFor(reading: ProviderUsageReadingRecord, policy: UsageSafetySettingsRecord, now: number): { status: UsageStatus; freshness: "FRESH" | "STALE" } {
    const stale = now - Date.parse(reading.recordedAt) > policy.staleAfterMs;
    if (reading.source === "RATE_LIMIT_ERROR" || reading.usedPercent >= 100) return { status: "EXHAUSTED", freshness: stale ? "STALE" : "FRESH" };
    if (stale) return { status: "STALE", freshness: "STALE" };
    if (reading.usedPercent >= policy.checkpointThresholdPercent) return { status: "CHECKPOINT_REQUIRED", freshness: "FRESH" };
    if (reading.usedPercent >= policy.warningThresholdPercent) return { status: "WARNING", freshness: "FRESH" };
    return { status: "SAFE", freshness: "FRESH" };
  }

  getProviderUsage(provider: UsageProvider): UsageWindowView[] {
    const policy = this.getPolicy();
    const now = Date.now();
    const readings = this.latestReadingsByWindow(provider);
    if (!readings.length) {
      return [{
        provider, windowId: "UNKNOWN", windowLabel: "No usage data yet", windowDurationMs: null,
        usedPercent: null, remainingPercent: null, resetAt: null, timeUntilReset: null,
        source: null, sourceConfidence: null, lastRefreshedAt: null, freshness: "UNKNOWN",
        status: "UNAVAILABLE", readingId: null,
      }];
    }
    return readings.map((reading) => {
      const { status, freshness } = this.statusFor(reading, policy, now);
      return {
        provider, windowId: reading.windowId, windowLabel: reading.windowLabel, windowDurationMs: reading.windowDurationMs,
        usedPercent: reading.usedPercent, remainingPercent: Math.max(0, 100 - reading.usedPercent),
        resetAt: reading.resetAt,
        timeUntilReset: reading.resetAt ? humanizeDuration(Date.parse(reading.resetAt) - now) : null,
        source: reading.source, sourceConfidence: reading.sourceConfidence,
        lastRefreshedAt: reading.recordedAt, freshness, status, readingId: reading.id,
      };
    });
  }

  getAllUsage(): Record<UsageProvider, UsageWindowView[]> {
    return { CLAUDE: this.getProviderUsage("CLAUDE"), CODEX: this.getProviderUsage("CODEX") };
  }

  /**
   * There is no supported automatic usage source today (see the module docstring). This method
   * exists so the API/UI has one explicit, honest "Refresh" action rather than silently doing
   * nothing; it never fabricates a percentage and never contacts an undocumented endpoint.
   */
  refresh(provider: UsageProvider) {
    return {
      provider,
      updated: false,
      message: "No supported automatic usage source is available for this provider yet. Submit a manual snapshot, or wait for a rate-limit response to be recorded automatically.",
    };
  }

  submitManualSnapshot(input: Record<string, unknown>): ProviderUsageReadingRecord {
    if (input.provider !== "CLAUDE" && input.provider !== "CODEX") throw new UsageValidationError("provider must be CLAUDE or CODEX.");
    const windowId = typeof input.windowId === "string" ? input.windowId.trim() : "";
    if (!windowId || windowId.length > 40) throw new UsageValidationError("windowId is required (max 40 characters).");
    const windowLabel = typeof input.windowLabel === "string" ? input.windowLabel.trim() : "";
    if (!windowLabel || windowLabel.length > 120) throw new UsageValidationError("windowLabel is required (max 120 characters).");
    if (typeof input.usedPercent !== "number" || !Number.isFinite(input.usedPercent) || input.usedPercent < 0 || input.usedPercent > 100) {
      throw new UsageValidationError("usedPercent must be a number between 0 and 100.");
    }
    let resetAt: string | null = null;
    if (input.resetAt !== undefined && input.resetAt !== null) {
      if (typeof input.resetAt !== "string" || Number.isNaN(Date.parse(input.resetAt))) throw new UsageValidationError("resetAt must be a valid ISO timestamp.");
      resetAt = new Date(input.resetAt).toISOString();
    }
    let windowDurationMs: number | null = null;
    if (input.windowDurationMs !== undefined && input.windowDurationMs !== null) {
      if (typeof input.windowDurationMs !== "number" || !Number.isFinite(input.windowDurationMs) || input.windowDurationMs <= 0) {
        throw new UsageValidationError("windowDurationMs must be a positive number.");
      }
      windowDurationMs = input.windowDurationMs;
    }
    const confidence: UsageSourceConfidence = input.confidence === "EXACT" ? "EXACT" : "ESTIMATED";
    const now = new Date().toISOString();
    const reading: ProviderUsageReadingRecord = {
      id: randomUUID(), provider: input.provider, windowId, windowLabel, windowDurationMs,
      usedPercent: input.usedPercent, resetAt, source: "MANUAL", sourceConfidence: confidence,
      recordedAt: now, createdAt: now,
    };
    this.db.insert(providerUsageReadings).values(reading).run();
    return reading;
  }

  recordRateLimitError(provider: UsageProvider, message: string): ProviderUsageReadingRecord | null {
    const parsed = parseRateLimitMessage(message);
    if (!parsed) return null;
    const now = new Date().toISOString();
    const reading: ProviderUsageReadingRecord = {
      id: randomUUID(), provider, windowId: parsed.windowId, windowLabel: parsed.windowLabel,
      windowDurationMs: null, usedPercent: 100, resetAt: parsed.resetAt,
      source: "RATE_LIMIT_ERROR", sourceConfidence: "EXACT", recordedAt: now, createdAt: now,
    };
    this.db.insert(providerUsageReadings).values(reading).run();
    return reading;
  }

  recordAcknowledgement(input: Record<string, unknown>): UsageSafetyAuditRecord {
    if (input.provider !== "CLAUDE" && input.provider !== "CODEX") throw new UsageValidationError("provider must be CLAUDE or CODEX.");
    const validStatuses: UsageStatus[] = ["SAFE", "WARNING", "CHECKPOINT_REQUIRED", "EXHAUSTED", "UNAVAILABLE", "STALE"];
    if (typeof input.status !== "string" || !validStatuses.includes(input.status as UsageStatus)) throw new UsageValidationError("status must be a known usage status.");
    if (input.userAction !== "PROCEED" && input.userAction !== "OVERRIDE" && input.userAction !== "PAUSE") {
      throw new UsageValidationError("userAction must be PROCEED, OVERRIDE, or PAUSE.");
    }
    const windowId = input.windowId === undefined || input.windowId === null ? null : String(input.windowId);
    const relatedReadingId = input.relatedReadingId === undefined || input.relatedReadingId === null ? null : String(input.relatedReadingId);
    const reason = typeof input.reason === "string" && input.reason.trim() ? input.reason.trim().slice(0, 2_000) : "Human acknowledgement recorded.";
    const entry: UsageSafetyAuditRecord = {
      id: randomUUID(), provider: input.provider, windowId, eventType: "ACKNOWLEDGEMENT",
      status: input.status as UsageStatus, relatedReadingId, userAction: input.userAction, reason,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(usageSafetyAudit).values(entry).run();
    return entry;
  }

  private recordCheckpoint(provider: UsageProvider, windowId: string | null, status: UsageStatus, reason: string) {
    const entry: UsageSafetyAuditRecord = {
      id: randomUUID(), provider, windowId, eventType: "CHECKPOINT_TRIGGERED", status,
      relatedReadingId: null, userAction: null, reason, createdAt: new Date().toISOString(),
    };
    this.db.insert(usageSafetyAudit).values(entry).run();
    return entry;
  }

  getAuditHistory(provider?: UsageProvider): UsageSafetyAuditRecord[] {
    const query = this.db.select().from(usageSafetyAudit);
    return (provider ? query.where(eq(usageSafetyAudit.provider, provider)) : query)
      .orderBy(desc(usageSafetyAudit.createdAt)).all();
  }

  private recentAcknowledgement(
    provider: UsageProvider,
    windowId: string | null,
    status: UsageStatus,
    readingId: string | null,
    policy: UsageSafetySettingsRecord,
  ): UsageSafetyAuditRecord | null {
    const now = Date.now();
    const rows = this.db.select().from(usageSafetyAudit).where(and(
      eq(usageSafetyAudit.provider, provider),
      eq(usageSafetyAudit.eventType, "ACKNOWLEDGEMENT"),
    )).orderBy(desc(usageSafetyAudit.createdAt)).all();
    return rows.find((row) => {
      if (row.status !== status) return false;
      if (windowId !== null && row.windowId !== null && row.windowId !== windowId) return false;
      if (readingId !== null && row.relatedReadingId !== null && row.relatedReadingId !== readingId) return false;
      if (row.userAction !== "PROCEED" && row.userAction !== "OVERRIDE") return false;
      return now - Date.parse(row.createdAt) <= policy.acknowledgementTtlMs;
    }) ?? null;
  }

  /**
   * Non-throwing decision for whether a provider call may proceed right now. `combined` should be
   * true for a multi-provider/multi-stage workflow (unknown/stale usage then defaults to requiring
   * acknowledgement); false for a single, isolated provider-consuming action.
   */
  evaluate(provider: UsageProvider, options: { combined: boolean }): UsageEvaluation {
    const policy = this.getPolicy();
    const views = this.getProviderUsage(provider);
    const rank: Record<UsageStatus, number> = { SAFE: 0, WARNING: 1, UNAVAILABLE: 2, STALE: 2, CHECKPOINT_REQUIRED: 3, EXHAUSTED: 4 };
    const worst = views.reduce((a, b) => (rank[b.status] > rank[a.status] ? b : a));

    if (worst.status === "EXHAUSTED") {
      return {
        allowed: false, requiresAcknowledgement: false, status: worst.status, provider, windowId: worst.windowId, readingId: worst.readingId,
        reason: `${provider} ${worst.windowLabel} is exhausted${worst.timeUntilReset ? ` (resets in ${worst.timeUntilReset})` : ""}. Blocked until reset, or a fresh reading proves capacity. A reliable exhausted status cannot be overridden.`,
      };
    }
    if (worst.status === "CHECKPOINT_REQUIRED") {
      const ack = this.recentAcknowledgement(provider, worst.windowId, worst.status, worst.readingId, policy);
      if (ack) {
        return {
          allowed: true, requiresAcknowledgement: false, status: worst.status, provider, windowId: worst.windowId, readingId: worst.readingId,
          reason: `Proceeding under an explicit human override recorded at ${ack.createdAt}.`,
        };
      }
      return {
        allowed: false, requiresAcknowledgement: true, status: worst.status, provider, windowId: worst.windowId, readingId: worst.readingId,
        reason: `${provider} ${worst.windowLabel} is at the checkpoint threshold (${worst.usedPercent}% used). A fresh safe reading or an explicit human override is required before continuing.`,
      };
    }
    if (worst.status === "UNAVAILABLE" || worst.status === "STALE") {
      if (!options.combined) {
        return {
          allowed: true, requiresAcknowledgement: false, status: worst.status, provider, windowId: worst.windowId, readingId: worst.readingId,
          reason: `${provider} usage is ${worst.status.toLowerCase()}; proceeding for a single provider action.`,
        };
      }
      const ack = this.recentAcknowledgement(provider, worst.windowId === "UNKNOWN" ? null : worst.windowId, worst.status, worst.readingId, policy);
      if (ack) {
        return {
          allowed: true, requiresAcknowledgement: false, status: worst.status, provider, windowId: worst.windowId, readingId: worst.readingId,
          reason: `Proceeding: usage is ${worst.status.toLowerCase()}, acknowledged at ${ack.createdAt}.`,
        };
      }
      return {
        allowed: false, requiresAcknowledgement: true, status: worst.status, provider, windowId: worst.windowId, readingId: worst.readingId,
        reason: `${provider} usage is ${worst.status.toLowerCase()} for this combined, multi-stage workflow. Explicit acknowledgement is required before spending provider usage blind.`,
      };
    }
    return {
      allowed: true, requiresAcknowledgement: false, status: worst.status, provider, windowId: worst.windowId, readingId: worst.readingId,
      reason: `${provider} usage is ${worst.status.toLowerCase()}.`,
    };
  }

  assertReady(provider: UsageProvider, options: { combined: boolean }): UsageEvaluation {
    const decision = this.evaluate(provider, options);
    if (!decision.allowed) {
      this.recordCheckpoint(provider, decision.windowId, decision.status, decision.reason);
      throw new UsageCheckpointError(decision.reason, decision);
    }
    return decision;
  }
}
