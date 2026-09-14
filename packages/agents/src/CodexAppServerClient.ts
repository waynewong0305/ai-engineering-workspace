import { spawn } from "node:child_process";
import readline from "node:readline";
import { sanitizeEnvironment } from "./environment.js";
import type { RateLimitWindowReading } from "./usage-extraction.js";

const MAX_ERROR_BYTES = 64 * 1024;
type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" ? value as JsonRecord : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function field(value: JsonRecord, camelCase: string, snakeCase: string): unknown {
  return value[camelCase] ?? value[snakeCase];
}

function resetAt(value: unknown): string | null {
  const seconds = number(value);
  return seconds === null ? null : new Date(seconds * 1_000).toISOString();
}

function windowIdentity(slot: "PRIMARY" | "SECONDARY", durationMins: number | null, limitName: string | null) {
  if (durationMins === 300) return { windowId: "5H", windowLabel: "5-hour usage window" };
  if (durationMins === 10_080) return { windowId: "WEEKLY", windowLabel: "weekly usage window" };
  return {
    windowId: `CODEX_${slot}_${durationMins ?? "UNKNOWN"}`,
    windowLabel: `${limitName ?? "Codex"} ${slot.toLowerCase()} usage window`,
  };
}

function reading(bucket: JsonRecord, slot: "PRIMARY" | "SECONDARY"): RateLimitWindowReading | null {
  const rawWindow = record(bucket[slot.toLowerCase()]);
  if (!rawWindow) return null;
  const usedPercent = number(field(rawWindow, "usedPercent", "used_percent"));
  if (usedPercent === null || usedPercent < 0 || usedPercent > 100) return null;
  const durationMins = number(field(rawWindow, "windowDurationMins", "window_minutes"));
  const rawLimitName = field(bucket, "limitName", "limit_name");
  const limitName = typeof rawLimitName === "string" && rawLimitName.trim() ? rawLimitName.trim() : null;
  return {
    ...windowIdentity(slot, durationMins, limitName),
    windowDurationMs: durationMins === null ? null : durationMins * 60_000,
    usedPercent,
    resetAt: resetAt(field(rawWindow, "resetsAt", "resets_at")),
  };
}

/** Normalize the documented `account/rateLimits/read` result without guessing missing fields. */
export function extractCodexAppServerRateLimits(value: unknown): RateLimitWindowReading[] {
  const result = record(value);
  if (!result) return [];
  const byLimitId = record(result.rateLimitsByLimitId);
  const bucket = record(result.rateLimits) ?? record(byLimitId?.codex);
  if (!bucket) return [];
  return (["PRIMARY", "SECONDARY"] as const)
    .map((slot) => reading(bucket, slot))
    .filter((entry): entry is RateLimitWindowReading => entry !== null);
}

export interface CodexUsageReader {
  readRateLimits(): Promise<RateLimitWindowReading[]>;
}

/**
 * One-shot stdio client for the supported Codex App Server account-rate-limit API. It initializes
 * a fresh local process, reads the current ChatGPT quota windows, and terminates it immediately;
 * it never starts a model turn or consumes a reset credit.
 */
export class CodexAppServerClient implements CodexUsageReader {
  constructor(
    private readonly executable = "codex",
    private readonly timeoutMs = 5_000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
      throw new Error("Codex App Server timeout must be between 100 ms and 30 seconds.");
    }
  }

  readRateLimits(): Promise<RateLimitWindowReading[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, ["app-server", "--listen", "stdio://"], {
        env: sanitizeEnvironment(), shell: false, stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = readline.createInterface({ input: child.stdout });
      let stderr = "";
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (error: Error | null, readings: RateLimitWindowReading[] = []) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        lines.close();
        child.kill("SIGTERM");
        if (error) reject(error);
        else resolve(readings);
      };
      const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

      child.stdin.on("error", () => { /* child error/close handlers report the actionable failure */ });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_ERROR_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_ERROR_BYTES - stderr.length);
      });
      child.on("error", (error) => finish(new Error(`Could not start Codex App Server: ${error.message}`)));
      child.on("close", (exitCode) => {
        if (!settled) {
          const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
          finish(new Error(`Codex App Server exited before returning rate limits (code ${exitCode ?? "unknown"})${detail}`));
        }
      });
      lines.on("line", (line) => {
        if (!line.trim() || settled) return;
        let message: JsonRecord | null = null;
        try {
          message = record(JSON.parse(line));
        } catch {
          finish(new Error("Codex App Server returned invalid JSON."));
          return;
        }
        if (!message) return;
        if (message.id === 0) {
          if (message.error) {
            finish(new Error("Codex App Server rejected initialization."));
            return;
          }
          send({ method: "initialized", params: {} });
          send({ method: "account/rateLimits/read", id: 1 });
        } else if (message.id === 1) {
          if (message.error) {
            const appServerError = record(message.error);
            const detail = typeof appServerError?.message === "string" ? `: ${appServerError.message}` : "";
            finish(new Error(`Codex App Server could not read rate limits${detail}`));
            return;
          }
          finish(null, extractCodexAppServerRateLimits(message.result));
        }
      });

      timeout = setTimeout(() => {
        finish(new Error(`Codex App Server did not return rate limits within ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      child.on("spawn", () => send({
        method: "initialize",
        id: 0,
        params: { clientInfo: { name: "ai_engineering_workspace", title: "AI Engineering Workspace", version: "0.1.0" } },
      }));
    });
  }
}
