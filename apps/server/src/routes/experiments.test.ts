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

const VALID_VERDICT = JSON.stringify({
  verdict: "PROVEN",
  reasoning: "The diff adds a shard-routing prototype and the builder ran it against three sample tenants.",
  result: "Requests for all three sample tenants routed to the expected shard.",
  conclusion: "Explicit tenant-to-shard mapping is technically feasible with this driver.",
});

/** Fake adapter mirroring FakeBuildAdapter's shape but for the experiment prompt versions. */
class FakeExperimentAdapter implements AgentAdapter {
  constructor(
    readonly name: AgentProvider,
    private readonly options: { reviewerOutput?: string } = {},
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
    if (input.promptVersion === "experiment-builder:v1") {
      if (input.permissionProfile !== "WORKTREE_WRITE") throw new Error("Builder must run WORKTREE_WRITE.");
      await writeFile(join(input.cwd, "shard_router.py"), "def route(tenant_id):\n    return tenant_id % 3\n", "utf8");
      yield { type: "stdout", runId: input.runId, occurredAt, chunk: "Implemented a minimal shard router and ran it against 3 sample tenant IDs; all resolved to distinct shards." };
    } else if (input.promptVersion === "experiment-reviewer:v1") {
      if (input.permissionProfile !== "READ_ONLY") throw new Error("Reviewer must run READ_ONLY.");
      yield { type: "stdout", runId: input.runId, occurredAt, chunk: this.options.reviewerOutput ?? VALID_VERDICT };
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
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-experiment-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial",
  ]);
  return { repositoryPath, worktreeRoot: join(dirname(repositoryPath), `${repositoryPath.split("/").at(-1)}-worktrees`) };
}

async function acknowledgeUnknownUsage(app: ReturnType<typeof buildApp>) {
  for (const provider of ["CLAUDE", "CODEX"] as const) {
    await app.inject({
      method: "POST", url: "/api/usage/acknowledge",
      payload: { provider, status: "UNAVAILABLE", userAction: "PROCEED", reason: "No usage data yet in this test fixture." },
    });
  }
}

async function createTaskAndProject(app: ReturnType<typeof buildApp>) {
  const { repositoryPath, worktreeRoot } = await createRepository();
  const project = (await app.inject({
    method: "POST", url: "/api/projects", payload: { repositoryPath, worktreeRoot, validationCommands: [] },
  })).json();
  const task = (await app.inject({
    method: "POST", url: "/api/tasks",
    payload: {
      projectId: project.id, title: "Database horizontal scaling", type: "ARCHITECTURE", riskLevel: "HIGH",
      problemStatement: "Decide how to shard the database as tenant count grows.", webAccessPermitted: false,
    },
  })).json();
  return { project, task };
}

async function pollUntilTerminal(app: ReturnType<typeof buildApp>, experimentId: string) {
  let experiment;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    experiment = (await app.inject({ method: "GET", url: `/api/experiments/${experimentId}` })).json();
    if (["COMPLETED", "FAILED", "CANCELLED", "CHECKPOINTED"].includes(experiment.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return experiment;
}

describe("experiment routes", () => {
  it("runs a builder and reviewer, records a verdict, and creates an EXPERIMENT_RESULT evidence item", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeExperimentAdapter("CLAUDE"), new FakeExperimentAdapter("CODEX")],
    });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    await acknowledgeUnknownUsage(app);

    const startResponse = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/experiments`,
      payload: {
        hypothesis: "Explicit tenant-to-shard routing can be implemented with a simple modulo router.",
        builderProvider: "CLAUDE", reviewerProvider: "CODEX",
      },
    });
    expect(startResponse.statusCode).toBe(202);
    const experiment = await pollUntilTerminal(app, startResponse.json().experimentId);

    expect(experiment.status).toBe("COMPLETED");
    expect(experiment.verdict).toBe("PROVEN");
    expect(experiment.result).toContain("routed to the expected shard");
    expect(experiment.conclusion).toContain("feasible");
    expect(experiment.diffStaged).toContain("shard_router.py");
    expect(experiment.builderRun.provider).toBe("CLAUDE");
    expect(experiment.reviewerRun.provider).toBe("CODEX");

    const { evidence } = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
    const result = evidence.find((item: { type: string }) => item.type === "EXPERIMENT_RESULT");
    expect(result).toBeTruthy();
    expect(result.content).toContain("PROVEN");
    expect(result.sourceProvider).toBe("CODEX");
  });

  it("rejects starting an experiment when the builder and reviewer are the same provider", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [new FakeExperimentAdapter("CLAUDE"), new FakeExperimentAdapter("CODEX")] });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    const response = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/experiments`,
      payload: { hypothesis: "A hypothesis.", builderProvider: "CLAUDE", reviewerProvider: "CLAUDE" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("different providers");
  });

  it("rejects starting an experiment without a hypothesis", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [new FakeExperimentAdapter("CLAUDE"), new FakeExperimentAdapter("CODEX")] });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    const response = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/experiments`,
      payload: { builderProvider: "CLAUDE", reviewerProvider: "CODEX" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("fails cleanly and retains raw output when the reviewer's verdict cannot be parsed", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeExperimentAdapter("CLAUDE"), new FakeExperimentAdapter("CODEX", { reviewerOutput: "not json at all" })],
    });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    await acknowledgeUnknownUsage(app);

    const startResponse = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/experiments`,
      payload: { hypothesis: "A hypothesis.", builderProvider: "CLAUDE", reviewerProvider: "CODEX" },
    });
    const experiment = await pollUntilTerminal(app, startResponse.json().experimentId);
    expect(experiment.status).toBe("FAILED");
    expect(experiment.errorMessage).toContain("could not be parsed");
    expect(experiment.verdict).toBeNull();

    const { evidence } = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
    expect(evidence.filter((item: { type: string }) => item.type === "EXPERIMENT_RESULT")).toHaveLength(0);
  });

  it("refuses to start a second experiment for the same task and provider while one is already running", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [new FakeExperimentAdapter("CLAUDE"), new FakeExperimentAdapter("CODEX")] });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    await acknowledgeUnknownUsage(app);
    const first = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/experiments`,
      payload: { hypothesis: "First hypothesis.", builderProvider: "CLAUDE", reviewerProvider: "CODEX" },
    });
    const second = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/experiments`,
      payload: { hypothesis: "Second hypothesis.", builderProvider: "CLAUDE", reviewerProvider: "CODEX" },
    });
    expect(second.statusCode).toBe(409);
    await pollUntilTerminal(app, first.json().experimentId);
  });

  it("lists experiments for a task, most recent first", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [new FakeExperimentAdapter("CLAUDE"), new FakeExperimentAdapter("CODEX")] });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    await acknowledgeUnknownUsage(app);
    const started = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/experiments`,
      payload: { hypothesis: "A hypothesis.", builderProvider: "CLAUDE", reviewerProvider: "CODEX" },
    });
    await pollUntilTerminal(app, started.json().experimentId);
    const list = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/experiments` })).json();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(started.json().experimentId);
  });

  it("404s for a task, project-less task, or experiment that doesn't exist", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/tasks/does-not-exist/experiments" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/tasks/does-not-exist/experiments", payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/experiments/does-not-exist" })).statusCode).toBe(404);
  });
});
