import type { AgentProvider } from "@aiew/agents";
import { asc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  evidenceItems,
  taskArtifacts,
  taskComparisons,
  tasks,
  type BrainstormAnalysis,
  type CrossReview,
  type EvidenceItemRecord,
  type RiskLevel,
  type TaskComparison,
  type TaskRecord,
  type TaskStatus,
  type TaskType,
} from "../db/schema.js";

export type BrainstormPlanReport = {
  generatedAt: string;
  taskId: string;
  taskTitle: string;
  taskType: TaskType;
  problemStatement: string;
  riskLevel: RiskLevel;
  status: TaskStatus;
  analyses: {
    provider: AgentProvider;
    data: BrainstormAnalysis | null;
    rawOutput: string;
    parseError: string | null;
  }[];
  crossReviews: {
    provider: AgentProvider;
    targetProvider: AgentProvider | null;
    data: CrossReview | null;
    rawOutput: string;
    parseError: string | null;
  }[];
  comparison: TaskComparison | null;
  evidence: EvidenceItemRecord[];
  humanDecisionRequired: true;
  recommendedNextAction: string;
};

function recommendNextAction(task: TaskRecord, hasComparison: boolean): string {
  switch (task.status) {
    case "READY":
      return hasComparison
        ? "Review the consensus, disagreements, and open questions below, then decide whether to start a build for one of the analyzed options."
        : "The workflow reached READY but produced no comparison — inspect the individual analyses and cross-reviews directly.";
    case "CHECKPOINTED":
      return `This task is paused on a usage-safety checkpoint${task.errorMessage ? `: ${task.errorMessage}` : "."} Resume it to complete the workflow, or export this partial plan now.`;
    case "FAILED":
      return `The brainstorm workflow failed${task.errorMessage ? `: ${task.errorMessage}` : "."} Inspect what completed below before deciding whether to retry.`;
    case "CANCELLED":
      return "This task was cancelled. Inspect what completed below before deciding whether to restart.";
    case "ANALYZING":
    case "CROSS_REVIEW":
      return "This task is still running — export again once it reaches READY for a complete plan.";
    default:
      return "This task has not been started yet — there is nothing to export.";
  }
}

/**
 * A brainstorm/architecture task never has a single fixed reviewer the way a build does — both
 * providers analyze independently and critique each other — so unlike buildPrePrReport this report
 * has no accepted/rejected finding split, only the two analyses, the two cross-reviews, and the
 * comparison already computed by BrainstormWorkflow. Partial data (a failed or in-progress task) is
 * still exported rather than blocked, mirroring how the task detail UI never hides what completed.
 */
export function buildBrainstormPlanReport(db: WorkspaceDatabase, taskId: string): BrainstormPlanReport | null {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!task) return null;

  const artifacts = db.select().from(taskArtifacts).where(eq(taskArtifacts.taskId, task.id)).orderBy(asc(taskArtifacts.createdAt)).all();
  const comparison = db.select().from(taskComparisons).where(eq(taskComparisons.taskId, task.id)).get()?.content ?? null;
  const evidence = db.select().from(evidenceItems).where(eq(evidenceItems.taskId, task.id)).orderBy(asc(evidenceItems.createdAt)).all();

  return {
    generatedAt: new Date().toISOString(),
    taskId: task.id,
    taskTitle: task.title,
    taskType: task.type,
    problemStatement: task.problemStatement,
    riskLevel: task.riskLevel,
    status: task.status,
    analyses: artifacts
      .filter((artifact) => artifact.kind === "ANALYSIS")
      .map((artifact) => ({
        provider: artifact.provider,
        data: artifact.structuredData as BrainstormAnalysis | null,
        rawOutput: artifact.rawOutput,
        parseError: artifact.parseError,
      })),
    crossReviews: artifacts
      .filter((artifact) => artifact.kind === "CROSS_REVIEW")
      .map((artifact) => ({
        provider: artifact.provider,
        targetProvider: artifact.targetProvider,
        data: artifact.structuredData as CrossReview | null,
        rawOutput: artifact.rawOutput,
        parseError: artifact.parseError,
      })),
    comparison,
    evidence,
    humanDecisionRequired: true,
    recommendedNextAction: recommendNextAction(task, comparison !== null),
  };
}
