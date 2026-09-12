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
        effort: null, cliVersion: "fake-codex 1.0", promptVersion: "repository-explanation-v1", webAccessPermitted: false,
      },
    };
  }

  async cancel() {}
}

async function createTestRepository() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-agent-repo-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  return repositoryPath;
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

    let run;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const response = await app.inject({ method: "GET", url: `/api/agent-runs/${created.id}` });
      run = response.json();
      if (run.status === "COMPLETED") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

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
