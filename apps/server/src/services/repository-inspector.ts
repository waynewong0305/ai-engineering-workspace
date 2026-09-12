import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RepositorySnapshot = {
  repositoryPath: string;
  repositoryName: string;
  currentBranch: string;
  defaultBranch: string;
  worktreeRoot: string;
  gitStatus: "CLEAN" | "DIRTY";
  changedFiles: number;
};

export class RepositoryInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryInspectionError";
  }
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repositoryPath, ...args], {
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new RepositoryInspectionError("The selected path is not a readable Git repository.");
  }
}

async function detectDefaultBranch(repositoryPath: string, currentBranch: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repositoryPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { encoding: "utf8", timeout: 8_000 },
    );
    return stdout.trim().replace(/^origin\//, "") || currentBranch;
  } catch {
    return currentBranch;
  }
}

export async function inspectRepository(inputPath: string): Promise<RepositorySnapshot> {
  const candidate = inputPath.trim();
  if (!candidate || !isAbsolute(candidate)) {
    throw new RepositoryInspectionError("Repository path must be an absolute path.");
  }

  let repositoryPath: string;
  try {
    const pathStats = await stat(candidate);
    if (!pathStats.isDirectory()) throw new Error("not a directory");
    repositoryPath = await realpath(candidate);
  } catch {
    throw new RepositoryInspectionError("Repository path does not exist or is not a directory.");
  }

  const isWorkTree = await git(repositoryPath, ["rev-parse", "--is-inside-work-tree"]);
  if (isWorkTree !== "true") {
    throw new RepositoryInspectionError("The selected path is not a Git working tree.");
  }

  const currentBranch = (await git(repositoryPath, ["branch", "--show-current"])) || "DETACHED";
  const defaultBranch = await detectDefaultBranch(repositoryPath, currentBranch);
  const statusOutput = await git(repositoryPath, ["status", "--porcelain=v1"]);
  const changedFiles = statusOutput ? statusOutput.split("\n").length : 0;

  return {
    repositoryPath,
    repositoryName: basename(repositoryPath),
    currentBranch,
    defaultBranch,
    worktreeRoot: join(dirname(repositoryPath), ".ai-worktrees", basename(repositoryPath)),
    gitStatus: changedFiles === 0 ? "CLEAN" : "DIRTY",
    changedFiles,
  };
}

