import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const execFileAsync = promisify(execFile);
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createTestRepository() {
  const repositoryPath = await mkdtemp(join(tmpdir(), "aiew-repo-"));
  await execFileAsync("git", ["init", "-b", "main", repositoryPath]);
  await writeFile(join(repositoryPath, "README.md"), "# Fixture\n", "utf8");
  await execFileAsync("git", ["-C", repositoryPath, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", repositoryPath,
    "-c", "user.name=AI Workspace Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-m", "Initial fixture",
  ]);
  return repositoryPath;
}

describe("project routes", () => {
  it("registers a Git repository without modifying it", async () => {
    const repositoryPath = await createTestRepository();
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Example Project",
        repositoryPath,
        validationCommands: [{ label: "Tests", command: "npm test" }],
      },
    });
    const canonicalRepositoryPath = await realpath(repositoryPath);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: "Example Project",
      repositoryPath: canonicalRepositoryPath,
      currentBranch: "main",
      defaultBranch: "main",
      gitStatus: "CLEAN",
      validationCommands: [{ label: "Tests", command: "npm test" }],
    });

    const status = await execFileAsync("git", ["-C", repositoryPath, "status", "--porcelain=v1"]);
    expect(status.stdout).toBe("");
  });

  it("rejects a path that is not a Git repository", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiew-not-repo-"));
    const app = buildApp({ databasePath: ":memory:" });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repositoryPath: directory },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: "The selected path is not a readable Git repository." });
  });
});
