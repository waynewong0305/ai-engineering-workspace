import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAdapter } from "./CodexAdapter.js";
import { ProcessSupervisor, type SupervisedProcessEvent, type SupervisedProcessInput } from "./ProcessSupervisor.js";
import type { AgentRunInput } from "./types.js";

/**
 * A fake `codex` executable that answers --version/login status deterministically, so healthCheck()
 * never depends on (or spawns) whatever real Codex CLI happens to be installed on the test machine.
 */
async function createFakeCodexExecutable(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aiew-fake-codex-"));
  const path = join(dir, "codex");
  await writeFile(path, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('9.9.9-test'); process.exit(0); }",
    "if (args[0] === 'login' && args[1] === 'status') { process.exit(0); }",
    "process.exit(0);",
  ].join("\n"), "utf8");
  await chmod(path, 0o755);
  return path;
}

class CapturingSupervisor extends ProcessSupervisor {
  public lastInput: SupervisedProcessInput | null = null;

  async *run(input: SupervisedProcessInput): AsyncIterable<SupervisedProcessEvent> {
    this.lastInput = input;
    const occurredAt = new Date().toISOString();
    yield { type: "started", occurredAt, pid: null };
    yield { type: "exited", occurredAt, exitCode: 0, durationMs: 1 };
  }
}

const baseInput: Omit<AgentRunInput, "permissionProfile"> = {
  runId: "run-1",
  cwd: process.cwd(),
  prompt: "Do the thing.",
  promptVersion: "test:v1",
  webAccess: { policy: "DISABLED", permitted: false },
  outputFormat: "JSONL",
  timeoutMs: 5_000,
  environment: {},
  model: { requested: "(provider default)" },
};

describe("CodexAdapter", () => {
  it("uses the read-only sandbox for READ_ONLY", async () => {
    const executable = await createFakeCodexExecutable();
    const supervisor = new CapturingSupervisor();
    const adapter = new CodexAdapter(supervisor, executable);
    const events = [];
    for await (const event of adapter.run({ ...baseInput, permissionProfile: "READ_ONLY" })) events.push(event);

    expect(events.at(-1)?.type).toBe("completed");
    const args = supervisor.lastInput!.args;
    expect(args[args.indexOf("-s") + 1]).toBe("read-only");
    expect(args).not.toContain("--ask-for-approval");
  });

  it("uses the workspace-write sandbox and routes approval through automatic review for WORKTREE_WRITE", async () => {
    const executable = await createFakeCodexExecutable();
    const supervisor = new CapturingSupervisor();
    const adapter = new CodexAdapter(supervisor, executable);
    const events = [];
    for await (const event of adapter.run({ ...baseInput, permissionProfile: "WORKTREE_WRITE" })) events.push(event);

    expect(events.at(-1)?.type).toBe("completed");
    const args = supervisor.lastInput!.args;
    expect(args[args.indexOf("-s") + 1]).toBe("workspace-write");
    expect(args).toContain("--approve-for-me");
    expect(args).not.toContain("--ask-for-approval");
  });

  it("refuses a TEST_ONLY run", async () => {
    const executable = await createFakeCodexExecutable();
    const supervisor = new CapturingSupervisor();
    const adapter = new CodexAdapter(supervisor, executable);
    await expect(async () => {
      for await (const _ of adapter.run({ ...baseInput, permissionProfile: "TEST_ONLY" })) { /* draining triggers validation */ }
    }).rejects.toThrow(/READ_ONLY and WORKTREE_WRITE/);
  });
});
