import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { sanitizeEnvironment } from "./environment.js";
import { JsonLineDecoder } from "./JsonLineDecoder.js";
import { extractRateLimitReadings, type RateLimitWindowReading } from "./usage-extraction.js";

const MAX_ERROR_BYTES = 64 * 1024;

/** Cheapest currently available Claude model — keeps the probe's real cost to a minimum. */
export const CLAUDE_USAGE_PROBE_MODEL = "claude-haiku-4-5-20251001";

export interface ClaudeUsageReader {
  readRateLimits(): Promise<RateLimitWindowReading[]>;
}

/**
 * Claude has no free, standalone rate-limit endpoint like Codex's `account/rateLimits/read` — the
 * only documented source is the `rate_limit_event` a real run's structured output emits (see
 * usage-extraction.ts). This client obtains that reading with the smallest real turn possible: the
 * cheapest model, a one-line prompt, no session persisted, and it kills the process the instant a
 * reading is seen rather than waiting for the full reply. It still spends actual provider usage, so
 * it must never be invoked automatically — only from an explicit human-initiated refresh (see
 * ClaudeAdapter.spendsProviderUsageToRead and UsageSafetyService.refresh's `auto` guard).
 */
export class ClaudeUsageProbeClient implements ClaudeUsageReader {
  constructor(
    private readonly executable = "claude",
    private readonly timeoutMs = 20_000,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
      throw new Error("Claude usage probe timeout must be between 100 ms and 60 seconds.");
    }
  }

  readRateLimits(): Promise<RateLimitWindowReading[]> {
    return new Promise((resolve, reject) => {
      const args = [
        "-p", "Reply with only the word OK.", "--output-format", "stream-json", "--verbose", "--restricted",
        "--tools", "Read,Glob,Grep", "--permission-mode", "plan", "--permission-prompts", "none",
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
        "--disable-slash-commands", "--no-chrome", "--no-session-persistence",
        "--model", CLAUDE_USAGE_PROBE_MODEL,
      ];
      const child = spawn(this.executable, args, {
        env: sanitizeEnvironment(), shell: false, cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"],
      });
      const decoder = new JsonLineDecoder();
      let stderr = "";
      let settled = false;
      let timeout: NodeJS.Timeout | undefined;

      const finish = (error: Error | null, readings: RateLimitWindowReading[] = []) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        child.kill("SIGTERM");
        if (error) reject(error);
        else resolve(readings);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        for (const value of decoder.push(chunk.toString("utf8"))) {
          const readings = extractRateLimitReadings("CLAUDE", value);
          if (readings.length) {
            finish(null, readings);
            return;
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_ERROR_BYTES) stderr += chunk.toString("utf8").slice(0, MAX_ERROR_BYTES - stderr.length);
      });
      child.on("error", (error) => finish(new Error(`Could not start Claude Code CLI: ${error.message}`)));
      child.on("close", (exitCode) => {
        if (!settled) {
          const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
          finish(new Error(`Claude Code CLI exited before reporting a usage reading (code ${exitCode ?? "unknown"})${detail}`));
        }
      });

      timeout = setTimeout(() => {
        finish(new Error(`Claude Code CLI did not report a usage reading within ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
    });
  }
}
