import { describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import {
  agentRuns,
  buildRuns,
  experiments,
  maintenanceAudit,
  projects,
  tasks,
  worktrees,
  worktreeUsages,
} from "../db/schema.js";
import { recoverInterruptedState } from "./startup-recovery.js";

describe("recoverInterruptedState", () => {
  it("fails interrupted work while preserving records and releases process leases", () => {
    const { db, sqlite } = createDatabase(":memory:");
    const before = "2026-09-13T09:00:00.000Z";
    const recoveredAt = "2026-09-13T10:00:00.000Z";
    db.insert(projects).values({
      id: "project", name: "Fixture", repositoryPath: "/tmp/fixture", defaultBranch: "main",
      currentBranch: "main", worktreeRoot: "/tmp/worktrees", projectContext: null,
      validationCommands: [], gitStatus: "CLEAN", createdAt: before, updatedAt: before,
    }).run();
    db.insert(tasks).values({
      id: "task", projectId: "project", title: "Interrupted task", problemStatement: "Recover it",
      type: "ARCHITECTURE", status: "ANALYZING", riskLevel: "MEDIUM",
      webAccessPolicy: "DISABLED", webAccessPermitted: false, webAccessDecidedAt: before,
      webAccessDecidedBy: "USER", originAdrId: null, planPhase: null, errorMessage: null,
      createdAt: before, updatedAt: before,
    }).run();
    db.insert(worktrees).values({
      id: "worktree", taskId: "task", projectId: "project", provider: "CLAUDE",
      path: "/tmp/worktrees/task", branchName: "ai/task", baseRef: "main", status: "ACTIVE",
      lastError: null, createdAt: before, updatedAt: before,
    }).run();
    db.insert(agentRuns).values({
      id: "run", projectId: "project", taskId: "task", worktreeId: "worktree", provider: "CLAUDE",
      role: "BUILD", targetProvider: null, prompt: "Build", promptVersion: "test:v1",
      requestedModel: "(provider default)", actualModel: null, effort: null,
      permissionProfile: "WORKTREE_WRITE", webAccessPolicy: "DISABLED", webAccessPermitted: false,
      status: "RUNNING", output: "partial output", rawOutput: "", errorOutput: "",
      errorMessage: null, exitCode: null, cliVersion: null, durationMs: null, startedAt: before,
      completedAt: null, createdAt: before, updatedAt: before,
    }).run();
    db.insert(buildRuns).values({
      id: "build", taskId: "task", projectId: "project", builderProvider: "CLAUDE",
      reviewerProvider: "CODEX", worktreeId: "worktree", builderRunId: "run", reviewerRunId: null,
      status: "BUILDING", diffUnstaged: null, diffStaged: null, reviewRound: 1,
      maxReviewRounds: 3, mergeStatus: "MERGING", mergeTargetBranch: "main",
      mergeCommitSha: null, mergedAt: null, mergeError: null, mergeTargetCheckedOutAt: null,
      worktreeRemovedAfterMerge: null, branchDeletedAfterMerge: null,
      worktreeCleanupSkippedReason: null, errorMessage: null, createdAt: before, updatedAt: before,
    }).run();
    db.insert(experiments).values({
      id: "experiment", taskId: "task", projectId: "project", hypothesis: "It works",
      builderProvider: "CLAUDE", reviewerProvider: "CODEX", worktreeId: "worktree",
      builderRunId: "run", reviewerRunId: null, status: "RUNNING", diffUnstaged: null,
      diffStaged: null, testExecuted: null, result: null, conclusion: null, verdict: null,
      evidenceItemId: null, errorMessage: null, createdAt: before, updatedAt: before,
    }).run();
    db.insert(worktreeUsages).values({
      id: "lease", worktreeId: "worktree", ownerType: "AGENT_RUN", ownerId: "run",
      startedAt: before, endedAt: null,
    }).run();

    expect(recoverInterruptedState(db, recoveredAt)).toEqual({
      agentRuns: 1, tasks: 1, builds: 1, merges: 1, experiments: 1, usageLeases: 1,
    });
    expect(db.select().from(agentRuns).get()).toMatchObject({
      status: "FAILED", output: "partial output", completedAt: recoveredAt,
    });
    expect(db.select().from(tasks).get()).toMatchObject({ status: "FAILED" });
    expect(db.select().from(buildRuns).get()).toMatchObject({
      status: "FAILED", mergeStatus: "MERGE_FAILED",
    });
    expect(db.select().from(experiments).get()).toMatchObject({ status: "FAILED" });
    expect(db.select().from(worktreeUsages).get()).toMatchObject({ endedAt: recoveredAt });
    expect(db.select().from(maintenanceAudit).get()).toMatchObject({
      category: "RECOVERY", action: "INTERRUPTED_STATE_RECOVERED",
      detail: { agentRuns: 1, tasks: 1, builds: 1, merges: 1, experiments: 1, usageLeases: 1 },
    });

    expect(recoverInterruptedState(db, recoveredAt)).toEqual({
      agentRuns: 0, tasks: 0, builds: 0, merges: 0, experiments: 0, usageLeases: 0,
    });
    expect(db.select().from(maintenanceAudit).all()).toHaveLength(1);
    sqlite.close();
  });
});
