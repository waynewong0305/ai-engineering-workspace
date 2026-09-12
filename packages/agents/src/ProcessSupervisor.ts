import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
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
};

export class ProcessSupervisor {
  private readonly active = new Map<string, ActiveProcess>();

  async *run(input: SupervisedProcessInput): AsyncIterable<SupervisedProcessEvent> {
    if (this.active.has(input.runId)) throw new Error(`Run ${input.runId} is already active.`);
    if (input.permissionProfile !== "READ_ONLY") {
      throw new Error("This release only permits READ_ONLY agent processes.");
    }
    if (!isAbsolute(input.cwd)) throw new Error("Agent working directory must be absolute.");
    const directory = await stat(input.cwd).catch(() => null);
    if (!directory?.isDirectory()) throw new Error("Agent working directory must be a readable directory.");
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
    const active: ActiveProcess = { child, finishReason: null };
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
      this.kill(child);
    }, input.timeoutMs);

    const finish = (event: SupervisedProcessEvent) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timeout);
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
    this.kill(active.child);
  }

  private kill(child: ChildProcess) {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGTERM");
        return;
      } catch {
        // Fall back to killing the direct child.
      }
    }
    child.kill("SIGTERM");
  }
}
