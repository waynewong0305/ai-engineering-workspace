// Exercises checkAgentPolicy against fixture directories under the OS temp dir — never against
// this repository's real AGENTS.md/CLAUDE.md — so the checker's own logic has automated coverage
// instead of only having been verified manually.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { checkAgentPolicy } from "./check-agent-policy.mjs";

const dirs = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "aiew-agent-policy-"));
  dirs.push(dir);
  return dir;
}

function writeValidPair(dir, content = "# Agent Policy\n\nBe careful.\n") {
  writeFileSync(join(dir, "AGENTS.md"), content, "utf8");
  symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
}

after(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("checkAgentPolicy", () => {
  it("passes for a canonical AGENTS.md with CLAUDE.md as a correct relative symlink", () => {
    const dir = fixture();
    writeValidPair(dir);
    const result = checkAgentPolicy(dir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.failures, []);
  });

  it("fails when AGENTS.md is missing", () => {
    const dir = fixture();
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    const result = checkAgentPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /AGENTS\.md does not exist/);
  });

  it("fails when CLAUDE.md is missing", () => {
    const dir = fixture();
    writeFileSync(join(dir, "AGENTS.md"), "# Agent Policy\n", "utf8");
    const result = checkAgentPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /CLAUDE\.md does not exist/);
  });

  it("fails when CLAUDE.md is a duplicated regular file instead of a symlink", () => {
    const dir = fixture();
    writeFileSync(join(dir, "AGENTS.md"), "# Agent Policy\n", "utf8");
    writeFileSync(join(dir, "CLAUDE.md"), "# Agent Policy\n", "utf8");
    const result = checkAgentPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /must be a symbolic link/);
  });

  it("fails when CLAUDE.md's symlink target is not exactly \"AGENTS.md\"", () => {
    const dir = fixture();
    writeFileSync(join(dir, "AGENTS.md"), "# Agent Policy\n", "utf8");
    writeFileSync(join(dir, "OTHER.md"), "# Agent Policy\n", "utf8");
    symlinkSync("OTHER.md", join(dir, "CLAUDE.md"));
    const result = checkAgentPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /target exactly "AGENTS\.md"/);
  });

  it("fails when AGENTS.md is itself a symlink rather than a regular file", () => {
    const dir = fixture();
    writeFileSync(join(dir, "REAL.md"), "# Agent Policy\n", "utf8");
    symlinkSync("REAL.md", join(dir, "AGENTS.md"));
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    const result = checkAgentPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /must be a regular file, not a symlink/);
  });

  it("fails when the policy contains a secret-shaped string", () => {
    const dir = fixture();
    writeValidPair(dir, "# Agent Policy\n\napi_key: sk-abcdefghijklmnopqrstuvwxyz\n");
    const result = checkAgentPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /appears to contain a secret/);
  });

  it("fails when the policy contains a literal, soon-stale usage percentage", () => {
    const dir = fixture();
    writeValidPair(dir, "# Agent Policy\n\nClaude is currently at 42% used for this session.\n");
    const result = checkAgentPolicy(dir);
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /literal, soon-stale usage percentage|literal usage percentage/);
  });

  it("does not flag ordinary prose that merely mentions percentages or the word \"key\" in an unrelated sense", () => {
    const dir = fixture();
    writeValidPair(dir, "# Agent Policy\n\nThe warning threshold defaults to 75% and the checkpoint threshold to 90%. A key requirement is honesty.\n");
    const result = checkAgentPolicy(dir);
    assert.equal(result.ok, true);
  });
});
