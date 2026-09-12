import { spawn } from "node:child_process";
import { sanitizeEnvironment } from "./environment.js";

export type CommandResult = { exitCode: number | null; stdout: string; stderr: string };

export function runCommand(command: string, args: string[], timeoutMs = 5_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: sanitizeEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", () => finish(null));
    child.on("close", finish);
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null);
    }, timeoutMs);
  });
}

export function firstLine(value: string): string | null {
  return value.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
}

