import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient, extractCodexAppServerRateLimits } from "./CodexAppServerClient.js";

async function createFakeAppServer(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aiew-fake-codex-app-server-"));
  const executable = join(directory, "codex");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const readline = require('node:readline');",
    "const lines = readline.createInterface({ input: process.stdin });",
    "lines.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));",
    "  if (message.method === 'account/rateLimits/read') console.log(JSON.stringify({",
    "    id: message.id,",
    "    result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 27, windowDurationMins: 300, resetsAt: 1789400000 }, secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: 1790000000 } } }",
    "  }));",
    "});",
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  return executable;
}

describe("CodexAppServerClient", () => {
  it("normalizes the documented primary and secondary quota windows", () => {
    expect(extractCodexAppServerRateLimits({
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_789_400_000 },
        secondary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_790_000_000 },
      },
    })).toEqual([
      {
        windowId: "5H", windowLabel: "5-hour usage window", windowDurationMs: 18_000_000,
        usedPercent: 25, resetAt: new Date(1_789_400_000_000).toISOString(),
      },
      {
        windowId: "WEEKLY", windowLabel: "weekly usage window", windowDurationMs: 604_800_000,
        usedPercent: 42, resetAt: new Date(1_790_000_000_000).toISOString(),
      },
    ]);
  });

  it("falls back to the codex multi-bucket entry and ignores invalid percentages", () => {
    expect(extractCodexAppServerRateLimits({
      rateLimitsByLimitId: {
        codex: {
          limitName: "Codex",
          primary: { used_percent: 51, window_minutes: 60, resets_at: 1_789_400_000 },
          secondary: { usedPercent: 101, windowDurationMins: 10_080 },
        },
      },
    })).toEqual([{
      windowId: "CODEX_PRIMARY_60", windowLabel: "Codex primary usage window", windowDurationMs: 3_600_000,
      usedPercent: 51, resetAt: new Date(1_789_400_000_000).toISOString(),
    }]);
  });

  it("performs the initialization handshake and reads rate limits over JSONL stdio", async () => {
    const executable = await createFakeAppServer();
    const readings = await new CodexAppServerClient(executable, 2_000).readRateLimits();
    expect(readings.map((entry) => [entry.windowId, entry.usedPercent])).toEqual([
      ["5H", 27], ["WEEKLY", 41],
    ]);
  });

  it("fails with a bounded timeout instead of hanging when the protocol does not answer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiew-silent-codex-app-server-"));
    const executable = join(directory, "codex");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdin.resume();\n", "utf8");
    await chmod(executable, 0o755);
    await expect(new CodexAppServerClient(executable, 100).readRateLimits()).rejects.toThrow(/within 100 ms/);
  });
});
