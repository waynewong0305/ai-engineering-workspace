import { randomUUID } from "node:crypto";
import { eq, inArray, isNull } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  agentRuns,
  buildRuns,
  experiments,
  maintenanceAudit,
  tasks,
  worktreeUsages,
} from "../db/schema.js";

export type StartupRecoverySummary = {
  agentRuns: number;
  tasks: number;
  builds: number;
  merges: number;
  experiments: number;
  usageLeases: number;
};

export function recoverInterruptedState(
  db: WorkspaceDatabase,
  occurredAt = new Date().toISOString(),
): StartupRecoverySummary {
  const activeAgentRuns = db.select({ id: agentRuns.id }).from(agentRuns)
    .where(inArray(agentRuns.status, ["QUEUED", "RUNNING"])).all();
  const activeTasks = db.select({ id: tasks.id }).from(tasks)
    .where(inArray(tasks.status, ["ANALYZING", "CROSS_REVIEW"])).all();
  const activeBuilds = db.select({ id: buildRuns.id }).from(buildRuns)
    .where(inArray(buildRuns.status, ["BUILDING", "VALIDATING", "REVIEWING", "RESPONDING"])).all();
  const activeMerges = db.select({ id: buildRuns.id }).from(buildRuns)
    .where(eq(buildRuns.mergeStatus, "MERGING")).all();
  const activeExperiments = db.select({ id: experiments.id }).from(experiments)
    .where(inArray(experiments.status, ["RUNNING", "REVIEWING"])).all();
  const activeLeases = db.select({ id: worktreeUsages.id }).from(worktreeUsages)
    .where(isNull(worktreeUsages.endedAt)).all();

  const interruptionMessage = "The server restarted while this work was active. Completed output and artifacts were preserved; inspect them before retrying.";
  db.transaction((transaction) => {
    for (const run of activeAgentRuns) {
      transaction.update(agentRuns).set({
        status: "FAILED", errorMessage: interruptionMessage, completedAt: occurredAt, updatedAt: occurredAt,
      }).where(eq(agentRuns.id, run.id)).run();
    }
    for (const task of activeTasks) {
      transaction.update(tasks).set({ status: "FAILED", errorMessage: interruptionMessage, updatedAt: occurredAt })
        .where(eq(tasks.id, task.id)).run();
    }
    for (const build of activeBuilds) {
      transaction.update(buildRuns).set({ status: "FAILED", errorMessage: interruptionMessage, updatedAt: occurredAt })
        .where(eq(buildRuns.id, build.id)).run();
    }
    for (const merge of activeMerges) {
      transaction.update(buildRuns).set({
        mergeStatus: "MERGE_FAILED", mergeError: interruptionMessage, updatedAt: occurredAt,
      }).where(eq(buildRuns.id, merge.id)).run();
    }
    for (const experiment of activeExperiments) {
      transaction.update(experiments).set({ status: "FAILED", errorMessage: interruptionMessage, updatedAt: occurredAt })
        .where(eq(experiments.id, experiment.id)).run();
    }
    for (const lease of activeLeases) {
      transaction.update(worktreeUsages).set({ endedAt: occurredAt }).where(eq(worktreeUsages.id, lease.id)).run();
    }

    const summary = {
      agentRuns: activeAgentRuns.length,
      tasks: activeTasks.length,
      builds: activeBuilds.length,
      merges: activeMerges.length,
      experiments: activeExperiments.length,
      usageLeases: activeLeases.length,
    };
    if (Object.values(summary).some((count) => count > 0)) {
      transaction.insert(maintenanceAudit).values({
        id: randomUUID(), category: "RECOVERY", action: "INTERRUPTED_STATE_RECOVERED",
        entityType: "WORKSPACE", entityId: null, detail: summary, createdAt: occurredAt,
      }).run();
    }
  });

  return {
    agentRuns: activeAgentRuns.length,
    tasks: activeTasks.length,
    builds: activeBuilds.length,
    merges: activeMerges.length,
    experiments: activeExperiments.length,
    usageLeases: activeLeases.length,
  };
}
