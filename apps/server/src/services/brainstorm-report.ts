import type { AgentProvider } from "@aiew/agents";
import { asc, desc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  adrs,
  evidenceItems,
  experiments,
  questionDetails,
  questionResponses,
  taskArtifacts,
  taskComparisons,
  tasks,
  type AdrStatus,
  type BrainstormAnalysis,
  type CrossReview,
  type EvidenceItemRecord,
  type ExperimentStatus,
  type ExperimentVerdict,
  type QuestionPriority,
  type QuestionResponseSource,
  type QuestionStatus,
  type RiskLevel,
  type TaskComparison,
  type TaskRecord,
  type TaskStatus,
  type TaskType,
} from "../db/schema.js";

export type QuestionReportEntry = {
  id: string;
  content: string;
  sourceProvider: AgentProvider | null;
  priority: QuestionPriority | null;
  whyItMatters: string | null;
  suggestedAction: string | null;
  responses: { answer: string; resultingStatus: QuestionStatus; source: QuestionResponseSource; createdAt: string }[];
};

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
  comparisonVersion: number | null;
  evidence: {
    facts: EvidenceItemRecord[];
    assumptions: EvidenceItemRecord[];
    decisions: EvidenceItemRecord[];
    experimentResults: EvidenceItemRecord[];
    questions: {
      open: QuestionReportEntry[];
      answered: QuestionReportEntry[];
      deferred: QuestionReportEntry[];
      notApplicable: QuestionReportEntry[];
      duplicateGroups: { canonical: QuestionReportEntry; duplicates: QuestionReportEntry[] }[];
    };
  };
  architectureDecisions: { id: string; number: number; title: string; status: AdrStatus; decision: string }[];
  experiments: { id: string; hypothesis: string; builderProvider: AgentProvider; reviewerProvider: AgentProvider; status: ExperimentStatus; verdict: ExperimentVerdict | null; conclusion: string | null }[];
  blockingQuestionsRemain: boolean;
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
  // Latest version is "current" — every earlier revision stays in the table, never overwritten (see
  // BrainstormWorkflow.reviseWithAnswers), but this report always summarizes the most recent plan.
  const latestComparison = db.select().from(taskComparisons).where(eq(taskComparisons.taskId, task.id)).orderBy(desc(taskComparisons.version)).get();
  const comparison = latestComparison?.content ?? null;
  const evidence = db.select().from(evidenceItems).where(eq(evidenceItems.taskId, task.id)).orderBy(asc(evidenceItems.createdAt)).all();

  const details = db.select().from(questionDetails).where(eq(questionDetails.taskId, task.id)).all();
  const detailsByQuestionId = new Map(details.map((detail) => [detail.questionId, detail]));
  const responsesByQuestionId = new Map<string, { answer: string; resultingStatus: QuestionStatus; source: QuestionResponseSource; createdAt: string }[]>();
  for (const response of db.select().from(questionResponses).where(eq(questionResponses.taskId, task.id)).orderBy(asc(questionResponses.createdAt)).all()) {
    const list = responsesByQuestionId.get(response.questionId) ?? [];
    list.push({ answer: response.answer, resultingStatus: response.resultingStatus, source: response.source, createdAt: response.createdAt });
    responsesByQuestionId.set(response.questionId, list);
  }
  const toEntry = (item: EvidenceItemRecord): QuestionReportEntry => {
    const detail = detailsByQuestionId.get(item.id);
    return {
      id: item.id, content: item.content, sourceProvider: item.sourceProvider,
      priority: detail?.priority ?? null, whyItMatters: detail?.whyItMatters ?? null, suggestedAction: detail?.suggestedAction ?? null,
      responses: responsesByQuestionId.get(item.id) ?? [],
    };
  };

  const questionItems = evidence.filter((item) => item.type === "QUESTION");
  const entriesByQuestionId = new Map(questionItems.map((item) => [item.id, toEntry(item)]));
  const open: QuestionReportEntry[] = [];
  const answered: QuestionReportEntry[] = [];
  const deferred: QuestionReportEntry[] = [];
  const notApplicable: QuestionReportEntry[] = [];
  const duplicateGroupsByCanonicalId = new Map<string, QuestionReportEntry[]>();
  for (const item of questionItems) {
    const detail = detailsByQuestionId.get(item.id);
    const entry = entriesByQuestionId.get(item.id)!;
    switch (detail?.status ?? "OPEN") {
      case "ANSWERED": answered.push(entry); break;
      case "DEFERRED": deferred.push(entry); break;
      case "NOT_APPLICABLE": notApplicable.push(entry); break;
      case "DUPLICATE": {
        const canonicalId = detail?.duplicateOfQuestionId;
        if (canonicalId) {
          const list = duplicateGroupsByCanonicalId.get(canonicalId) ?? [];
          list.push(entry);
          duplicateGroupsByCanonicalId.set(canonicalId, list);
        }
        break;
      }
      default: open.push(entry);
    }
  }
  const duplicateGroups = [...duplicateGroupsByCanonicalId.entries()].flatMap(([canonicalId, duplicates]) => {
    const canonical = entriesByQuestionId.get(canonicalId);
    return canonical ? [{ canonical, duplicates }] : [];
  });
  const blockingQuestionsRemain = open.some((entry) => entry.priority === "BLOCKING");

  const relevantAdrs = db.select().from(adrs).where(eq(adrs.projectId, task.projectId)).all()
    .filter((adr) => adr.taskId === task.id || adr.relatedTaskIds.includes(task.id));
  const relevantExperiments = db.select().from(experiments).where(eq(experiments.taskId, task.id)).all();

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
    comparisonVersion: latestComparison?.version ?? null,
    evidence: {
      facts: evidence.filter((item) => item.type === "FACT"),
      assumptions: evidence.filter((item) => item.type === "ASSUMPTION"),
      decisions: evidence.filter((item) => item.type === "DECISION"),
      experimentResults: evidence.filter((item) => item.type === "EXPERIMENT_RESULT"),
      questions: { open, answered, deferred, notApplicable, duplicateGroups },
    },
    architectureDecisions: relevantAdrs
      .sort((a, b) => a.number - b.number)
      .map((adr) => ({ id: adr.id, number: adr.number, title: adr.title, status: adr.status, decision: adr.decision })),
    experiments: relevantExperiments.map((experiment) => ({
      id: experiment.id, hypothesis: experiment.hypothesis, builderProvider: experiment.builderProvider,
      reviewerProvider: experiment.reviewerProvider, status: experiment.status, verdict: experiment.verdict, conclusion: experiment.conclusion,
    })),
    blockingQuestionsRemain,
    humanDecisionRequired: true,
    recommendedNextAction: recommendNextAction(task, comparison !== null),
  };
}
