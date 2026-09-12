import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessSupervisor } from "./ProcessSupervisor.js";

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
});
