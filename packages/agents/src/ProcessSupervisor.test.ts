import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ProcessSupervisor } from "./ProcessSupervisor.js";

const execFileAsync = promisify(execFile);

async function createRepositoryWithWorktree() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-supervisor-repo-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await execFileAsync("git", [
    "-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty", "-m", "Initial",
  ]);
  const worktreeParent = await mkdtemp(join(tmpdir(), "aiew-supervisor-worktree-"));
  const worktreePath = join(worktreeParent, "worktree");
  await execFileAsync("git", ["-C", repositoryPath, "worktree", "add", "-b", "aiew-supervisor-test", "--", worktreePath, "main"]);
  return { repositoryPath, worktreePath };
}

describe("ProcessSupervisor", () => {
  it("streams stdout, stderr, and a successful exit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aiew-supervisor-"));
    const supervisor = new ProcessSupervisor();
    const events = [];
    for await (const event of supervisor.run({
      runId: "success",
      command: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      cwd,
      permissionProfile: "READ_ONLY",
      timeoutMs: 5_000,
    })) events.push(event);

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes[0]).toBe("started");
    expect(eventTypes).toContain("stdout");
    expect(eventTypes).toContain("stderr");
    expect(eventTypes.at(-1)).toBe("exited");
  });

  it("times out a long-running process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aiew-supervisor-"));
    const supervisor = new ProcessSupervisor();
    const events = [];
    for await (const event of supervisor.run({
      runId: "timeout",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd,
      permissionProfile: "READ_ONLY",
      timeoutMs: 1_000,
    })) events.push(event);

    expect(events.at(-1)?.type).toBe("timed_out");
  });

  it("cancels an active process", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aiew-supervisor-"));
    const supervisor = new ProcessSupervisor();
    const events = [];
    for await (const event of supervisor.run({
      runId: "cancel",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd,
      permissionProfile: "READ_ONLY",
      timeoutMs: 5_000,
    })) {
      events.push(event);
      if (event.type === "started") await supervisor.cancel("cancel");
    }

    expect(events.at(-1)?.type).toBe("cancelled");
  });

  it("force-kills a cancelled process group when the parent and child ignore SIGTERM", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aiew-supervisor-"));
    const supervisor = new ProcessSupervisor(50);
    const childProgram = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
    const parentProgram = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { stdio: 'ignore' });`,
      "process.stdout.write(String(child.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const events = [];
    let descendantPid: number | null = null;

    for await (const event of supervisor.run({
      runId: "cancel-tree",
      command: process.execPath,
      args: ["-e", parentProgram],
      cwd,
      permissionProfile: "READ_ONLY",
      timeoutMs: 5_000,
    })) {
      events.push(event);
      if (event.type === "stdout") {
        descendantPid = Number.parseInt(event.chunk, 10);
        await supervisor.cancel("cancel-tree");
      }
    }

    expect(events.at(-1)?.type).toBe("cancelled");
    expect(descendantPid).not.toBeNull();
    let descendantAlive = true;
    for (let attempt = 0; attempt < 20 && descendantAlive; attempt += 1) {
      try {
        process.kill(descendantPid!, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        descendantAlive = false;
      }
    }
    expect(descendantAlive).toBe(false);
  });

  it("force-kills a timed-out process that ignores SIGTERM", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aiew-supervisor-"));
    const supervisor = new ProcessSupervisor(50);
    const events = [];
    const startedAt = Date.now();
    for await (const event of supervisor.run({
      runId: "timeout-force-kill",
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      cwd,
      permissionProfile: "READ_ONLY",
      timeoutMs: 1_000,
    })) events.push(event);

    expect(events.at(-1)?.type).toBe("timed_out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("permits WORKTREE_WRITE/TEST_ONLY inside a real Git worktree, and refuses them against a primary checkout", async () => {
    const { repositoryPath, worktreePath } = await createRepositoryWithWorktree();
    const supervisor = new ProcessSupervisor();

    for (const permissionProfile of ["WORKTREE_WRITE", "TEST_ONLY"] as const) {
      const events = [];
      for await (const event of supervisor.run({
        runId: `${permissionProfile}-worktree`,
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: worktreePath,
        permissionProfile,
        timeoutMs: 5_000,
      })) events.push(event);
      expect(events.at(-1)?.type).toBe("exited");
    }

    for (const permissionProfile of ["WORKTREE_WRITE", "TEST_ONLY"] as const) {
      await expect(async () => {
        for await (const _ of supervisor.run({
          runId: `${permissionProfile}-primary`,
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          cwd: repositoryPath,
          permissionProfile,
          timeoutMs: 5_000,
        })) { /* draining is enough to trigger the synchronous validation */ }
      }).rejects.toThrow(/only run inside a Git worktree/);
    }

    // READ_ONLY is unaffected by the worktree-vs-checkout distinction.
    const readOnlyEvents = [];
    for await (const event of supervisor.run({
      runId: "read-only-primary",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: repositoryPath,
      permissionProfile: "READ_ONLY",
      timeoutMs: 5_000,
    })) readOnlyEvents.push(event);
    expect(readOnlyEvents.at(-1)?.type).toBe("exited");
  });
});
