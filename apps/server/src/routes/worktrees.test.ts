import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-worktree-api-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  return { repositoryPath, worktreeRoot: join(dirname(repositoryPath), `${repositoryPath.split("/").at(-1)}-managed`) };
}

describe("worktree routes", () => {
  it("previews, creates, inspects, renames, and safely removes isolated worktrees", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const fixture = await createRepository();
    const projectResponse = await app.inject({
      method: "POST", url: "/api/projects",
      payload: { repositoryPath: fixture.repositoryPath, worktreeRoot: fixture.worktreeRoot },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json();
    const taskResponse = await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Add promotion versioning", problemStatement: "Isolate implementation work.",
        type: "ARCHITECTURE", riskLevel: "MEDIUM", webAccessPermitted: false,
      },
    });
    const task = taskResponse.json();

    const previewResponse = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees/preview` });
    expect(previewResponse.statusCode).toBe(200);
    const proposals = previewResponse.json().proposals;
    expect(proposals).toHaveLength(2);
    expect(proposals.every((proposal: { available: boolean }) => proposal.available)).toBe(true);
    expect(proposals[0].path).toContain("add-promotion-versioning");
    expect(proposals[0].branchName).toMatch(/^ai\/TASK-/);

    const created = [];
    for (const proposal of proposals) {
      const response = await app.inject({
        method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: proposal,
      });
      expect(response.statusCode).toBe(201);
      created.push(response.json());
    }
    expect(created.map((record) => record.provider)).toEqual(["CLAUDE", "CODEX"]);
    expect(created.every((record) => record.inspection.gitStatus === "CLEAN")).toBe(true);

    const projectWorktrees = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/worktrees` })).json();
    expect(projectWorktrees.managed).toHaveLength(2);
    expect(projectWorktrees.gitWorktrees).toHaveLength(3);
    expect((await execFileAsync("git", ["-C", fixture.repositoryPath, "status", "--porcelain=v1"])).stdout).toBe("");

    const codex = created.find((record) => record.provider === "CODEX");
    const movedPath = join(fixture.worktreeRoot, "TASK-renamed", "codex-location");
    const moveResponse = await app.inject({
      method: "PATCH", url: `/api/worktrees/${codex.id}/path`, payload: { path: movedPath },
    });
    expect(moveResponse.statusCode).toBe(200);
    const moved = moveResponse.json();
    expect(moved.path).toContain("TASK-renamed/codex-location");
    expect(moved.branchName).toBe(codex.branchName);

    const renamedBranch = `${codex.branchName}-review`;
    const branchResponse = await app.inject({
      method: "PATCH", url: `/api/worktrees/${codex.id}/branch`, payload: { branchName: renamedBranch },
    });
    expect(branchResponse.statusCode).toBe(200);
    expect(branchResponse.json()).toMatchObject({ path: moved.path, branchName: renamedBranch });

    const claude = created.find((record) => record.provider === "CLAUDE");
    const original = await readFile(join(claude.path, "README.md"), "utf8");
    await writeFile(join(claude.path, "README.md"), `${original}uncommitted\n`, "utf8");
    const dirtyRemoval = await app.inject({
      method: "DELETE", url: `/api/worktrees/${claude.id}`, payload: { confirm: true, deleteBranch: false },
    });
    expect(dirtyRemoval.statusCode).toBe(409);
    expect(dirtyRemoval.json().code).toBe("WORKTREE_DIRTY");
    await writeFile(join(claude.path, "README.md"), original, "utf8");

    const unconfirmedRemoval = await app.inject({
      method: "DELETE", url: `/api/worktrees/${claude.id}`, payload: { confirm: false },
    });
    expect(unconfirmedRemoval.statusCode).toBe(400);
    const claudeRemoval = await app.inject({
      method: "DELETE", url: `/api/worktrees/${claude.id}`, payload: { confirm: true, deleteBranch: false },
    });
    expect(claudeRemoval.json()).toMatchObject({ removed: true, retainedBranch: claude.branchName, deletedBranch: false });
    const codexRemoval = await app.inject({
      method: "DELETE", url: `/api/worktrees/${codex.id}`, payload: { confirm: true, deleteBranch: true },
    });
    expect(codexRemoval.json()).toMatchObject({ removed: true, retainedBranch: renamedBranch, deletedBranch: true });

    const finalList = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/worktrees` })).json();
    expect(finalList.managed).toEqual([]);
    expect(finalList.gitWorktrees).toHaveLength(1);
    const retained = await execFileAsync("git", ["-C", fixture.repositoryPath, "show-ref", "--verify", `refs/heads/${claude.branchName}`]);
    expect(retained.stdout).toContain(claude.branchName);
  });

  it("recovers an orphaned managed-worktree record instead of permanently blocking its task/provider slot", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const fixture = await createRepository();
    const project = (await app.inject({
      method: "POST", url: "/api/projects",
      payload: { repositoryPath: fixture.repositoryPath, worktreeRoot: fixture.worktreeRoot },
    })).json();
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Add promotion versioning", problemStatement: "Recover an interrupted worktree.",
        type: "ARCHITECTURE", riskLevel: "MEDIUM", webAccessPermitted: false,
      },
    })).json();
    const proposals = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees/preview` })).json().proposals;
    const claudeProposal = proposals.find((proposal: { provider: string }) => proposal.provider === "CLAUDE");
    const created = (await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: claudeProposal,
    })).json();

    // Simulate the record becoming orphaned: Git no longer lists this worktree (an interrupted
    // creation, or a worktree removed outside the application), but the managed record remains.
    await execFileAsync("git", ["-C", fixture.repositoryPath, "worktree", "remove", "--force", "--", created.path]);

    const blockedRetry = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: claudeProposal });
    expect(blockedRetry.statusCode).toBe(409);
    expect(blockedRetry.json().code).toBe("WORKTREE_SLOT_ACTIVE");

    const removal = await app.inject({
      method: "DELETE", url: `/api/worktrees/${created.id}`, payload: { confirm: true, deleteBranch: false },
    });
    expect(removal.statusCode).toBe(200);
    expect(removal.json()).toMatchObject({ removed: false, forgotten: true });

    const afterRemoval = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees` });
    expect(afterRemoval.json()).toEqual([]);

    // The DB slot for this task/provider is free again, but Git still remembers the abandoned
    // branch from the interrupted attempt, so the identical auto-generated proposal correctly
    // still collides at the branch level -- recovery never silently reuses stale branch history.
    const retryPreview = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees/preview` })).json().proposals;
    const retryClaude = retryPreview.find((proposal: { provider: string }) => proposal.provider === "CLAUDE");
    expect(retryClaude.available).toBe(false);

    const recreated = await app.inject({
      method: "POST", url: `/api/tasks/${task.id}/worktrees`,
      payload: { ...claudeProposal, branchName: `${claudeProposal.branchName}-retry` },
    });
    expect(recreated.statusCode).toBe(201);
  });

  it("gives a specific, actionable conflict for a worktree slot that failed to create, and recovers it", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const fixture = await createRepository();
    const project = (await app.inject({
      method: "POST", url: "/api/projects",
      payload: { repositoryPath: fixture.repositoryPath, worktreeRoot: fixture.worktreeRoot },
    })).json();
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Force a stuck worktree slot", problemStatement: "Recover a failed creation.",
        type: "ARCHITECTURE", riskLevel: "MEDIUM", webAccessPermitted: false,
      },
    })).json();
    const proposals = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees/preview` })).json().proposals;
    const claudeProposal = proposals.find((proposal: { provider: string }) => proposal.provider === "CLAUDE");

    // Force a real, post-validation creation failure: put a plain file exactly where the app's own
    // deterministic naming scheme (<worktreeRoot>/TASK-<id>-<slug>/<role>) needs a directory, so
    // WorktreeService.create()'s own mkdir fails after validateProposal has already passed.
    const taskDirPath = dirname(claudeProposal.path);
    await mkdir(fixture.worktreeRoot, { recursive: true });
    await writeFile(taskDirPath, "not a directory", "utf8");

    // The underlying failure is a raw filesystem error (not a WorktreeSafetyError), so it surfaces
    // as an honest 500 rather than a fabricated 4xx — but the record is still correctly marked
    // ERROR with the real cause, and the slot is recoverable exactly like any other failed creation.
    const failedCreate = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: claudeProposal });
    expect(failedCreate.statusCode).toBe(500);
    const stuck = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees` })).json();
    expect(stuck).toHaveLength(1);
    expect(stuck[0].status).toBe("ERROR");
    expect(stuck[0].lastError).toBeTruthy();

    // Retrying without cleaning up first gives a specific, actionable conflict — not the previous
    // generic "already managed" database-constraint message — naming the stuck record and the fix.
    const retryWithoutFix = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: claudeProposal });
    expect(retryWithoutFix.statusCode).toBe(409);
    expect(retryWithoutFix.json().code).toBe("WORKTREE_SLOT_FAILED");
    expect(retryWithoutFix.json().message).toContain(stuck[0].id);

    const removal = await app.inject({
      method: "DELETE", url: `/api/worktrees/${stuck[0].id}`, payload: { confirm: true, deleteBranch: false },
    });
    expect(removal.statusCode).toBe(200);
    expect(removal.json()).toMatchObject({ removed: false, forgotten: true });

    await rm(taskDirPath, { force: true });
    const recreated = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: claudeProposal });
    expect(recreated.statusCode).toBe(201);
  });

  it("resolves a concurrent double-create race for the same task/provider slot with one winner and a clear conflict", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const fixture = await createRepository();
    const project = (await app.inject({
      method: "POST", url: "/api/projects",
      payload: { repositoryPath: fixture.repositoryPath, worktreeRoot: fixture.worktreeRoot },
    })).json();
    const task = (await app.inject({
      method: "POST", url: "/api/tasks",
      payload: {
        projectId: project.id, title: "Race two creates", problemStatement: "Prove the conflict is handled cleanly.",
        type: "ARCHITECTURE", riskLevel: "MEDIUM", webAccessPermitted: false,
      },
    })).json();
    const proposals = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees/preview` })).json().proposals;
    const claudeProposal = proposals.find((proposal: { provider: string }) => proposal.provider === "CLAUDE");

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: claudeProposal }),
      app.inject({ method: "POST", url: `/api/tasks/${task.id}/worktrees`, payload: claudeProposal }),
    ]);
    const statusCodes = [first.statusCode, second.statusCode].sort();
    expect(statusCodes).toEqual([201, 409]);
    const loser = first.statusCode === 409 ? first : second;
    expect(loser.json().code).toMatch(/^WORKTREE_SLOT_/);

    // Only one managed worktree, and one Git worktree beyond the source checkout, ever exist.
    const managed = (await app.inject({ method: "GET", url: `/api/tasks/${task.id}/worktrees` })).json();
    expect(managed).toHaveLength(1);
    expect(managed[0].status).toBe("ACTIVE");
  });
});
