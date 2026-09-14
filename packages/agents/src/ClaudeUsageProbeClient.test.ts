import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_USAGE_PROBE_MODEL, ClaudeUsageProbeClient } from "./ClaudeUsageProbeClient.js";

/**
 * A fake `claude` executable that emits a stream-json `rate_limit_event` line, mirroring the real
 * CLI's `--output-format stream-json` shape (see usage-extraction.ts's `extractRateLimitReadings`).
 * It also records the args it was invoked with to a sibling file, so tests can assert the probe
 * requested the cheapest model and no session persistence without spawning the real CLI.
 */
async function createFakeClaudeExecutable(): Promise<{ executable: string; argsFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "aiew-fake-claude-usage-probe-"));
  const executable = join(dir, "claude");
  const argsFile = join(dir, "args.json");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));`,
    "console.log(JSON.stringify({",
    "  type: 'rate_limit_event',",
    "  rate_limit_info: { unifiedWindows: {",
    "    five_hour: { utilization: 0.18, resetsAt: 1_789_400_000 },",
    "    seven_day: { utilization: 0.33, resetsAt: 1_790_000_000 },",
    "  } },",
    "}));",
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  return { executable, argsFile };
}

describe("ClaudeUsageProbeClient", () => {
  it("extracts the 5-hour and weekly windows from a real rate_limit_event line", async () => {
    const { executable } = await createFakeClaudeExecutable();
    const readings = await new ClaudeUsageProbeClient(executable, 5_000).readRateLimits();
    expect(readings.map((entry) => [entry.windowId, entry.usedPercent])).toEqual([
      ["5H", 18], ["WEEKLY", 33],
    ]);
  });

  it("requests the cheapest model and never persists a session", async () => {
    const { executable, argsFile } = await createFakeClaudeExecutable();
    await new ClaudeUsageProbeClient(executable, 5_000).readRateLimits();
    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    expect(args[args.indexOf("--model") + 1]).toBe(CLAUDE_USAGE_PROBE_MODEL);
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("Bash");
  });

  it("fails with a bounded timeout instead of hanging when no reading is ever reported", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiew-silent-claude-usage-probe-"));
    const executable = join(directory, "claude");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdin.resume();\n", "utf8");
    await chmod(executable, 0o755);
    await expect(new ClaudeUsageProbeClient(executable, 100).readRateLimits()).rejects.toThrow(/within 100 ms/);
  });
});
