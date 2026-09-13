import { randomUUID } from "node:crypto";
import { ProcessSupervisor } from "@aiew/agents";
import type { ValidationCommand, ValidationRunStatus } from "../db/schema.js";

export type ValidationRunResult = {
  id: string;
  worktreeId: string | null;
  commandId: string;
  commandLabel: string;
  command: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  status: ValidationRunStatus;
};

const MAX_STORED_TEXT = 5 * 1024 * 1024;

function appendBounded(current: string, addition: string) {
  const joined = current + addition;
  return joined.length <= MAX_STORED_TEXT ? joined : joined.slice(joined.length - MAX_STORED_TEXT);
}

/**
 * Minimal whitespace/quote-aware tokenizer for a stored validation command string. ProcessSupervisor
 * never uses a shell (shell:false is a deliberate anti-injection stance), so the command must be
 * split into argv ourselves. This intentionally does not support pipes, &&/|| chains, redirects, or
 * inline env-var assignment — a documented MVP limitation, not a reintroduced shell:true.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (quote) throw new Error(`Validation command has an unterminated quote: ${command}`);
  if (hasToken) tokens.push(current);
  return tokens;
}

export class ValidationRunner {
  constructor(private readonly supervisor = new ProcessSupervisor()) {}

  async run(
    worktreePath: string,
    worktreeId: string | null,
    commands: ValidationCommand[],
    timeoutMs: number,
  ): Promise<ValidationRunResult[]> {
    const results: ValidationRunResult[] = [];
    for (const command of commands) {
      results.push(await this.runOne(worktreePath, worktreeId, command, timeoutMs));
    }
    return results;
  }

  private async runOne(
    worktreePath: string,
    worktreeId: string | null,
    command: ValidationCommand,
    timeoutMs: number,
  ): Promise<ValidationRunResult> {
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let status: ValidationRunStatus = "ERROR";
    let durationMs = 0;
    try {
      const [executable, ...args] = tokenizeCommand(command.command);
      if (!executable) throw new Error("Validation command is empty.");
      for await (const event of this.supervisor.run({
        runId,
        command: executable,
        args,
        cwd: worktreePath,
        permissionProfile: "TEST_ONLY",
        environment: {},
        timeoutMs,
      })) {
        if (event.type === "stdout") stdout = appendBounded(stdout, event.chunk);
        else if (event.type === "stderr") stderr = appendBounded(stderr, event.chunk);
        else if (event.type === "exited") {
          exitCode = event.exitCode;
          durationMs = event.durationMs;
          status = "PASSED";
        } else if (event.type === "failed") {
          exitCode = event.exitCode;
          durationMs = event.durationMs;
          status = event.exitCode !== null ? "FAILED" : "ERROR";
          if (!stderr) stderr = event.message;
        } else if (event.type === "timed_out" || event.type === "cancelled") {
          durationMs = event.durationMs;
          status = "ERROR";
        }
      }
    } catch (error) {
      status = "ERROR";
      if (!stderr) stderr = error instanceof Error ? error.message : "Validation command failed to run.";
    }
    return {
      id: runId,
      worktreeId,
      commandId: command.id,
      commandLabel: command.label,
      command: command.command,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs,
      exitCode,
      stdout,
      stderr,
      status,
    };
  }
}
