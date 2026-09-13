import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { proposeWorktree, slugifyTaskTitle, WorktreeSafetyError, WorktreeService } from "./WorktreeService.js";

const execFileAsync = promisify(execFile);

async function createRepository() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-worktree-source-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Initial"]);
  return { repositoryPath, worktreeRoot: join(dirname(repositoryPath), `${repositoryPath.split("/").at(-1)}-worktrees`) };
}

describe("WorktreeService", () => {
  it("generates meaningful bounded names", () => {
    expect(slugifyTaskTitle("  Design DB sharding & tenant routing!  ")).toBe("design-db-sharding-tenant-routing");
    expect(proposeWorktree("/tmp/worktrees", "204-abcd", "Design DB sharding", "CLAUDE", "main")).toEqual({
      provider: "CLAUDE",
      path: "/tmp/worktrees/TASK-204-design-db-sharding/claude",
      branchName: "ai/TASK-204/design-db-sharding/claude",
      baseRef: "main",
    });
  });

  it("creates isolated worktrees, moves paths independently, and protects dirty or active work", async () => {
    const { repositoryPath, worktreeRoot } = await createRepository();
    const service = new WorktreeService();
    const claude = proposeWorktree(worktreeRoot, "204-abcd", "Design DB sharding", "CLAUDE", "main");
    const codex = proposeWorktree(worktreeRoot, "204-abcd", "Design DB sharding", "CODEX", "main");

    const claudeCreated = await service.create(repositoryPath, worktreeRoot, claude);
    const codexCreated = await service.create(repositoryPath, worktreeRoot, codex);
    expect(claudeCreated).toMatchObject({ branchName: claude.branchName, gitStatus: "CLEAN" });
    expect(codexCreated).toMatchObject({ branchName: codex.branchName, gitStatus: "CLEAN" });
    expect((await service.list(repositoryPath)).map((entry) => entry.branchName)).toEqual(expect.arrayContaining([
      "main", claude.branchName, codex.branchName,
    ]));
    expect((await execFileAsync("git", ["-C", repositoryPath, "status", "--porcelain=v1"])).stdout).toBe("");

    await expect(service.remove(repositoryPath, codex.path, true)).rejects.toMatchObject({ code: "WORKTREE_IN_USE" });
    const movedPath = join(worktreeRoot, "TASK-204-design-db-sharding", "codex-renamed");
    const moved = await service.move(repositoryPath, worktreeRoot, codex.path, movedPath, false);
    expect(moved.path).toBe(await realpath(movedPath));
    expect(moved.branchName).toBe(codex.branchName);

    const renamedBranch = "ai/TASK-204/design-db-sharding/codex-review";
    const renamed = await service.renameBranch(repositoryPath, movedPath, renamedBranch, false);
    expect(renamed.path).toBe(await realpath(movedPath));
    expect(renamed.branchName).toBe(renamedBranch);

    const original = await readFile(join(claude.path, "README.md"), "utf8");
    await writeFile(join(claude.path, "README.md"), `${original}dirty\n`, "utf8");
    await expect(service.remove(repositoryPath, claude.path, false)).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });
    await writeFile(join(claude.path, "README.md"), original, "utf8");

    await expect(service.remove(repositoryPath, claude.path, false)).resolves.toMatchObject({ retainedBranch: claude.branchName });
    await expect(service.remove(repositoryPath, movedPath, false)).resolves.toMatchObject({ retainedBranch: renamedBranch });
    expect((await service.list(repositoryPath)).map((entry) => entry.path)).toEqual([await realpath(repositoryPath)]);
    await expect(service.deleteMergedBranch(repositoryPath, claude.branchName, "main")).resolves.toBeUndefined();
    await expect(service.deleteMergedBranch(repositoryPath, renamedBranch, "main")).resolves.toBeUndefined();
  });

  it("rejects path traversal, invalid refs, and collisions before creation", async () => {
    const { repositoryPath, worktreeRoot } = await createRepository();
    const service = new WorktreeService();
    const proposal = proposeWorktree(worktreeRoot, "300-abcd", "Collision checks", "CLAUDE", "main");

    await expect(service.validateProposal(repositoryPath, worktreeRoot, { ...proposal, path: join(worktreeRoot, "..", "escape") }))
      .rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" } satisfies Partial<WorktreeSafetyError>);
    await expect(service.validateProposal(repositoryPath, worktreeRoot, { ...proposal, branchName: "bad branch" }))
      .rejects.toMatchObject({ code: "INVALID_BRANCH" } satisfies Partial<WorktreeSafetyError>);
    await expect(service.validateProposal(repositoryPath, worktreeRoot, { ...proposal, baseRef: "missing-ref" }))
      .rejects.toMatchObject({ code: "INVALID_BASE_REF" } satisfies Partial<WorktreeSafetyError>);

    await service.create(repositoryPath, worktreeRoot, proposal);
    await expect(service.validateProposal(repositoryPath, worktreeRoot, proposal))
      .rejects.toMatchObject({ code: "PATH_COLLISION" } satisfies Partial<WorktreeSafetyError>);
  });
});
