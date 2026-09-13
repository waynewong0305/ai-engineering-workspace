import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter, AgentEvent, AgentHealth, AgentRunInput } from "@aiew/agents";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const execFileAsync = promisify(execFile);
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

class FakeCodexAdapter implements AgentAdapter {
  readonly name = "CODEX" as const;

  async healthCheck(): Promise<AgentHealth> {
    return {
      provider: "CODEX", available: true, authenticated: true, cliVersion: "fake-codex 1.0",
      capabilities: { structuredOutput: true, sessionResume: false, dynamicModelDiscovery: false, availableModels: null, availableEffortLevels: null },
    };
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const occurredAt = new Date().toISOString();
    yield { type: "started", runId: input.runId, occurredAt };
    yield { type: "structured_output", runId: input.runId, occurredAt, value: { type: "fixture" } };
    yield { type: "stdout", runId: input.runId, occurredAt, chunk: "This repository is a test fixture." };
    yield {
      type: "completed", runId: input.runId, occurredAt, exitCode: 0,
      metadata: {
        provider: "CODEX", requestedModel: input.model.requested, actualModel: "fixture-model",
        effort: null, cliVersion: "fake-codex 1.0", promptVersion: input.promptVersion, webAccessPermitted: input.webAccess.permitted === true,
      },
    };
  }

  async cancel() {}
}

class FailingCodexAdapter extends FakeCodexAdapter {
  constructor(private readonly detail: string) {
    super();
  }

  override async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const occurredAt = new Date().toISOString();
    yield { type: "started", runId: input.runId, occurredAt };
    yield { type: "stderr", runId: input.runId, occurredAt, chunk: this.detail };
    yield {
      type: "failed", runId: input.runId, occurredAt,
      message: "Agent process exited with code 1.", exitCode: 1,
    };
  }
}

class SubstitutingCodexAdapter extends FakeCodexAdapter {
  override async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const occurredAt = new Date().toISOString();
    yield { type: "started", runId: input.runId, occurredAt };
    yield {
      type: "completed", runId: input.runId, occurredAt, exitCode: 0,
      metadata: {
        provider: "CODEX", requestedModel: input.model.requested, actualModel: "substitute-model",
        effort: null, cliVersion: "fake-codex 1.0", promptVersion: input.promptVersion,
        webAccessPermitted: input.webAccess.permitted === true,
      },
    };
  }
}

async function createTestRepository() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-agent-repo-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  return repositoryPath;
}

async function waitForTerminalRun(app: ReturnType<typeof buildApp>, runId: string) {
  let run;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/agent-runs/${runId}` });
    run = response.json();
    if (["COMPLETED", "FAILED", "CANCELLED"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return run;
}

describe("agent run routes", () => {
  it("persists a read-only fake-agent run and its streamed events", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [new FakeCodexAdapter()] });
    apps.push(app);
    const projectResponse = await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    });
    const project = projectResponse.json();

    const createResponse = await app.inject({
      method: "POST", url: "/api/agent-runs",
      payload: { projectId: project.id, provider: "CODEX", prompt: "Explain this repository." },
    });
    expect(createResponse.statusCode).toBe(202);
    const created = createResponse.json();

    const run = await waitForTerminalRun(app, created.id);

    expect(run).toMatchObject({
      status: "COMPLETED",
      output: "This repository is a test fixture.",
      rawOutput: "{\"type\":\"fixture\"}\n",
      actualModel: "fixture-model",
      permissionProfile: "READ_ONLY",
      webAccessPermitted: false,
    });
    expect(run.events.map((event: { type: string }) => event.type)).toEqual([
      "started", "structured_output", "stdout", "completed",
    ]);
  });

  it("refuses to start a run when the provider is exhausted, and never invokes the adapter", async () => {
    const adapter = new FakeCodexAdapter();
    let runCalls = 0;
    const originalRun = adapter.run.bind(adapter);
    adapter.run = (input) => {
      runCalls += 1;
      return originalRun(input);
    };
    const app = buildApp({ databasePath: ":memory:", adapters: [adapter] });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();

    const snapshot = await app.inject({
      method: "POST", url: "/api/usage/manual-snapshot",
      payload: { provider: "CODEX", windowId: "5H", windowLabel: "5-hour window", usedPercent: 100 },
    });
    expect(snapshot.statusCode).toBe(201);

    const blocked = await app.inject({
      method: "POST", url: "/api/agent-runs",
      payload: { projectId: project.id, provider: "CODEX", prompt: "Explain this repository." },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: "USAGE_CHECKPOINT" });
    expect(runCalls).toBe(0);
    expect((await app.inject({ method: "GET", url: "/api/agent-runs" })).json()).toEqual([]);

    const audit = (await app.inject({ method: "GET", url: "/api/usage/audit?provider=CODEX" })).json();
    expect(audit[0]).toMatchObject({ eventType: "CHECKPOINT_TRIGGERED", status: "EXHAUSTED" });
  });

  it("turns an authentication-expiry process failure into actionable guidance", async () => {
    const app = buildApp({
      databasePath: ":memory:",
      adapters: [new FailingCodexAdapter("Authentication required: token expired")],
    });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();

    const response = await app.inject({
      method: "POST", url: "/api/agent-runs",
      payload: { projectId: project.id, provider: "CODEX", prompt: "Explain this repository." },
    });
    const run = await waitForTerminalRun(app, response.json().id);

    expect(run.status).toBe("FAILED");
    expect(run.errorMessage).toContain("authentication is required or has expired");
    expect(run.errorMessage).toContain("Authenticate manually");
    expect(run.events.at(-1)).toMatchObject({
      type: "failed",
      payload: { failureKind: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("refuses to accept a silently substituted explicitly requested model", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [new SubstitutingCodexAdapter()] });
    apps.push(app);
    const project = (await app.inject({
      method: "POST", url: "/api/projects", payload: { repositoryPath: await createTestRepository() },
    })).json();

    const response = await app.inject({
      method: "POST", url: "/api/agent-runs",
      payload: {
        projectId: project.id, provider: "CODEX", prompt: "Explain this repository.",
        model: "requested-model",
      },
    });
    const run = await waitForTerminalRun(app, response.json().id);

    expect(run).toMatchObject({ status: "FAILED", actualModel: "substitute-model" });
    expect(run.errorMessage).toContain("instead of the explicitly requested requested-model");
    expect(run.errorMessage).toContain("requires a human decision");
    expect(run.events.at(-1)).toMatchObject({
      type: "failed",
      payload: { failureKind: "MODEL_SUBSTITUTED", actualModel: "substitute-model" },
    });
  });

  it("rejects an unregistered project", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [new FakeCodexAdapter()] });
    apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/api/agent-runs",
      payload: { projectId: "missing", provider: "CODEX", prompt: "Explain." },
    });
    expect(response.statusCode).toBe(404);
  });
});
