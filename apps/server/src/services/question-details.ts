import type { WorkspaceDatabase } from "../db/database.js";
import { questionDetails } from "../db/schema.js";

/**
 * Every QUESTION-typed evidence item must have exactly one question_details row. Called from every
 * place a QUESTION evidence item can be created or reclassified into (routes/tasks.ts's evidence
 * create/update routes, BrainstormWorkflow.addAnalysisEvidence) so the invariant holds regardless of
 * entry point. A single idempotent upsert — no separate SELECT needed — so a QUESTION item
 * reclassified away and back later keeps its original row untouched.
 */
export function ensureQuestionDetails(db: WorkspaceDatabase, questionId: string, taskId: string) {
  const now = new Date().toISOString();
  db.insert(questionDetails).values({
    questionId,
    taskId,
    status: "OPEN",
    whyItMatters: null,
    suggestedAction: null,
    expectedEvidence: null,
    suggestionSource: null,
    duplicateOfQuestionId: null,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing().run();
}
