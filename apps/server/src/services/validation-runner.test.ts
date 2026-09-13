import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { ValidationCommand } from "../db/schema.js";
import { tokenizeCommand, ValidationRunner } from "./validation-runner.js";

const execFileAsync = promisify(execFile);

async function createRepositoryWithWorktree() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-validation-repo-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await execFileAsync("git", [
    "-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty", "-m", "Initial",
  ]);
  const worktreeParent = await mkdtemp(join(tmpdir(), "aiew-validation-worktree-"));
  const worktreePath = join(worktreeParent, "worktree");
  await execFileAsync("git", ["-C", repositoryPath, "worktree", "add", "-b", "aiew-validation-test", "--", worktreePath, "main"]);
  return worktreePath;
}

function command(overrides: Partial<ValidationCommand>): ValidationCommand {
  return { id: "cmd-1", label: "Test command", command: `${process.execPath} -e "process.exit(0)"`, ...overrides };
}

describe("ValidationRunner", () => {
  it("tokenizes whitespace and quoted segments without shell semantics", () => {
    expect(tokenizeCommand("php artisan test")).toEqual(["php", "artisan", "test"]);
    expect(tokenizeCommand(`node -e "console.log('hi there')"`)).toEqual(["node", "-e", "console.log('hi there')"]);
    expect(tokenizeCommand("  npm   run  prod  ")).toEqual(["npm", "run", "prod"]);
  });

  it("records a passing command as PASSED with its output and exit code", async () => {
    const worktreePath = await createRepositoryWithWorktree();
    const runner = new ValidationRunner();
    const results = await runner.run(worktreePath, "worktree-1", [
      command({ command: `${process.execPath} -e "process.stdout.write('ok'); process.exit(0)"` }),
    ], 10_000);
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.status).toBe("PASSED");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records a failing command as FAILED without throwing", async () => {
    const worktreePath = await createRepositoryWithWorktree();
    const runner = new ValidationRunner();
    const results = await runner.run(worktreePath, "worktree-1", [
      command({ command: `${process.execPath} -e "process.stderr.write('boom'); process.exit(1)"` }),
    ], 10_000);
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.status).toBe("FAILED");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("boom");
  });

  it("records a nonexistent command as ERROR without throwing", async () => {
    const worktreePath = await createRepositoryWithWorktree();
    const runner = new ValidationRunner();
    const results = await runner.run(worktreePath, "worktree-1", [
      command({ command: "aiew-this-command-does-not-exist-anywhere" }),
    ], 10_000);
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.status).toBe("ERROR");
  });

  it("runs multiple commands sequentially and records one row per command", async () => {
    const worktreePath = await createRepositoryWithWorktree();
    const runner = new ValidationRunner();
    const results = await runner.run(worktreePath, "worktree-1", [
      command({ id: "a", command: `${process.execPath} -e "process.exit(0)"` }),
      command({ id: "b", command: `${process.execPath} -e "process.exit(1)"` }),
    ], 10_000);
    expect(results.map((r) => r.commandId)).toEqual(["a", "b"]);
    expect(results.map((r) => r.status)).toEqual(["PASSED", "FAILED"]);
  });
});
