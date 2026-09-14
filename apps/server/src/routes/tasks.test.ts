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

class PausedBrainstormAdapter implements AgentAdapter {
  constructor(readonly name: AgentProvider, private readonly release: Promise<void>) {}

  async healthCheck(): Promise<AgentHealth> {
    return {
      provider: this.name, available: true, authenticated: true, cliVersion: `fake-${this.name.toLowerCase()} 1.0`,
      capabilities: { structuredOutput: true, sessionResume: false, dynamicModelDiscovery: false, availableModels: null, availableEffortLevels: null },
    };
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const occurredAt = new Date().toISOString();
    recordStart(input.promptVersion, this.name);
    yield { type: "started", runId: input.runId, occurredAt };
    await waitForPair(input.promptVersion);
    await this.release;
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
    expect(created).toMatchObject({ status: "DRAFT", webAccessPolicy: "DISABLED", webAccessDecidedBy: "USER", openQuestionCount: 0 });

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
    expect(task.evidence.filter((item: { type: string }) => item.type === "QUESTION")).toHaveLength(2);
    expect(task.openQuestionCount).toBe(2);
    expect(starts.get("brainstorm-analysis:v1")?.size).toBe(2);
    expect(starts.get("cross-review:v1")?.size).toBe(2);

    const listResponse = await app.inject({ method: "GET", url: `/api/tasks?projectId=${project.id}` });
    const list = listResponse.json();
    expect(list.find((entry: { id: string }) => entry.id === created.id)?.openQuestionCount).toBe(2);

    const evidenceResponse = await app.inject({
      method: "POST", url: `/api/tasks/${created.id}/evidence`, payload: { type: "DECISION", content: "Use explicit tenant-to-shard mapping." },
    });
    expect(evidenceResponse.statusCode).toBe(201);
    const evidence = evidenceResponse.json();
    const updateResponse = await app.inject({
      method: "PATCH", url: `/api/tasks/${created.id}/evidence/${evidence.id}`, payload: { content: "Use a versioned tenant-to-shard map." },
    });
    expect(updateResponse.json().content).toBe("Use a versioned tenant-to-shard map.");

    const deletion = await app.inject({ method: "DELETE", url: `/api/tasks/${created.id}`, payload: { confirm: true } });
    expect(deletion.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${created.id}` })).statusCode).toBe(404);
    const retainedRuns = (await app.inject({ method: "GET", url: `/api/agent-runs?projectId=${project.id}` })).json();
    expect(retainedRuns.filter((run: { taskId: string | null }) => run.taskId === created.id)).toEqual([]);
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

  it("requires confirmation, then deletes a task and its dependent local history without touching Git", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const repositoryPath = await createTestRepository();
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath },
    })).json();
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Disposable draft", problemStatement: "Remove this local plan.",
        type: "BRAINSTORM", riskLevel: "LOW", webAccessPermitted: false,
      },
    })).json();
    await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/evidence`, payload: { type: "FACT", content: "Temporary evidence." },
    });

    const unconfirmed = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}`, payload: { confirm: false } });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().code).toBe("CONFIRMATION_REQUIRED");

    const deletion = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}`, payload: { confirm: true } });
    expect(deletion.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tasks?projectId=${project.id}` })).json()).toEqual([]);
    expect((await execFileAsync("git", ["-C", repositoryPath, "status", "--porcelain=v1"])).stdout).toBe("");
  });

  it("refuses to delete a task while its brainstorm agent runs are active", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new PausedBrainstormAdapter("CLAUDE", gate), new PausedBrainstormAdapter("CODEX", gate)],
    });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Active plan", problemStatement: "Keep this while providers are running.",
        type: "BRAINSTORM", riskLevel: "MEDIUM", webAccessPermitted: false,
      },
    })).json();

    await acknowledgeUnknownUsage(app);
    expect((await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, payload: {} })).statusCode).toBe(202);
    const deletion = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}`, payload: { confirm: true } });
    expect(deletion.statusCode).toBe(409);
    expect(deletion.json().code).toBe("ACTIVE_RUNS");
    expect((await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).statusCode).toBe(200);

    release();
    let finalStatus = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const detail = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}` })).json();
      finalStatus = detail.status;
      if (["READY", "FAILED"].includes(detail.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(finalStatus).toBe("READY");
  });

  it("removes loose ADR references instead of leaving dangling plan links", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();
    const createTask = async (title: string) => (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title, problemStatement: `${title} context.`,
        type: "ARCHITECTURE", riskLevel: "MEDIUM", webAccessPermitted: false,
      },
    })).json();
    const sourceTask = await createTask("Source plan");
    const survivingTask = await createTask("Surviving plan");
    const adrPayload = {
      title: "Shard routing", context: "Storage is constrained.", optionsConsidered: "Hashing or explicit mapping.",
      decision: "Use explicit mapping.", reasons: "Controlled migration.", consequences: "Maintain a registry.",
    };
    const ownedAdr = (await app.inject({
      method: "POST", url: `/api/tasks/${sourceTask.id}/adrs`, payload: adrPayload,
    })).json();
    const promotedTask = (await app.inject({
      method: "POST", url: `/api/adrs/${ownedAdr.id}/promote`,
      payload: { title: "Build shard registry", problemStatement: "Implement the chosen registry." },
    })).json();
    const survivingAdr = (await app.inject({
      method: "POST", url: `/api/tasks/${survivingTask.id}/adrs`,
      payload: { ...adrPayload, title: "Related rollout", relatedTaskIds: [sourceTask.id] },
    })).json();

    expect((await app.inject({
      method: "DELETE", url: `/api/tasks/${sourceTask.id}`, payload: { confirm: true },
    })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/adrs/${ownedAdr.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/tasks/${promotedTask.id}` })).json().originAdrId).toBeNull();
    expect((await app.inject({ method: "GET", url: `/api/adrs/${survivingAdr.id}` })).json().relatedTaskIds).toEqual([]);
  });

  it("refuses to delete a task until its managed worktree is safely removed", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Worktree-backed plan", problemStatement: "Protect the managed checkout.",
        type: "ARCHITECTURE", riskLevel: "HIGH", webAccessPermitted: false,
      },
    })).json();
    const proposals = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees/preview` })).json().proposals;
    const proposal = proposals.find((item: { provider: AgentProvider }) => item.provider === "CLAUDE");
    const worktree = (await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: proposal,
    })).json();

    const blocked = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}`, payload: { confirm: true } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe("WORKTREES_LINKED");
    expect(blocked.json().message).toContain("Worktrees screen");

    expect((await app.inject({
      method: "DELETE", url: `/api/worktrees/${worktree.id}`, payload: { confirm: true, deleteBranch: false },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "DELETE", url: `/api/tasks/${task.id}`, payload: { confirm: true },
    })).statusCode).toBe(204);
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

    const emptyReport = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/report` })).json();
    expect(emptyReport.comparisonVersion).toBe(1);
    expect(emptyReport.evidence.questions.open.length).toBeGreaterThan(0);
    expect(emptyReport.evidence.questions.answered).toEqual([]);
    expect(emptyReport.evidence.facts.length).toBeGreaterThan(0);
    expect(emptyReport.architectureDecisions).toEqual([]);
    expect(emptyReport.experiments).toEqual([]);
    expect(emptyReport.blockingQuestionsRemain).toBe(false);

    const question = emptyReport.evidence.questions.open[0];
    const answered = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/questions/${question.id}/responses`,
      payload: { answer: "Roughly 4,000 writes per second at peak." },
    });
    expect(answered.statusCode).toBe(200);
    await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/adrs`,
      payload: {
        title: "Adopt explicit tenant-to-shard mapping", context: "Context.", optionsConsidered: "Options.",
        decision: "Use a versioned mapping table.", reasons: "Reasons.", consequences: "Consequences.",
      },
    });

    const response = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/report` });
    expect(response.statusCode).toBe(200);
    const report = response.json();
    expect(report.taskId).toBe(task.id);
    expect(report.taskTitle).toBe("Database sharding");
    expect(report.status).toBe("READY");
    expect(report.analyses).toHaveLength(2);
    expect(report.analyses.map((entry: { provider: string }) => entry.provider).sort()).toEqual(["CLAUDE", "CODEX"]);
    expect(report.analyses.every((entry: { data: unknown }) => entry.data !== null)).toBe(true);
    expect(report.analyses[0].data.facts.length).toBeGreaterThan(0);
    expect(report.crossReviews).toHaveLength(2);
    expect(report.comparison).toMatchObject({ consensus: ["Measure workload before selecting a shard key."] });
    expect(report.comparisonVersion).toBe(1);
    expect(report.evidence.questions.answered).toHaveLength(1);
    expect(report.evidence.questions.answered[0]).toMatchObject({
      id: question.id, content: question.content, responses: [{ answer: "Roughly 4,000 writes per second at peak.", resultingStatus: "ANSWERED" }],
    });
    expect(report.evidence.questions.open.some((entry: { id: string }) => entry.id === question.id)).toBe(false);
    expect(report.evidence.questions.duplicateGroups).toEqual([]);
    expect(report.architectureDecisions).toHaveLength(1);
    expect(report.architectureDecisions[0]).toMatchObject({ number: 1, title: "Adopt explicit tenant-to-shard mapping", status: "PROPOSED" });
    expect(report.experiments).toEqual([]);
    expect(report.blockingQuestionsRemain).toBe(false);
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
