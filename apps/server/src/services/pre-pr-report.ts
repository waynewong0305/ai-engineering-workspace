import type { AgentProvider } from "@aiew/agents";
import { eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  adrs,
  agentRuns,
  buildRuns,
  reviewFindings,
  tasks,
  validationRuns,
  type AdrStatus,
  type BuildMergeStatus,
  type ReviewFindingRecord,
  type RiskLevel,
  type ValidationRunPhase,
  type ValidationRunStatus,
} from "../db/schema.js";

export type PrePrReport = {
  generatedAt: string;
  taskId: string;
  taskTitle: string;
  problemStatement: string;
  riskLevel: RiskLevel;
  buildRunId: string;
  builderProvider: AgentProvider;
  reviewerProvider: AgentProvider;
  reviewRound: number;
  implementationSummary: string | null;
  filesChanged: string[];
  findings: {
    total: number;
    accepted: ReviewFindingRecord[];
    rejected: ReviewFindingRecord[];
    unresolved: ReviewFindingRecord[];
  };
  tests: {
    commandLabel: string;
    status: ValidationRunStatus;
    exitCode: number | null;
    phase: ValidationRunPhase;
  }[];
  merge: {
    status: BuildMergeStatus;
    targetBranch: string | null;
    commitSha: string | null;
    mergedAt: string | null;
  };
  architectureDecisions: { id: string; number: number; title: string; status: AdrStatus; decision: string }[];
  humanReviewRequired: true;
  recommendedNextAction: string;
};

/**
 * A unified diff never lists a file only in a machine-friendly way we already parse elsewhere, so
 * this extracts changed paths from the two conventional diff-header lines. Deliberately tolerant:
 * an unrecognized line is just skipped rather than failing report generation over a formatting
 * quirk — this is a human-facing summary, not something anything else depends on being exact.
 */
export function parseChangedFiles(diffText: string): string[] {
  const files = new Set<string>();
  for (const line of diffText.split("\n")) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header?.[2]) { files.add(header[2]); continue; }
    const added = line.match(/^\+\+\+ b\/(.+)$/);
    if (added?.[1] && added[1] !== "/dev/null") files.add(added[1]);
  }
  return Array.from(files).sort();
}

function recommendNextAction(hasUnresolved: boolean, mergeStatus: BuildMergeStatus): string {
  if (mergeStatus === "MERGED") {
    return hasUnresolved
      ? "The merge landed with findings still unresolved — inspect the diff and decide whether to address them before this goes further."
      : "Inspect the merge in your normal pull-request process.";
  }
  if (mergeStatus === "MERGE_CONFLICT") return "Resolve the merge conflict, then approve the merge again.";
  if (hasUnresolved) return "Inspect the diff and resolve the remaining findings before merging.";
  return "Inspect the diff, then approve the merge when ready.";
}

/**
 * PROJECT_SPEC.md §25, adapted to this app's actual build/review shape: a build has exactly one
 * fixed reviewer (not the brainstorm workflow's dual independent review), so findings are grouped
 * by disposition rather than by a second provider. Architecture decisions surfaces any ADR that
 * either originated from this build's task or explicitly names it in `relatedTaskIds` — an empty
 * list is reported honestly rather than a fabricated "none" narrative. Human review is always
 * required; an AI-approved merge is never equivalent to a human's.
 */
export function buildPrePrReport(db: WorkspaceDatabase, buildRunId: string): PrePrReport | null {
  const build = db.select().from(buildRuns).where(eq(buildRuns.id, buildRunId)).get();
  if (!build) return null;
  const task = db.select().from(tasks).where(eq(tasks.id, build.taskId)).get();
  if (!task) return null;

  const builderRun = build.builderRunId ? db.select().from(agentRuns).where(eq(agentRuns.id, build.builderRunId)).get() : null;
  const findings = db.select().from(reviewFindings).where(eq(reviewFindings.buildRunId, build.id)).all();
  const validations = db.select().from(validationRuns).where(eq(validationRuns.buildRunId, build.id)).all();
  const relevantAdrs = db.select().from(adrs).where(eq(adrs.projectId, task.projectId)).all()
    .filter((adr) => adr.taskId === task.id || adr.relatedTaskIds.includes(task.id));

  const accepted = findings.filter((finding) => finding.builderVerdict === "ACCEPTED" || finding.builderVerdict === "PARTIALLY_ACCEPTED");
  const rejected = findings.filter((finding) => finding.builderVerdict === "REJECTED");
  const unresolved = findings.filter((finding) => finding.status === "OPEN");

  return {
    generatedAt: new Date().toISOString(),
    taskId: task.id,
    taskTitle: task.title,
    problemStatement: task.problemStatement,
    riskLevel: task.riskLevel,
    buildRunId: build.id,
    builderProvider: build.builderProvider,
    reviewerProvider: build.reviewerProvider,
    reviewRound: build.reviewRound,
    implementationSummary: builderRun?.output.trim() || null,
    filesChanged: parseChangedFiles(`${build.diffStaged ?? ""}\n${build.diffUnstaged ?? ""}`),
    findings: { total: findings.length, accepted, rejected, unresolved },
    tests: validations.map((run) => ({ commandLabel: run.commandLabel, status: run.status, exitCode: run.exitCode, phase: run.phase })),
    merge: {
      status: build.mergeStatus, targetBranch: build.mergeTargetBranch, commitSha: build.mergeCommitSha, mergedAt: build.mergedAt,
    },
    architectureDecisions: relevantAdrs
      .sort((a, b) => a.number - b.number)
      .map((adr) => ({ id: adr.id, number: adr.number, title: adr.title, status: adr.status, decision: adr.decision })),
    humanReviewRequired: true,
    recommendedNextAction: recommendNextAction(unresolved.length > 0, build.mergeStatus),
  };
}
