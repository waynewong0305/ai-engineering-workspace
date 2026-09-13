import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
});
