import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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

const VALID_FINDINGS = JSON.stringify({
  findings: [{
    severity: "MEDIUM", category: "MAINTAINABILITY", file: "feature.txt", startLine: 1, endLine: 1,
    title: "Consider a docstring", description: "The new file has no docstring.",
    evidence: "feature.txt line 1", impact: "Minor readability concern.",
    suggestedFix: "Add a short comment.", suggestedTest: null, confidence: "MEDIUM",
  }],
});

/**
 * A fake adapter that actually writes a file into input.cwd when playing the builder role (proving
 * it respects WORKTREE_WRITE scoping the same way a real CLI would), and returns findings JSON when
 * playing the reviewer role — never writing anything in that role.
 */
class FakeBuildAdapter implements AgentAdapter {
  constructor(
    readonly name: AgentProvider,
    private readonly options: { reviewerOutput?: string; builderDelayMs?: number } = {},
  ) {}

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
      if (input.permissionProfile !== "WORKTREE_WRITE") throw new Error("Builder must run WORKTREE_WRITE.");
      if (this.options.builderDelayMs) await new Promise((resolve) => setTimeout(resolve, this.options.builderDelayMs));
      await writeFile(join(input.cwd, "feature.txt"), "built by the fake builder\n", "utf8");
      yield { type: "stdout", runId: input.runId, occurredAt, chunk: "Added feature.txt." };
    } else if (input.promptVersion === "code-review:v1") {
      if (input.permissionProfile !== "READ_ONLY") throw new Error("Reviewer must run READ_ONLY.");
      yield { type: "stdout", runId: input.runId, occurredAt, chunk: this.options.reviewerOutput ?? VALID_FINDINGS };
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
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-build-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial",
  ]);
  const worktreeRoot = join(dirname(repositoryPath), `${repositoryPath.split("/").at(-1)}-worktrees`);
  return { repositoryPath, worktreeRoot };
}

async function acknowledgeUnknownUsage(app: ReturnType<typeof buildApp>) {
  for (const provider of ["CLAUDE", "CODEX"] as const) {
    await app.inject({
      method: "POST", url: "/api/usage/acknowledge",
      payload: { provider, status: "UNAVAILABLE", userAction: "PROCEED", reason: "No usage data yet in this test fixture." },
    });
  }
}

async function createTaskAndProject(
  app: ReturnType<typeof buildApp>,
  validationCommands: Array<{ label: string; command: string }>,
) {
  const { repositoryPath, worktreeRoot } = await createRepository();
  const project = (await app.inject({
    method: "POST", url: "/api/projects", payload: { repositoryPath, worktreeRoot, validationCommands },
  })).json();
  const task = (await app.inject({
    method: "POST", url: "/api/tasks",
    payload: {
      projectId: project.id, title: "Add a feature file", type: "BRAINSTORM", riskLevel: "LOW",
      problemStatement: "Add a small feature file to the repository.", webAccessPermitted: false,
    },
  })).json();
  return { repositoryPath, project, task };
}

async function pollUntilTerminal(app: ReturnType<typeof buildApp>, buildRunId: string) {
  let build;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    build = (await app.inject({ method: "GET", url: `/api/builds/${buildRunId}` })).json();
    if (["COMPLETED", "FAILED", "CANCELLED", "CHECKPOINTED"].includes(build.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return build;
}

describe("build routes", () => {
  it("builds inside its own worktree only, records validation honestly, snapshots the diff once, and persists reviewer findings", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeBuildAdapter("CLAUDE", { builderDelayMs: 60 }), new FakeBuildAdapter("CODEX")],
    });
    apps.push(app);
    const passing = `${process.execPath} -e "process.exit(0)"`;
    const failing = `${process.execPath} -e "process.stderr.write('boom'); process.exit(1)"`;
    const { repositoryPath, task } = await createTaskAndProject(app, [
      { label: "Passing check", command: passing },
      { label: "Failing check", command: failing },
    ]);
    await acknowledgeUnknownUsage(app);

    const startResponse = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/builds`,
      payload: { builderProvider: "CLAUDE", reviewerProvider: "CODEX" },
    });
    expect(startResponse.statusCode).toBe(202);
    const { buildRunId } = startResponse.json();

    // While the builder is still running (delayed on purpose), the worktree lease should be held.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const midRunBuild = (await app.inject({ method: "GET", url: `/api/builds/${buildRunId}` })).json();
    if (midRunBuild.worktreeId) {
      const midRunWorktree = (await app.inject({ method: "GET", url: `/api/worktrees/${midRunBuild.worktreeId}` })).json();
      expect(midRunWorktree.inUse).toBe(true);
    }

    const build = await pollUntilTerminal(app, buildRunId);
    expect(build.status).toBe("COMPLETED");
    expect(build.errorMessage).toBeNull();

    // The builder's change landed only in its own worktree; the source checkout stayed untouched.
    const worktree = (await app.inject({ method: "GET", url: `/api/worktrees/${build.worktreeId}` })).json();
    const builtFile = await readFile(join(worktree.path, "feature.txt"), "utf8");
    expect(builtFile).toContain("built by the fake builder");
    const sourceStatus = await execFileAsync("git", ["-C", repositoryPath, "status", "--porcelain=v1"]);
    expect(sourceStatus.stdout).toBe("");

    // Validation is recorded honestly, including the failing command, and review still proceeded.
    expect(build.validationRuns.map((run: { status: string }) => run.status)).toEqual(["PASSED", "FAILED"]);
    expect(build.validationRuns[1].exitCode).toBe(1);
    expect(build.validationRuns[1].stderr).toContain("boom");

    // The diff is a one-time snapshot: touching the worktree afterward doesn't change what was recorded.
    expect(build.diffStaged).toContain("feature.txt");
    await writeFile(join(worktree.path, "another-file.txt"), "post-hoc change\n", "utf8");
    const diffAfter = (await app.inject({ method: "GET", url: `/api/builds/${buildRunId}/diff` })).json();
    expect(diffAfter.staged).toBe(build.diffStaged);

    // The reviewer never wrote to the worktree: only feature.txt (from the builder) is untracked/dirty.
    const reviewedWorktreeStatus = await execFileAsync("git", ["-C", worktree.path, "status", "--porcelain=v1", "--untracked-files=all"]);
    const dirtyPaths = reviewedWorktreeStatus.stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).at(-1));
    expect(dirtyPaths).toEqual(expect.arrayContaining(["feature.txt", "another-file.txt"]));
    expect(dirtyPaths).toHaveLength(2);

    // Findings persisted with server-assigned id/status, matching the fake reviewer's JSON.
    expect(build.findings).toHaveLength(1);
    expect(build.findings[0]).toMatchObject({ severity: "MEDIUM", category: "MAINTAINABILITY", status: "OPEN" });
    expect(typeof build.findings[0].id).toBe("string");

    // The lease is released once the build reaches a terminal state.
    const finalWorktree = (await app.inject({ method: "GET", url: `/api/worktrees/${build.worktreeId}` })).json();
    expect(finalWorktree.inUse).toBe(false);
  });

  it("rejects starting a build when the builder and reviewer are the same provider", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [new FakeBuildAdapter("CLAUDE"), new FakeBuildAdapter("CODEX")] });
    apps.push(app);
    const { task } = await createTaskAndProject(app, []);
    const response = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/builds`,
      payload: { builderProvider: "CLAUDE", reviewerProvider: "CLAUDE" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("different providers");
  });

  it("fails the build when the reviewer's response cannot be parsed, but still retains the raw output", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeBuildAdapter("CLAUDE"), new FakeBuildAdapter("CODEX", { reviewerOutput: "not json at all" })],
    });
    apps.push(app);
    const { task } = await createTaskAndProject(app, []);
    await acknowledgeUnknownUsage(app);

    const startResponse = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/builds`,
      payload: { builderProvider: "CLAUDE", reviewerProvider: "CODEX" },
    });
    const build = await pollUntilTerminal(app, startResponse.json().buildRunId);
    expect(build.status).toBe("FAILED");
    expect(build.errorMessage).toContain("could not be parsed");
    expect(build.findings).toEqual([]);
    expect(build.reviewArtifact.rawOutput).toContain("not json at all");
    expect(build.reviewArtifact.parseError).toBeTruthy();
    expect(build.reviewArtifact.structuredData).toBeNull();
  });
});
