import type { WorkspaceDatabase } from "../db/database.js";
import { questionDetails, type QuestionPriority, type QuestionSuggestionSource } from "../db/schema.js";

export type InitialQuestionSuggestions = {
  priority: QuestionPriority;
  whyItMatters: string;
  suggestedAction: string;
  expectedEvidence: string[];
  suggestedAnswers: string[];
  suggestionSource: QuestionSuggestionSource;
};

/**
 * Every QUESTION-typed evidence item must have exactly one question_details row. Called from every
 * place a QUESTION evidence item can be created or reclassified into (routes/tasks.ts's evidence
 * create/update routes, BrainstormWorkflow.addAnalysisEvidence) so the invariant holds regardless of
 * entry point. A single idempotent upsert — no separate SELECT needed — so a QUESTION item
 * reclassified away and back later keeps its original row untouched. `suggestions` is populated only
 * by a v2 analysis/cross-review call that already produced real suggestion content for this exact
 * question (BrainstormWorkflow.addAnalysisEvidence) — every other caller omits it and gets the usual
 * blank row, never an invented value.
 */
export function ensureQuestionDetails(db: WorkspaceDatabase, questionId: string, taskId: string, suggestions?: InitialQuestionSuggestions) {
  const now = new Date().toISOString();
  db.insert(questionDetails).values({
    questionId,
    taskId,
    status: "OPEN",
    whyItMatters: suggestions?.whyItMatters ?? null,
    suggestedAction: suggestions?.suggestedAction ?? null,
    expectedEvidence: suggestions?.expectedEvidence ?? null,
    suggestedAnswers: suggestions?.suggestedAnswers ?? null,
    suggestionSource: suggestions?.suggestionSource ?? null,
    priority: suggestions?.priority ?? null,
    duplicateOfQuestionId: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run();
}
