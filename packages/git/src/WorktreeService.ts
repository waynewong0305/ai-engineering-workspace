import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 10 * 1024 * 1024;

export type WorktreeProvider = "CLAUDE" | "CODEX";

export type WorktreeProposal = {
  provider: WorktreeProvider;
  path: string;
  branchName: string;
  baseRef: string;
};

export type GitWorktreeEntry = {
  path: string;
  head: string | null;
  branchName: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
};

export type WorktreeInspection = GitWorktreeEntry & {
  registered: boolean;
  gitStatus: "CLEAN" | "DIRTY";
  porcelain: string;
};

export class WorktreeSafetyError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "WorktreeSafetyError";
  }
}

type GitResult = { stdout: string; stderr: string; exitCode: number };

async function git(cwd: string, args: string[], allowedExitCodes: number[] = [0]): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
      timeout: 30_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number };
    const exitCode = typeof candidate.code === "number" ? candidate.code : -1;
    if (allowedExitCodes.includes(exitCode)) {
      return { stdout: candidate.stdout ?? "", stderr: candidate.stderr ?? "", exitCode };
    }
    const detail = (candidate.stderr || candidate.message || "Git command failed.").trim();
    throw new WorktreeSafetyError(detail, "GIT_COMMAND_FAILED");
  }
}

function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function exists(path: string) {
  return Boolean(await lstat(path).catch(() => null));
}

async function canonicalWithMissing(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (!(await exists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  const canonicalParent = await realpath(cursor).catch(() => cursor);
  return resolve(canonicalParent, ...missing);
}

function parseWorktreeList(output: string): GitWorktreeEntry[] {
  return output.trim().split(/\n\s*\n/).flatMap((block) => {
    if (!block.trim()) return [];
    const fields = new Map<string, string>();
    const flags = new Set<string>();
    for (const line of block.split("\n")) {
      const space = line.indexOf(" ");
      if (space === -1) flags.add(line);
      else fields.set(line.slice(0, space), line.slice(space + 1));
    }
    const path = fields.get("worktree");
    if (!path) return [];
    const branch = fields.get("branch");
    return [{
      path,
      head: fields.get("HEAD") ?? null,
      branchName: branch?.replace(/^refs\/heads\//, "") ?? null,
      detached: flags.has("detached"),
      bare: flags.has("bare"),
      locked: flags.has("locked") || fields.has("locked"),
      prunable: flags.has("prunable") || fields.has("prunable"),
    }];
  });
}

export function slugifyTaskTitle(title: string) {
  return title.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "") || "task";
}

export function taskKey(taskId: string) {
  const normalized = taskId.trim().toUpperCase().replace(/[^A-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.startsWith("TASK-") ? normalized.slice(0, 40) : `TASK-${normalized.split("-")[0]?.slice(0, 12) || "UNKNOWN"}`;
}

export function proposeWorktree(
  worktreeRoot: string,
  taskId: string,
  taskTitle: string,
  provider: WorktreeProvider,
  baseRef: string,
): WorktreeProposal {
  const key = taskKey(taskId);
  const slug = slugifyTaskTitle(taskTitle);
  const role = provider.toLowerCase();
  return {
    provider,
    path: join(resolve(worktreeRoot), `${key}-${slug}`, role),
    branchName: `ai/${key}/${slug}/${role}`,
    baseRef,
  };
}

export class WorktreeService {
  async list(repositoryPath: string) {
    return parseWorktreeList((await git(repositoryPath, ["worktree", "list", "--porcelain"])).stdout);
  }

  async validateProposal(repositoryPath: string, worktreeRoot: string, proposal: WorktreeProposal) {
    if (!isAbsolute(proposal.path)) throw new WorktreeSafetyError("Worktree path must be absolute.", "INVALID_PATH");
    if (!proposal.branchName.trim() || proposal.branchName.startsWith("-")) {
      throw new WorktreeSafetyError("Branch name is invalid.", "INVALID_BRANCH");
    }
    const canonicalRepository = await realpath(repositoryPath);
    const canonicalRoot = await canonicalWithMissing(worktreeRoot);
    const canonicalTarget = await canonicalWithMissing(proposal.path);
    if (!inside(canonicalRoot, canonicalTarget)) {
      throw new WorktreeSafetyError("Worktree path must stay inside the configured worktree root.", "PATH_OUTSIDE_ROOT");
    }
    if (canonicalTarget === canonicalRepository || inside(canonicalRepository, canonicalTarget)) {
      throw new WorktreeSafetyError("Worktree path must stay outside the source repository.", "PATH_INSIDE_REPOSITORY");
    }
    if (await exists(canonicalTarget)) throw new WorktreeSafetyError("Worktree path already exists.", "PATH_COLLISION");

    const branchCheck = await git(repositoryPath, ["check-ref-format", "--branch", proposal.branchName], [0, 128]);
    if (branchCheck.exitCode !== 0) throw new WorktreeSafetyError("Branch name is not a valid Git branch.", "INVALID_BRANCH");
    const branchExists = await git(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${proposal.branchName}`], [0, 1]);
    if (branchExists.exitCode === 0) throw new WorktreeSafetyError("Branch name already exists.", "BRANCH_COLLISION");
    const base = await git(repositoryPath, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${proposal.baseRef}^{commit}`], [0, 1]);
    if (base.exitCode !== 0) throw new WorktreeSafetyError("Base branch or ref does not resolve to a commit.", "INVALID_BASE_REF");
    const registered = (await this.list(repositoryPath)).some((entry) => resolve(entry.path) === canonicalTarget);
    if (registered) throw new WorktreeSafetyError("Git already has a worktree registered at this path.", "WORKTREE_COLLISION");
    return { path: canonicalTarget, branchName: proposal.branchName, baseRef: proposal.baseRef };
  }

  async create(repositoryPath: string, worktreeRoot: string, proposal: WorktreeProposal) {
    const validated = await this.validateProposal(repositoryPath, worktreeRoot, proposal);
    await mkdir(dirname(validated.path), { recursive: true });
    await git(repositoryPath, ["worktree", "add", "-b", validated.branchName, "--", validated.path, validated.baseRef]);
    return this.inspect(repositoryPath, validated.path);
  }

  async inspect(repositoryPath: string, worktreePath: string): Promise<WorktreeInspection> {
    const canonicalPath = await realpath(worktreePath).catch(() => resolve(worktreePath));
    const entry = (await this.list(repositoryPath)).find((candidate) => resolve(candidate.path) === canonicalPath);
    if (!entry) throw new WorktreeSafetyError("Git no longer lists this worktree.", "WORKTREE_NOT_REGISTERED");
    const porcelain = (await git(canonicalPath, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
    return { ...entry, registered: true, gitStatus: porcelain.trim() ? "DIRTY" : "CLEAN", porcelain };
  }

  async diff(worktreePath: string) {
    const [unstaged, staged] = await Promise.all([
      git(worktreePath, ["diff", "--no-ext-diff", "--"]),
      git(worktreePath, ["diff", "--cached", "--no-ext-diff", "--"]),
    ]);
    return { unstaged: unstaged.stdout, staged: staged.stdout };
  }

  async move(repositoryPath: string, worktreeRoot: string, oldPath: string, newPath: string, inUse: boolean) {
    if (inUse) throw new WorktreeSafetyError("An active process is using this worktree.", "WORKTREE_IN_USE");
    const current = await this.inspect(repositoryPath, oldPath);
    if (current.gitStatus !== "CLEAN") throw new WorktreeSafetyError("A dirty worktree cannot be moved.", "WORKTREE_DIRTY");
    const branchName = current.branchName;
    if (!branchName) throw new WorktreeSafetyError("A detached worktree cannot be managed by this workflow.", "DETACHED_WORKTREE");
    const validated = await this.validateTargetPath(repositoryPath, worktreeRoot, newPath);
    await mkdir(dirname(validated), { recursive: true });
    await git(repositoryPath, ["worktree", "move", "--", oldPath, validated]);
    return this.inspect(repositoryPath, validated);
  }

  async renameBranch(repositoryPath: string, worktreePath: string, newBranchName: string, inUse: boolean) {
    if (inUse) throw new WorktreeSafetyError("An active process is using this worktree.", "WORKTREE_IN_USE");
    const current = await this.inspect(repositoryPath, worktreePath);
    if (current.gitStatus !== "CLEAN") throw new WorktreeSafetyError("A dirty worktree cannot rename its branch.", "WORKTREE_DIRTY");
    if (!newBranchName.trim() || newBranchName.startsWith("-")) throw new WorktreeSafetyError("Branch name is invalid.", "INVALID_BRANCH");
    const format = await git(repositoryPath, ["check-ref-format", "--branch", newBranchName], [0, 128]);
    if (format.exitCode !== 0) throw new WorktreeSafetyError("Branch name is not a valid Git branch.", "INVALID_BRANCH");
    const collision = await git(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${newBranchName}`], [0, 1]);
    if (collision.exitCode === 0) throw new WorktreeSafetyError("Branch name already exists.", "BRANCH_COLLISION");
    await git(worktreePath, ["branch", "-m", newBranchName]);
    return this.inspect(repositoryPath, worktreePath);
  }

  async remove(repositoryPath: string, worktreePath: string, inUse: boolean) {
    if (inUse) throw new WorktreeSafetyError("An active process is using this worktree.", "WORKTREE_IN_USE");
    const current = await this.inspect(repositoryPath, worktreePath);
    if (current.gitStatus !== "CLEAN") throw new WorktreeSafetyError("A dirty worktree cannot be removed.", "WORKTREE_DIRTY");
    await git(repositoryPath, ["worktree", "remove", "--", worktreePath]);
    return { removed: true, retainedBranch: current.branchName };
  }

  async deleteMergedBranch(repositoryPath: string, branchName: string, baseRef: string) {
    await this.ensureBranchMerged(repositoryPath, branchName, baseRef);
    await git(repositoryPath, ["branch", "-d", "--", branchName]);
  }

  async ensureBranchMerged(repositoryPath: string, branchName: string, baseRef: string) {
    const merged = await git(repositoryPath, ["merge-base", "--is-ancestor", branchName, baseRef], [0, 1]);
    if (merged.exitCode !== 0) throw new WorktreeSafetyError("The task branch is not merged into its base ref.", "BRANCH_NOT_MERGED");
  }

  private async validateTargetPath(repositoryPath: string, worktreeRoot: string, targetPath: string) {
    if (!isAbsolute(targetPath)) throw new WorktreeSafetyError("Worktree path must be absolute.", "INVALID_PATH");
    const canonicalRepository = await realpath(repositoryPath);
    const canonicalRoot = await canonicalWithMissing(worktreeRoot);
    const canonicalTarget = await canonicalWithMissing(targetPath);
    if (!inside(canonicalRoot, canonicalTarget)) throw new WorktreeSafetyError("Worktree path must stay inside the configured worktree root.", "PATH_OUTSIDE_ROOT");
    if (canonicalTarget === canonicalRepository || inside(canonicalRepository, canonicalTarget)) {
      throw new WorktreeSafetyError("Worktree path must stay outside the source repository.", "PATH_INSIDE_REPOSITORY");
    }
    if (await exists(canonicalTarget)) throw new WorktreeSafetyError("Worktree path already exists.", "PATH_COLLISION");
    return canonicalTarget;
  }
}
