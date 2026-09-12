import { spawn } from "node:child_process";

export type ToolHealth = {
  available: boolean;
  version: string | null;
  authenticated?: boolean | null;
};

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

function runCommand(command: string, args: string[], timeoutMs = 5_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve({ exitCode: null, stdout, stderr });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function firstLine(value: string): string | null {
  return value.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
}

async function inspectVersion(command: string, args = ["--version"]): Promise<ToolHealth> {
  const result = await runCommand(command, args);
  return {
    available: result.exitCode === 0,
    version: result.exitCode === 0 ? firstLine(result.stdout || result.stderr) : null,
  };
}

export async function inspectLocalTools() {
  const [git, claude, codex] = await Promise.all([
    inspectVersion("git"),
    inspectVersion("claude"),
    inspectVersion("codex"),
  ]);

  if (codex.available) {
    const login = await runCommand("codex", ["login", "status"]);
    codex.authenticated = login.exitCode === 0;
  }

  return { git, claude, codex };
}

