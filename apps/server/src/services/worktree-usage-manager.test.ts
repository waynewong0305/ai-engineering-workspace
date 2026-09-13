import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { projects, tasks, worktrees } from "../db/schema.js";
import { WorktreeUsageManager } from "./worktree-usage-manager.js";

const databases: Array<ReturnType<typeof createDatabase>["sqlite"]> = [];

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
});

describe("WorktreeUsageManager", () => {
  it("persists idempotent ownership leases and releases them", () => {
    const { db, sqlite } = createDatabase(":memory:");
    databases.push(sqlite);
    const now = new Date().toISOString();
    db.insert(projects).values({
      id: "project", name: "Fixture", repositoryPath: "/tmp/fixture", defaultBranch: "main", currentBranch: "main",
      worktreeRoot: "/tmp/worktrees", projectContext: null, validationCommands: [], gitStatus: "CLEAN", createdAt: now, updatedAt: now,
    }).run();
    db.insert(tasks).values({
      id: "task", projectId: "project", title: "Fixture task", problemStatement: "Test leases.", type: "ARCHITECTURE",
      status: "DRAFT", riskLevel: "LOW", webAccessPolicy: "DISABLED", webAccessPermitted: false,
      webAccessDecidedAt: now, webAccessDecidedBy: "USER", errorMessage: null, createdAt: now, updatedAt: now,
    }).run();
    db.insert(worktrees).values({
      id: "worktree", taskId: "task", projectId: "project", provider: "CODEX", path: "/tmp/worktrees/task/codex",
      branchName: "ai/task/codex", baseRef: "main", status: "ACTIVE", lastError: null, createdAt: now, updatedAt: now,
    }).run();

    const manager = new WorktreeUsageManager(db);
    const first = manager.acquire("worktree", "AGENT_RUN", "run-1");
    const duplicate = manager.acquire("worktree", "AGENT_RUN", "run-1");
    expect(duplicate.id).toBe(first.id);
    expect(manager.isInUse("worktree")).toBe(true);
    expect(manager.listActive("worktree")).toHaveLength(1);
    expect(manager.release("worktree", "AGENT_RUN", "run-1")).toBe(true);
    expect(manager.release("worktree", "AGENT_RUN", "run-1")).toBe(false);
    expect(manager.isInUse("worktree")).toBe(false);
  });
});
