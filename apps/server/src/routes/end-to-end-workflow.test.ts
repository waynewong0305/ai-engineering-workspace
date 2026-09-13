import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter, AgentEvent, AgentHealth, AgentProvider, AgentRunInput } from "@aiew/agents";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const execFileAsync = promisify(execFile);
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function analysisJson(provider: AgentProvider) {
  return JSON.stringify({
    summary: `${provider} summary`, facts: ["The service currently has one shared database."],
    assumptions: ["Traffic will keep growing."], unknowns: ["What is the peak write rate?"],
    options: [{
      name: "Option A", description: "A candidate approach.",
      advantages: ["Simple to operate"], disadvantages: ["Limited headroom"], risks: ["Vendor lock-in"],
    }],
    recommendedExperiments: ["Run a load test against a staging replica."], recommendation: null,
  });
}

function reviewJson(provider: AgentProvider) {
  return JSON.stringify({
    summary: `${provider} review`, agreements: ["Both agree the load test is worthwhile."],
    disagreements: [], factualErrors: [], unsupportedAssumptions: [], missingFailureCases: [],
    hiddenOperationalCosts: [], migrationRisks: [], openQuestions: [], missingEvidence: [],
    recommendedExperiments: [],
  });
}

class FakeAdapter implements AgentAdapter {
  constructor(readonly name: AgentProvider) {}

  async healthCheck(): Promise<AgentHealth> {
    return {
      provider: this.name, available: true, authenticated: true, cliVersion: `fake-${this.name.toLowerCase()} 1.0`,
      capabilities: { structuredOutput: true, sessionResume: false, dynamicModelDiscovery: false, availableModels: null, availableEffortLevels: null },
    };
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const occurredAt = new Date().toISOString();
    yield { type: "started", runId: input.runId, occurredAt };
    if (input.promptVersion === "build:v1") {
      await writeFile(join(input.cwd, "shard-resolver.txt"), "resolves tenants to shards\n", "utf8");
      yield { type: "stdout", runId: input.runId, occurredAt, chunk: "Added shard-resolver.txt." };
    } else if (input.promptVersion === "code-review:v1") {
      yield {
        type: "stdout", runId: input.runId, occurredAt,
        chunk: JSON.stringify({
          findings: [{
            severity: "LOW", category: "TESTING", file: "shard-resolver.txt", startLine: 1, endLine: 1,
            title: "Add a unit test", description: "The new resolver has no test coverage yet.",
            evidence: "shard-resolver.txt line 1", impact: "Regressions could go unnoticed.",
            suggestedFix: null, suggestedTest: "Add a resolver unit test.", confidence: "MEDIUM",
          }],
        }),
      };
    } else {
      const output = input.promptVersion.startsWith("brainstorm") ? analysisJson(this.name) : reviewJson(this.name);
      yield { type: "stdout", runId: input.runId, occurredAt, chunk: output };
    }
    yield {
      type: "completed", runId: input.runId, occurredAt, exitCode: 0,
      metadata: {
        provider: this.name, requestedModel: input.model.requested, actualModel: `fake-${this.name.toLowerCase()}`,
        effort: null, cliVersion: `fake-${this.name.toLowerCase()} 1.0`, promptVersion: input.promptVersion,
        webAccessPermitted: input.webAccess.permitted === true,
      },
    };
  }

  async cancel() {}
}

async function createRepository() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-e2e-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial",
  ]);
  const worktreeRoot = join(dirname(repositoryPath), `${repositoryPath.split("/").at(-1)}-worktrees`);
  return { repositoryPath, worktreeRoot };
}

describe("full workflow: registration -> brainstorm -> worktree isolation -> cleanup", () => {
  it("walks the entire currently-implemented pipeline start to end without spending real provider usage", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [new FakeAdapter("CLAUDE"), new FakeAdapter("CODEX")] });
    apps.push(app);
    const { repositoryPath, worktreeRoot } = await createRepository();

    // 1. Register the project read-only.
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath, worktreeRoot, name: "End-to-end fixture" },
    })).json();
    expect(project.gitStatus).toBe("CLEAN");

    // 2. Tool health is reachable and the local database is connected.
    const health = (await app.inject({ method: "GET", url: "/api/health" })).json();
    expect(health.status).toBe("ok");
    expect(health.database).toBe("connected");

    // 3. Draft a brainstorm task with an explicit web-access decision. Drafting never spends usage.
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "End-to-end pipeline check", type: "ARCHITECTURE", riskLevel: "MEDIUM",
        problemStatement: "Prove the full pipeline works together, start to end.", webAccessPermitted: false,
      },
    })).json();
    expect(task.status).toBe("DRAFT");

    // 4. Usage safety refuses to start a combined workflow blind; acknowledge, then it proceeds.
    const blockedStart = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, payload: {} });
    expect(blockedStart.statusCode).toBe(409);
    expect(blockedStart.json().code).toBe("USAGE_CHECKPOINT");
    for (const provider of ["CLAUDE", "CODEX"] as const) {
      const ack = await app.inject({
        method: "POST", url: "/api/usage/acknowledge",
        payload: { provider, status: "UNAVAILABLE", userAction: "PROCEED", reason: "End-to-end fixture has no usage data." },
      });
      expect(ack.statusCode).toBe(201);
    }

    // 5. Start independent analyses; cross-review follows automatically once both complete.
    const started = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, payload: {} });
    expect(started.statusCode).toBe(202);

    let detail: { status: string; runs: unknown[]; comparison: { consensus: string[] }; evidence: unknown[] } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
      if (["READY", "FAILED", "CHECKPOINTED"].includes(detail!.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(detail!.status).toBe("READY");
    expect(detail!.runs).toHaveLength(4);
    expect(detail!.comparison.consensus).toContain("Both agree the load test is worthwhile.");
    expect(detail!.evidence.length).toBeGreaterThan(0);

    // 6. Promote the approved analysis into isolated Claude/Codex worktrees.
    const preview = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees/preview` })).json();
    expect(preview.proposals.every((proposal: { available: boolean }) => proposal.available)).toBe(true);

    const worktrees: Array<{ id: string; path: string }> = [];
    for (const proposal of preview.proposals) {
      const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: proposal });
      expect(response.statusCode).toBe(201);
      worktrees.push(response.json());
    }

    // 7. Isolation: both task worktrees plus the source checkout, and the source checkout untouched.
    const managed = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/worktrees` })).json();
    expect(managed.gitWorktrees).toHaveLength(3);
    expect(managed.managed.every((entry: { inspection: { gitStatus: string } | null }) => entry.inspection?.gitStatus === "CLEAN")).toBe(true);
    const sourceStatus = await execFileAsync("git", ["-C", repositoryPath, "status", "--porcelain=v1"]);
    expect(sourceStatus.stdout).toBe("");

    // 8. Build and review, reusing the already-created Claude worktree: Claude changes the sample
    // repository, Codex reviews the diff without editing Claude's worktree, and Claude's findings
    // are reachable via the API — the Phase 5 acceptance bar itself.
    const buildStart = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/builds`,
      payload: { builderProvider: "CLAUDE", reviewerProvider: "CODEX" },
    });
    expect(buildStart.statusCode).toBe(202);
    const { buildRunId } = buildStart.json();
    let build: { status: string; worktreeId: string; findings: unknown[] } | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      build = (await app.inject({ method: "GET", url: `/api/builds/${buildRunId}` })).json();
      if (["COMPLETED", "FAILED", "CHECKPOINTED"].includes(build!.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(build!.status).toBe("COMPLETED");
    // Reused the existing Claude worktree from step 6 rather than creating a fourth one.
    expect(worktrees.some((worktree) => worktree.id === build!.worktreeId)).toBe(true);
    const findings = (await app.inject({ method: "GET", url: `/api/builds/${buildRunId}/findings` })).json();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: "TESTING", status: "OPEN" });
    const stillThreeWorktrees = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/worktrees` })).json();
    expect(stillThreeWorktrees.gitWorktrees).toHaveLength(3);

    // 8b. The builder left an uncommitted change in its worktree: removal must still refuse to
    // discard it, exactly like any other dirty worktree — a build never bypasses this safety rule.
    const blockedRemoval = await app.inject({ method: "DELETE", url: `/api/worktrees/${build!.worktreeId}`, payload: { confirm: true } });
    expect(blockedRemoval.statusCode).toBe(409);
    expect(blockedRemoval.json().code).toBe("WORKTREE_DIRTY");

    // A human commits the reviewed change (the merge workflow itself is a later Phase 5 slice, out
    // of scope here) so the existing cleanup flow below can proceed exactly as it did before builds existed.
    const builderWorktree = worktrees.find((worktree) => worktree.id === build!.worktreeId)!;
    await execFileAsync("git", ["-C", builderWorktree.path, "add", "-A"]);
    await execFileAsync("git", [
      "-C", builderWorktree.path, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "-m", "Add shard resolver",
    ]);

    // 9. Deregistration is refused while managed worktrees remain linked.
    const blockedDeregister = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(blockedDeregister.statusCode).toBe(409);
    expect(blockedDeregister.json().code).toBe("WORKTREES_LINKED");

    // 10. Clean up each worktree; deregistration then succeeds.
    for (const worktree of worktrees) {
      const removal = await app.inject({
        method: "DELETE", url: `/api/worktrees/${worktree.id}`, payload: { confirm: true, deleteBranch: false },
      });
      expect(removal.statusCode).toBe(200);
    }
    const finalDeregister = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}` });
    expect(finalDeregister.statusCode).toBe(204);

    // 11. Usage was never fabricated: the only state on record is the human acknowledgement from step 4.
    const usage = (await app.inject({ method: "GET", url: "/api/usage" })).json();
    expect(usage.CLAUDE[0]).toMatchObject({ status: "UNAVAILABLE", usedPercent: null, source: null });
    expect(usage.CODEX[0]).toMatchObject({ status: "UNAVAILABLE", usedPercent: null, source: null });
    const audit = (await app.inject({ method: "GET", url: "/api/usage/audit" })).json();
    expect(audit.filter((entry: { eventType: string }) => entry.eventType === "ACKNOWLEDGEMENT")).toHaveLength(2);
  });
});
