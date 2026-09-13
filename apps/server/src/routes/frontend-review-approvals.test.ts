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
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-frontend-review-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  return { repositoryPath, worktreeRoot: join(dirname(repositoryPath), `${repositoryPath.split("/").at(-1)}-worktrees`) };
}

async function createTask(app: ReturnType<typeof buildApp>) {
  const { repositoryPath, worktreeRoot } = await createRepository();
  const project = (await app.inject({
    method: "POST", url: "/api/projects", payload: { repositoryPath, worktreeRoot, validationCommands: [] },
  })).json();
  return (await app.inject({
    method: "POST", url: "/api/tasks",
    payload: {
      projectId: project.id, title: "Ship the new dashboard", type: "ARCHITECTURE", riskLevel: "MEDIUM",
      problemStatement: "Needs a frontend UI review.", webAccessPermitted: false,
    },
  })).json();
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    provider: "CLAUDE",
    agentConfiguration: "claude-sonnet-5, effort: medium",
    reason: "The responsive layout regression check failed on the new checkout page.",
    scope: "Checkout page only, desktop and mobile screenshots plus console/network capture.",
    triggerDescription: "Automated responsive check flagged an overlapping element at 375px width.",
    ...overrides,
  };
}

describe("frontend review approval routes", () => {
  it("requests, lists, and decides a frontend review approval end to end", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const task = await createTask(app);

    const requested = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/frontend-review-approvals`, payload: validPayload() });
    expect(requested.statusCode).toBe(201);
    const approval = requested.json();
    expect(approval).toMatchObject({ taskId: task.id, provider: "CLAUDE", status: "PENDING" });

    const listed = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/frontend-review-approvals` });
    expect(listed.json()).toEqual([approval]);

    const fetched = await app.inject({ method: "GET", url: `/api/frontend-review-approvals/${approval.id}` });
    expect(fetched.json()).toEqual(approval);

    const decided = await app.inject({
      method: "POST", url: `/api/frontend-review-approvals/${approval.id}/decide`, payload: { decision: "APPROVED" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ status: "APPROVED" });

    const redecided = await app.inject({
      method: "POST", url: `/api/frontend-review-approvals/${approval.id}/decide`, payload: { decision: "REFUSED" },
    });
    expect(redecided.statusCode).toBe(409);
    expect(redecided.json().code).toBe("ALREADY_DECIDED");
  });

  it("rejects a request for an unknown task, missing fields, or a bad decision value", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const task = await createTask(app);

    const missingTask = await app.inject({ method: "POST", url: "/api/tasks/does-not-exist/frontend-review-approvals", payload: validPayload() });
    expect(missingTask.statusCode).toBe(404);

    const missingReason = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/frontend-review-approvals`, payload: validPayload({ reason: "" }),
    });
    expect(missingReason.statusCode).toBe(400);

    const created = (await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/frontend-review-approvals`, payload: validPayload(),
    })).json();
    const badDecision = await app.inject({
      method: "POST", url: `/api/frontend-review-approvals/${created.id}/decide`, payload: { decision: "MAYBE" },
    });
    expect(badDecision.statusCode).toBe(400);

    const unknownApproval = await app.inject({ method: "GET", url: "/api/frontend-review-approvals/does-not-exist" });
    expect(unknownApproval.statusCode).toBe(404);
  });
});
