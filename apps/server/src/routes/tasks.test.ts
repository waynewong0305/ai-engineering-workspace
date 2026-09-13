import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter, AgentEvent, AgentHealth, AgentProvider, AgentRunInput } from "@aiew/agents";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const execFileAsync = promisify(execFile);
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

beforeEach(() => {
  starts.clear();
  waiters.clear();
});

const starts = new Map<string, Set<AgentProvider>>();
const waiters = new Map<string, Array<() => void>>();

function recordStart(stage: string, provider: AgentProvider) {
  const providers = starts.get(stage) ?? new Set<AgentProvider>();
  providers.add(provider);
  starts.set(stage, providers);
  if (providers.size === 2) waiters.get(stage)?.splice(0).forEach((resolve) => resolve());
}

async function waitForPair(stage: string) {
  if (starts.get(stage)?.size === 2) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${stage} did not start in parallel`)), 500);
    const done = () => { clearTimeout(timer); resolve(); };
    waiters.set(stage, [...(waiters.get(stage) ?? []), done]);
  });
}

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
    disagreements: [`${provider} disputes the proposed cutover sequence.`],
    factualErrors: [], unsupportedAssumptions: ["Growth is uniform."],
    missingFailureCases: ["Shard outage"], hiddenOperationalCosts: ["Rebalancing"],
    migrationRisks: ["Dual-write divergence"], openQuestions: ["What is the recovery objective?"],
    missingEvidence: ["Per-tenant storage distribution"],
    recommendedExperiments: ["Replay production-shaped traffic."],
  });
}

class FakeBrainstormAdapter implements AgentAdapter {
  constructor(readonly name: AgentProvider, private readonly ready = true) {}

  async healthCheck(): Promise<AgentHealth> {
    return {
      provider: this.name, available: this.ready, authenticated: this.ready, cliVersion: this.ready ? `fake-${this.name.toLowerCase()} 1.0` : null,
      capabilities: { structuredOutput: true, sessionResume: false, dynamicModelDiscovery: false, availableModels: null, availableEffortLevels: null },
    };
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const stage = input.promptVersion;
    const occurredAt = new Date().toISOString();
    recordStart(stage, this.name);
    yield { type: "started", runId: input.runId, occurredAt };
    await waitForPair(stage);
    const output = stage.startsWith("brainstorm")
      ? analysis(this.name)
      : this.name === "CODEX"
        ? `Review follows.\n\`\`\`json\n${review(this.name)}\n\`\`\``
        : review(this.name);
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
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-task-repo-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  return repositoryPath;
}

/**
 * Combined, multi-stage workflows default to requiring an explicit human acknowledgement before
 * spending provider usage when that usage is unknown (see usage-safety.test.ts and
 * IMPLEMENTATION_STATUS.md). These fixtures have no usage readings at all, so tests that start a
 * brainstorm workflow must acknowledge both providers first, exactly as a human would in the UI.
 */
async function acknowledgeUnknownUsage(app: ReturnType<typeof buildApp>) {
  for (const provider of ["CLAUDE", "CODEX"] as const) {
    await app.inject({
      method: "POST", url: "/api/usage/acknowledge",
      payload: { provider, status: "UNAVAILABLE", userAction: "PROCEED", reason: "No usage data yet in this test fixture." },
    });
  }
}

describe("brainstorm task routes", () => {
  it("runs independent analyses and reciprocal reviews, then persists comparison and evidence", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeBrainstormAdapter("CLAUDE"), new FakeBrainstormAdapter("CODEX")],
    });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();
    const createResponse = await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Database sharding", type: "ARCHITECTURE", riskLevel: "HIGH",
        problemStatement: "How should this system support database sharding?", webAccessPermitted: false,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    const created = createResponse.json();
    expect(created).toMatchObject({ status: "DRAFT", webAccessPolicy: "DISABLED", webAccessDecidedBy: "USER" });

    await acknowledgeUnknownUsage(app);
    const startResponse = await app.inject({ method: "POST", url: `/api/tasks/${created.id}/start`, payload: {} });
    expect(startResponse.statusCode).toBe(202);
    let task;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      task = (await app.inject({ method: "GET", url: `/api/tasks/${created.id}` })).json();
      if (["READY", "FAILED"].includes(task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(task.status).toBe("READY");
    expect(task.runs).toHaveLength(4);
    expect(task.runs.map((run: { promptVersion: string }) => run.promptVersion)).toEqual([
      "brainstorm-analysis:v1", "brainstorm-analysis:v1", "cross-review:v1", "cross-review:v1",
    ]);
    expect(task.artifacts).toHaveLength(4);
    expect(task.artifacts.every((artifact: { rawOutput: string; parseError: string | null }) => artifact.rawOutput && artifact.parseError === null)).toBe(true);
    expect(task.comparison).toMatchObject({
      consensus: ["Measure workload before selecting a shard key."],
      openQuestions: expect.arrayContaining(["What is the write throughput?", "What is the recovery objective?"]),
      missingEvidence: ["Per-tenant storage distribution"],
    });
    expect(task.evidence.filter((item: { type: string }) => item.type === "FACT")).toHaveLength(2);
    expect(starts.get("brainstorm-analysis:v1")?.size).toBe(2);
    expect(starts.get("cross-review:v1")?.size).toBe(2);

    const evidenceResponse = await app.inject({
      method: "POST", url: `/api/tasks/${created.id}/evidence`, payload: { type: "DECISION", content: "Use explicit tenant-to-shard mapping." },
    });
    expect(evidenceResponse.statusCode).toBe(201);
    const evidence = evidenceResponse.json();
    const updateResponse = await app.inject({
      method: "PATCH", url: `/api/tasks/${created.id}/evidence/${evidence.id}`, payload: { content: "Use a versioned tenant-to-shard map." },
    });
    expect(updateResponse.json().content).toBe("Use a versioned tenant-to-shard map.");
  });

  it("requires an explicit per-task web-access decision", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();
    const response = await app.inject({
      method: "POST", url: "/api/tasks",
      payload: { projectId: project.id, title: "A", problemStatement: "B", type: "BRAINSTORM", riskLevel: "LOW" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("web-access decision");
  });

  it("keeps the task in draft when either provider is not ready", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeBrainstormAdapter("CLAUDE"), new FakeBrainstormAdapter("CODEX", false)],
    });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Safe start", problemStatement: "Do not partially start.",
        type: "BRAINSTORM", riskLevel: "LOW", webAccessPermitted: false,
      },
    })).json();

    const startResponse = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, payload: {} });
    expect(startResponse.statusCode).toBe(503);
    expect(startResponse.json().message).toContain("CODEX");
    const detail = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
    expect(detail.status).toBe("DRAFT");
    expect(detail.runs).toEqual([]);
  });

  it("claims a draft once when start requests race", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeBrainstormAdapter("CLAUDE"), new FakeBrainstormAdapter("CODEX")],
    });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Single start", problemStatement: "Run exactly once.",
        type: "BRAINSTORM", riskLevel: "LOW", webAccessPermitted: false,
      },
    })).json();

    await acknowledgeUnknownUsage(app);
    const responses = await Promise.all([
      app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, payload: {} }),
      app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, payload: {} }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 409]);

    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
      if (["READY", "FAILED"].includes(detail.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(detail.status).toBe("READY");
    expect(detail.runs).toHaveLength(4);
  });

  it("exports a brainstorm plan report once the workflow reaches READY", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FakeBrainstormAdapter("CLAUDE"), new FakeBrainstormAdapter("CODEX")],
    });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Database sharding", type: "ARCHITECTURE", riskLevel: "HIGH",
        problemStatement: "How should this system support database sharding?", webAccessPermitted: false,
      },
    })).json();

    await acknowledgeUnknownUsage(app);
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, payload: {} });
    let detail;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      detail = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
      if (["READY", "FAILED"].includes(detail.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(detail.status).toBe("READY");

    const response = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/report` });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.taskId).toBe(task.id);
    expect(report.taskTitle).toBe("Database sharding");
    expect(report.status).toBe("READY");
    expect(report.analyses).toHaveLength(2);
    expect(report.analyses.map((entry: { provider: string }) => entry.provider).sort()).toEqual(["CLAUDE", "CODEX"]);
    expect(report.analyses.every((entry: { data: unknown }) => entry.data !== null)).toBe(true);
    expect(report.crossReviews).toHaveLength(2);
    expect(report.comparison).toMatchObject({ consensus: ["Measure workload before selecting a shard key."] });
    expect(report.humanDecisionRequired).toBe(true);
    expect(typeof report.recommendedNextAction).toBe("string");
    expect(report.recommendedNextAction.length).toBeGreaterThan(0);
  });

  it("returns 404 for a report on an unknown task", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/tasks/does-not-exist/report" });
    expect(response.statusCode).toBe(404);
  });
});
