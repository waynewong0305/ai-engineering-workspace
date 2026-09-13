import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./ClaudeAdapter.js";
import { ProcessSupervisor, type SupervisedProcessEvent, type SupervisedProcessInput } from "./ProcessSupervisor.js";
import type { AgentRunInput } from "./types.js";

/**
 * A fake `claude` executable that answers --version/auth status deterministically, so healthCheck()
 * never depends on (or spawns) whatever real Claude CLI happens to be installed on the test machine.
 */
async function createFakeClaudeExecutable(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "aiew-fake-claude-"));
  const path = join(dir, "claude");
  await writeFile(path, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') { console.log('9.9.9-test'); process.exit(0); }",
    "if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }",
    "process.exit(0);",
  ].join("\n"), "utf8");
  await chmod(path, 0o755);
  return path;
}

/** Captures the SupervisedProcessInput each run() call actually constructs, without spawning anything. */
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

describe("ClaudeAdapter", () => {
  it("uses plan mode and a read-only tool list for READ_ONLY", async () => {
    const executable = await createFakeClaudeExecutable();
    const supervisor = new CapturingSupervisor();
    const adapter = new ClaudeAdapter(supervisor, executable);
    const events = [];
    for await (const event of adapter.run({ ...baseInput, permissionProfile: "READ_ONLY" })) events.push(event);

    expect(events.at(-1)?.type).toBe("completed");
    const args = supervisor.lastInput!.args;
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    const tools = args[args.indexOf("--tools") + 1];
    expect(tools).toBe("Read,Glob,Grep");
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Bash");
  });

  it("uses acceptEdits and adds Edit/Write (never Bash) for WORKTREE_WRITE", async () => {
    const executable = await createFakeClaudeExecutable();
    const supervisor = new CapturingSupervisor();
    const adapter = new ClaudeAdapter(supervisor, executable);
    const events = [];
    for await (const event of adapter.run({ ...baseInput, permissionProfile: "WORKTREE_WRITE" })) events.push(event);

    expect(events.at(-1)?.type).toBe("completed");
    const args = supervisor.lastInput!.args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    const tools = args[args.indexOf("--tools") + 1];
    expect(tools).toBe("Read,Glob,Grep,Edit,Write");
    expect(tools).not.toContain("Bash");
    // --restricted stays present in both modes: it confines the file tools to the given cwd.
    expect(args).toContain("--restricted");
  });

  it("passes a full mcpServers shape, not a bare object, to --mcp-config", async () => {
    // Re-verified against the installed CLI (2.1.269) during Phase 8: a bare "{}" is rejected
    // ("Invalid MCP configuration: mcpServers: Invalid input") — regression test for that fix.
    const executable = await createFakeClaudeExecutable();
    const supervisor = new CapturingSupervisor();
    const adapter = new ClaudeAdapter(supervisor, executable);
    const events = [];
    for await (const event of adapter.run({ ...baseInput, permissionProfile: "READ_ONLY" })) events.push(event);

    const args = supervisor.lastInput!.args;
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  });

  it("refuses a TEST_ONLY run", async () => {
    const executable = await createFakeClaudeExecutable();
    const supervisor = new CapturingSupervisor();
    const adapter = new ClaudeAdapter(supervisor, executable);
    await expect(async () => {
      for await (const _ of adapter.run({ ...baseInput, permissionProfile: "TEST_ONLY" })) { /* draining triggers validation */ }
    }).rejects.toThrow(/READ_ONLY and WORKTREE_WRITE/);
  });
});
