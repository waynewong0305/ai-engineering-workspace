import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { PermissionProfile } from "./types.js";
import { sanitizeEnvironment } from "./environment.js";

export type SupervisedProcessEvent =
  | { type: "started"; occurredAt: string; pid: number | null }
  | { type: "stdout"; occurredAt: string; chunk: string }
  | { type: "stderr"; occurredAt: string; chunk: string }
  | { type: "exited"; occurredAt: string; exitCode: number; durationMs: number }
  | { type: "failed"; occurredAt: string; message: string; exitCode: number | null; durationMs: number }
  | { type: "cancelled"; occurredAt: string; durationMs: number }
  | { type: "timed_out"; occurredAt: string; durationMs: number };

export type SupervisedProcessInput = {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  permissionProfile: PermissionProfile;
  environment?: Record<string, string>;
  timeoutMs: number;
  maxChunkBytes?: number;
};

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type ActiveProcess = {
  child: ChildProcess;
  finishReason: "CANCELLED" | "TIMED_OUT" | null;
  forceKillTimer: NodeJS.Timeout | null;
};

export class ProcessSupervisor {
  private readonly active = new Map<string, ActiveProcess>();

  constructor(private readonly terminationGraceMs = 2_000) {
    if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 1 || terminationGraceMs > 30_000) {
      throw new Error("Process termination grace period must be between 1 ms and 30 seconds.");
    }
  }

  async *run(input: SupervisedProcessInput): AsyncIterable<SupervisedProcessEvent> {
    if (this.active.has(input.runId)) throw new Error(`Run ${input.runId} is already active.`);
    if (!isAbsolute(input.cwd)) throw new Error("Agent working directory must be absolute.");
    const directory = await stat(input.cwd).catch(() => null);
    if (!directory?.isDirectory()) throw new Error("Agent working directory must be a readable directory.");
    if (input.permissionProfile === "WORKTREE_WRITE" || input.permissionProfile === "TEST_ONLY") {
      // A worktree's .git is always a file (`gitdir: <path>`); a primary repository checkout's
      // .git is a directory. This structural check keeps a write/test process from ever running
      // against the developer's real checkout, independent of whether the caller got cwd wrong.
      // It is not a substitute for an OS-level sandbox (each CLI's own permission/sandbox flags do
      // that work) — a stronger sandbox here is a Phase 7 hardening candidate, not required now.
      const gitEntry = await stat(join(input.cwd, ".git")).catch(() => null);
      if (!gitEntry?.isFile()) {
        throw new Error("WORKTREE_WRITE/TEST_ONLY may only run inside a Git worktree, not a primary repository checkout.");
      }
    }
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 3_600_000) {
      throw new Error("Agent timeout must be between 1 second and 1 hour.");
    }

    const queue = new AsyncEventQueue<SupervisedProcessEvent>();
    const startedAt = Date.now();
    const detached = process.platform !== "win32";
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      detached,
      env: sanitizeEnvironment(input.environment),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const active: ActiveProcess = { child, finishReason: null, forceKillTimer: null };
    this.active.set(input.runId, active);
    const maxChunkBytes = input.maxChunkBytes ?? 256 * 1024;
    let terminal = false;

    const emitChunk = (type: "stdout" | "stderr", chunk: Buffer) => {
      const bounded = chunk.byteLength > maxChunkBytes ? chunk.subarray(0, maxChunkBytes) : chunk;
      queue.push({ type, occurredAt: new Date().toISOString(), chunk: bounded.toString("utf8") });
    };
    child.stdout.on("data", (chunk: Buffer) => emitChunk("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => emitChunk("stderr", chunk));
    queue.push({ type: "started", occurredAt: new Date().toISOString(), pid: child.pid ?? null });

    const timeout = setTimeout(() => {
      active.finishReason = "TIMED_OUT";
      this.terminate(active);
    }, input.timeoutMs);

    const finish = (event: SupervisedProcessEvent) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(input.runId);
      queue.push(event);
      queue.close();
    };

    child.on("error", (error) => finish({
      type: "failed",
      occurredAt: new Date().toISOString(),
      message: error.message,
      exitCode: null,
      durationMs: Date.now() - startedAt,
    }));
    child.on("close", (exitCode) => {
      const common = { occurredAt: new Date().toISOString(), durationMs: Date.now() - startedAt };
      if (active.finishReason === "CANCELLED") finish({ type: "cancelled", ...common });
      else if (active.finishReason === "TIMED_OUT") finish({ type: "timed_out", ...common });
      else if (exitCode === 0) finish({ type: "exited", exitCode, ...common });
      else finish({ type: "failed", message: `Agent process exited with code ${exitCode ?? "unknown"}.`, exitCode, ...common });
    });

    yield* queue;
  }

  async cancel(runId: string): Promise<void> {
    const active = this.active.get(runId);
    if (!active) return;
    active.finishReason = "CANCELLED";
    this.terminate(active);
  }

  private terminate(active: ActiveProcess) {
    this.signal(active.child, "SIGTERM");
    if (active.forceKillTimer) return;
    active.forceKillTimer = setTimeout(() => this.signal(active.child, "SIGKILL"), this.terminationGraceMs);
    active.forceKillTimer.unref();
  }

  private signal(child: ChildProcess, signal: NodeJS.Signals) {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to killing the direct child.
      }
    }
    child.kill(signal);
  }
}
