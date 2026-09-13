import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const execFileAsync = promisify(execFile);
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createRepository() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-adr-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  return { repositoryPath, worktreeRoot: join(dirname(repositoryPath), `${repositoryPath.split("/").at(-1)}-worktrees`) };
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

function validAdrPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Explicit Tenant-to-Shard Mapping",
    context: "There are approximately 500 tenant databases and storage capacity is approaching its limit.",
    optionsConsidered: "Range-based sharding; hash-based sharding; explicit tenant-to-shard mapping.",
    decision: "Use explicit tenant-to-shard mapping.",
    reasons: "Gives full control over tenant placement and rebalancing without a resharding migration.",
    consequences: "Requires a shard registry service and routing layer.",
    ...overrides,
  };
}

describe("ADR routes", () => {
  it("creates an ADR with a sequential per-project number and defaults", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const { task } = await createTaskAndProject(app);

    const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/adrs`, payload: validAdrPayload() });
    expect(response.statusCode).toBe(201);
    const adr = response.json();
    expect(adr.number).toBe(1);
    expect(adr.status).toBe("PROPOSED");
    expect(adr.taskId).toBe(task.id);
    expect(adr.projectId).toBe(task.projectId);
    expect(adr.risks).toBeNull();
    expect(adr.relatedTaskIds).toEqual([]);
    expect(adr.id).toBeTruthy();
    expect(adr.createdAt).toBeTruthy();
  });

  it("assigns increasing numbers across ADRs in the same project, even across different tasks", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const { task, project } = await createTaskAndProject(app);
    const secondTask = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "A second architecture task", type: "ARCHITECTURE", riskLevel: "MEDIUM",
        problemStatement: "A different decision.", webAccessPermitted: false,
      },
    })).json();

    const first = (await app.inject({ method: "POST", url: `/api/tasks/${task.id}/adrs`, payload: validAdrPayload() })).json();
    const second = (await app.inject({
      method: "POST", url: `/api/tasks/${secondTask.id}/adrs`, payload: validAdrPayload({ title: "A second decision" }),
    })).json();
    expect(first.number).toBe(1);
    expect(second.number).toBe(2);

    const list = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/adrs` })).json();
    expect(list.map((adr: { number: number }) => adr.number)).toEqual([1, 2]);
  });

  it("rejects a missing required field", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    const response = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/adrs`, payload: validAdrPayload({ decision: "" }),
    });
    expect(response.statusCode).toBe(400);
  });

  it("404s creating an ADR for a task that doesn't exist", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/tasks/does-not-exist/adrs", payload: validAdrPayload() });
    expect(response.statusCode).toBe(404);
  });

  it("lists ADRs scoped to a single task", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    await app.inject({ method: "POST", url: `/api/tasks/${task.id}/adrs`, payload: validAdrPayload() });
    const list = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/adrs` })).json();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("Explicit Tenant-to-Shard Mapping");
  });

  it("updates fields, status, and relatedTaskIds via PATCH, leaving omitted fields unchanged", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    const created = (await app.inject({ method: "POST", url: `/api/tasks/${task.id}/adrs`, payload: validAdrPayload() })).json();

    const patched = await app.inject({
      method: "PATCH", url: `/api/adrs/${created.id}`,
      payload: { status: "ACCEPTED", risks: "Migration downtime during rollout.", relatedTaskIds: [task.id] },
    });
    expect(patched.statusCode).toBe(200);
    const updated = patched.json();
    expect(updated.status).toBe("ACCEPTED");
    expect(updated.risks).toBe("Migration downtime during rollout.");
    expect(updated.relatedTaskIds).toEqual([task.id]);
    // Untouched fields survive the partial update.
    expect(updated.title).toBe(created.title);
    expect(updated.decision).toBe(created.decision);
  });

  it("rejects an invalid status transition value", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    const created = (await app.inject({ method: "POST", url: `/api/tasks/${task.id}/adrs`, payload: validAdrPayload() })).json();
    const response = await app.inject({ method: "PATCH", url: `/api/adrs/${created.id}`, payload: { status: "NOT_A_REAL_STATUS" } });
    expect(response.statusCode).toBe(400);
  });

  it("404s reading or patching an ADR that doesn't exist", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/adrs/does-not-exist" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/adrs/does-not-exist", payload: { status: "ACCEPTED" } })).statusCode).toBe(404);
  });

  it("404s listing ADRs for a project that doesn't exist", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/projects/does-not-exist/adrs" });
    expect(response.statusCode).toBe(404);
  });
});

describe("ADR plan promotion", () => {
  it("promotes an ADR into a linked IMPLEMENTATION task, preserving the ADR/architecture-discussion chain", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const { task, project } = await createTaskAndProject(app);
    const adr = (await app.inject({ method: "POST", url: `/api/tasks/${task.id}/adrs`, payload: validAdrPayload() })).json();

    const response = await app.inject({
      method: "POST", url: `/api/adrs/${adr.id}/promote`,
      payload: { title: "Create shard registry schema", problemStatement: "Design and migrate the shard_registry table.", planPhase: "Phase 1 — Shard Registry" },
    });
    expect(response.statusCode).toBe(201);
    const promoted = response.json();
    expect(promoted.type).toBe("IMPLEMENTATION");
    expect(promoted.status).toBe("DRAFT");
    expect(promoted.originAdrId).toBe(adr.id);
    expect(promoted.planPhase).toBe("Phase 1 — Shard Registry");
    expect(promoted.projectId).toBe(project.id);
    expect(promoted.riskLevel).toBe("MEDIUM");

    // The full chain is walkable: promoted task -> ADR -> originating architecture task.
    const adrAgain = (await app.inject({ method: "GET", url: `/api/adrs/${adr.id}` })).json();
    expect(adrAgain.taskId).toBe(task.id);

    const listed = (await app.inject({ method: "GET", url: `/api/adrs/${adr.id}/promoted-tasks` })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(promoted.id);
  });

  it("creates one task per promote call, so multiple TASK-20x tasks can share a plan phase", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    const adr = (await app.inject({ method: "POST", url: `/api/tasks/${task.id}/adrs`, payload: validAdrPayload() })).json();

    await app.inject({ method: "POST", url: `/api/adrs/${adr.id}/promote`, payload: { title: "TASK-201", problemStatement: "First.", planPhase: "Phase 1" } });
    await app.inject({ method: "POST", url: `/api/adrs/${adr.id}/promote`, payload: { title: "TASK-202", problemStatement: "Second.", planPhase: "Phase 1" } });

    const listed = (await app.inject({ method: "GET", url: `/api/adrs/${adr.id}/promoted-tasks` })).json();
    expect(listed.map((t: { title: string }) => t.title).sort()).toEqual(["TASK-201", "TASK-202"]);
  });

  it("rejects promotion with a missing title or problem statement", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const { task } = await createTaskAndProject(app);
    const adr = (await app.inject({ method: "POST", url: `/api/tasks/${task.id}/adrs`, payload: validAdrPayload() })).json();
    const response = await app.inject({ method: "POST", url: `/api/adrs/${adr.id}/promote`, payload: { title: "Only a title" } });
    expect(response.statusCode).toBe(400);
  });

  it("404s promoting an ADR that doesn't exist", async () => {
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/api/adrs/does-not-exist/promote", payload: { title: "T", problemStatement: "P" },
    });
    expect(response.statusCode).toBe(404);
  });
});
