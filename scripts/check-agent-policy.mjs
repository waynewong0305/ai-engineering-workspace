#!/usr/bin/env node
// Verifies that AGENTS.md and CLAUDE.md always expose exactly the same LLM agent policy: AGENTS.md
// is the canonical tracked file, and CLAUDE.md is a relative symbolic link to it. This is meant to
// fail loudly (non-zero exit) if the link is ever replaced with a duplicated file, pointed
// elsewhere, or goes stale relative to its target, and if the policy accidentally picks up a
// secret or a temporary usage reading that would rot the moment it was written.
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure, side-effect-free check: given a repository root, return every failure found (empty when
 * the policy is in sync). Exported so it can be exercised against a fixture directory in
 * check-agent-policy.test.mjs without touching this repository's real AGENTS.md/CLAUDE.md.
 */
export function checkAgentPolicy(root) {
  const agentsPath = join(root, "AGENTS.md");
  const claudePath = join(root, "CLAUDE.md");
  const failures = [];
  const fail = (message) => failures.push(message);

  let agentsStat;
  try {
    agentsStat = lstatSync(agentsPath);
  } catch {
    fail(`AGENTS.md does not exist at ${agentsPath}.`);
  }
  if (agentsStat && (!agentsStat.isFile() || agentsStat.isSymbolicLink())) {
    fail("AGENTS.md must be a regular file, not a symlink or directory.");
  }

  let claudeStat;
  try {
    claudeStat = lstatSync(claudePath);
  } catch {
    fail(`CLAUDE.md does not exist at ${claudePath}.`);
  }
  if (claudeStat && !claudeStat.isSymbolicLink()) {
    fail("CLAUDE.md must be a symbolic link to AGENTS.md, not a regular file. Do not maintain two independently editable copies.");
  }

  if (claudeStat?.isSymbolicLink()) {
    const target = readlinkSync(claudePath);
    if (target !== "AGENTS.md") {
      fail(`CLAUDE.md must be a relative symlink with target exactly "AGENTS.md" (found "${target}").`);
    }
  }

  if (agentsStat?.isFile() && claudeStat?.isSymbolicLink()) {
    try {
      const agentsReal = realpathSync(agentsPath);
      const claudeReal = realpathSync(claudePath);
      if (agentsReal !== claudeReal) {
        fail("AGENTS.md and CLAUDE.md do not resolve to the same canonical file.");
      }
    } catch (error) {
      fail(`Could not resolve both paths to a canonical file: ${error instanceof Error ? error.message : error}`);
    }

    const agentsBytes = readFileSync(agentsPath);
    const claudeBytes = readFileSync(claudePath);
    if (!agentsBytes.equals(claudeBytes)) {
      fail("AGENTS.md and CLAUDE.md do not contain identical bytes (cmp -s equivalent failed).");
    }

    const text = agentsBytes.toString("utf8");
    const secretPatterns = [
      { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, message: "a private key block" },
      { pattern: /\b(api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*\S+/i, message: "what looks like a credential assignment" },
      { pattern: /\bAKIA[0-9A-Z]{16}\b/, message: "what looks like an AWS access key ID" },
      { pattern: /\bsk-[A-Za-z0-9]{20,}\b/, message: "what looks like a provider API key" },
    ];
    for (const { pattern, message } of secretPatterns) {
      if (pattern.test(text)) fail(`The policy appears to contain a secret (${message}). Remove it before committing.`);
    }

    const temporaryReadingPatterns = [
      { pattern: /\b\d{1,3}(?:\.\d+)?%\s*(used|remaining|utilization|utilised)\b/i, message: "a literal usage percentage" },
      { pattern: /\bcurrent (?:usage|session) (?:is|was|reads?)\b/i, message: "a temporary usage/session reading" },
    ];
    for (const { pattern, message } of temporaryReadingPatterns) {
      if (pattern.test(text)) {
        fail(`The policy appears to contain ${message}. Link to IMPLEMENTATION_STATUS.md instead of duplicating a value that will go stale.`);
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { ok, failures } = checkAgentPolicy(root);
  if (!ok) {
    console.error("Agent policy check failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error("\nAGENTS.md is the canonical policy file; CLAUDE.md must be a relative symlink to it (`ln -sf AGENTS.md CLAUDE.md`).");
    process.exit(1);
  }
  console.log("Agent policy check passed: AGENTS.md and CLAUDE.md are in sync.");
}
