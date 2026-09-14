import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter, AgentEvent, AgentHealth, AgentProvider, AgentRunInput } from "@aiew/agents";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const execFileAsync = promisify(execFile);
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function analysis(provider: AgentProvider) {
  return JSON.stringify({
    summary: `${provider} summary`,
    facts: ["The repository uses SQLite."],
    assumptions: [`${provider} capacity assumption`],
    unknowns: ["What is the write throughput?"],
    options: [{
      name: `${provider} option`, description: "A candidate design.",
      advantages: ["Incremental rollout"], disadvantages: ["Operational overhead"], risks: ["Skew"],
    }],
    recommendedExperiments: ["Measure tenant write distribution."],
    recommendation: `${provider} recommendation`,
  });
}

function review(provider: AgentProvider) {
  return JSON.stringify({
    summary: `${provider} review`,
    agreements: ["Measure workload before selecting a shard key."],
    disagreements: [], factualErrors: [], unsupportedAssumptions: [],
    missingFailureCases: [], hiddenOperationalCosts: [], migrationRisks: [],
    openQuestions: [], missingEvidence: [], recommendedExperiments: [],
  });
}

class FakeBrainstormAdapter implements AgentAdapter {
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
    const output = input.promptVersion.startsWith("brainstorm") ? analysis(this.name) : review(this.name);
    yield { type: "stdout", runId: input.runId, occurredAt, chunk: output };
    yield {
      type: "completed", runId: input.runId, occurredAt, exitCode: 0,
      metadata: {
        provider: this.name, requestedModel: input.model.requested, actualModel: `fake-${this.name.toLowerCase()}`,
        effort: input.model.effort ?? null, cliVersion: `fake-${this.name.toLowerCase()} 1.0`,
        promptVersion: input.promptVersion, webAccessPermitted: input.webAccess.permitted === true,
      },
    };
  }

  async cancel() {}
}

async function createTestRepository() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-revision-repo-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  return repositoryPath;
}

async function acknowledgeUnknownUsage(app: ReturnType<typeof buildApp>) {
  for (const provider of ["CLAUDE", "CODEX"] as const) {
    await app.inject({
      method: "POST", url: "/api/usage/acknowledge",
      payload: { provider, status: "UNAVAILABLE", userAction: "PROCEED", reason: "No usage data yet in this test fixture." },
    });
  }
}

async function waitForStatus(app: ReturnType<typeof buildApp>, taskId: string, statuses: string[]) {
  let task;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    task = (await app.inject({ method: "GET", url: `/api/tasks/${taskId}` })).json();
    if (statuses.includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return task;
}

async function createReadyTask(app: ReturnType<typeof buildApp>) {
  const project = (await app.inject({
    method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
  })).json();
  const created = (await app.inject({
    method: "POST", url: "/api/tasks",
    payload: {
      projectId: project.id, title: "Database sharding", type: "ARCHITECTURE", riskLevel: "HIGH",
      problemStatement: "How should this system support database sharding?", webAccessPermitted: false,
    },
  })).json();
  await acknowledgeUnknownUsage(app);
  await app.inject({ method: "POST", url: `/api/tasks/${created.id}/start`, payload: {} });
  const task = await waitForStatus(app, created.id, ["READY", "FAILED"]);
  expect(task.status).toBe("READY");
  return task;
}

describe("plan revision with versioning", () => {
  it("revises a ready plan with an answered question folded into the prompt, keeping the prior version", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeBrainstormAdapter("CLAUDE"), new FakeBrainstormAdapter("CODEX")],
    });
    apps.push(app);
    const task = await createReadyTask(app);
    expect(task.comparisonHistory).toHaveLength(1);
    expect(task.comparisonHistory[0].version).toBe(1);
    expect(task.planRevisionRound).toBe(1);

    const question = task.evidence.find((item: { type: string }) => item.type === "QUESTION");
    expect(question).toBeTruthy();
    const answered = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${question.id}/responses`,
      payload: { answer: "Writes are roughly 4,000 QPS peak across all tenants." },
    });
    expect(answered.statusCode).toBe(200);

    const revise = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/revise` });
    expect(revise.statusCode).toBe(202);
    const revised = await waitForStatus(app, task.id, ["READY", "FAILED"]);
    expect(revised.status).toBe("READY");
    expect(revised.planRevisionRound).toBe(2);
    expect(revised.comparisonHistory).toHaveLength(2);
    expect(revised.comparisonHistory[0].version).toBe(1);
    expect(revised.comparisonHistory[1].version).toBe(2);
    // The old version's content is untouched, still reachable.
    expect(revised.comparisonHistory[0].content).toEqual(task.comparisonHistory[0].content);
    expect(revised.comparison).toEqual(revised.comparisonHistory[1].content);

    const reviseRuns = revised.runs.filter((run: { promptVersion: string }) => run.promptVersion === "brainstorm-analysis-revise:v1");
    expect(reviseRuns).toHaveLength(2);
    for (const run of reviseRuns) {
      expect(run.prompt).toContain("Writes are roughly 4,000 QPS peak across all tenants.");
      expect(run.prompt).toContain(question.content);
    }
  });

  it("refuses to revise a task that isn't READY", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();
    const draft = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Draft", type: "BRAINSTORM", riskLevel: "LOW",
        problemStatement: "Still a draft.", webAccessPermitted: false,
      },
    })).json();
    const response = await app.inject({ method: "POST", url: `/api/tasks/${draft.id}/revise` });
    expect(response.statusCode).toBe(409);
  });

  it("refuses to revise a ready task with no answered questions", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeBrainstormAdapter("CLAUDE"), new FakeBrainstormAdapter("CODEX")],
    });
    apps.push(app);
    const task = await createReadyTask(app);
    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/revise` });
    expect(response.statusCode).toBe(400);
    const stillOne = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
    expect(stillOne.comparisonHistory).toHaveLength(1);
  });

  it("404s revising an unknown task", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/tasks/does-not-exist/revise" });
    expect(response.statusCode).toBe(404);
  });
});
