import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  evidenceItems,
  experiments,
  questionDetails,
  questionResponses,
  type QuestionResponseSource,
  type QuestionStatus,
} from "../db/schema.js";

const RESPONSE_SOURCES = new Set<QuestionResponseSource>(["HUMAN", "EXPERIMENT", "PROVIDER"]);
const MAX_ANSWER_CHARS = 5_000;

function text(value: unknown, maxLength = MAX_ANSWER_CHARS) {
  return typeof value === "string" && value.trim() && value.length <= maxLength ? value.trim() : null;
}

type ResponsePatch = { status: QuestionStatus; duplicateOfQuestionId?: string | null };

/**
 * PROJECT_SPEC.md-adjacent user requirement: every question lifecycle action is recorded as an
 * append-only question_responses row before question_details is updated, so the resolution history
 * (including a later reopen) is always reconstructable — never a silent status flip.
 */
export function registerQuestionRoutes(app: FastifyInstance, db: WorkspaceDatabase) {
  function loadQuestion(taskId: string, questionId: string) {
    const item = db.select().from(evidenceItems).where(eq(evidenceItems.id, questionId)).get();
    if (!item || item.taskId !== taskId || item.type !== "QUESTION") return null;
    const detail = db.select().from(questionDetails).where(eq(questionDetails.questionId, questionId)).get();
    return detail ? { item, detail } : null;
  }

  function respondAndReturn(taskId: string, questionId: string, params: {
    answer: string;
    resultingStatus: QuestionStatus;
    source?: QuestionResponseSource;
    linkedEvidenceItemId?: string | null;
    linkedExperimentId?: string | null;
    patch: ResponsePatch;
  }) {
    const now = new Date().toISOString();
    db.insert(questionResponses).values({
      id: randomUUID(),
      questionId,
      taskId,
      answer: params.answer,
      resultingStatus: params.resultingStatus,
      linkedEvidenceItemId: params.linkedEvidenceItemId ?? null,
      linkedExperimentId: params.linkedExperimentId ?? null,
      source: params.source ?? "HUMAN",
      createdAt: now,
    }).run();
    db.update(questionDetails).set({ ...params.patch, updatedAt: now }).where(eq(questionDetails.questionId, questionId)).run();
    return {
      ...db.select().from(questionDetails).where(eq(questionDetails.questionId, questionId)).get()!,
      responses: db.select().from(questionResponses).where(eq(questionResponses.questionId, questionId)).orderBy(asc(questionResponses.createdAt)).all(),
    };
  }

  app.post<{
    Params: { taskId: string; questionId: string };
    Body: { answer?: unknown; linkedEvidenceItemId?: unknown; linkedExperimentId?: unknown; source?: unknown };
  }>("/api/tasks/:taskId/questions/:questionId/responses", async (request, reply) => {
    const { taskId, questionId } = request.params;
    const found = loadQuestion(taskId, questionId);
    if (!found) return reply.code(404).send({ message: "Question not found." });
    if (found.detail.status !== "OPEN") {
      return reply.code(400).send({ message: "Only an open question can be answered directly — reopen it first." });
    }
    const answer = text(request.body?.answer);
    if (!answer) return reply.code(400).send({ message: "An answer is required (5,000 characters or fewer)." });
    const source = request.body?.source === undefined
      ? "HUMAN"
      : (typeof request.body.source === "string" && RESPONSE_SOURCES.has(request.body.source as QuestionResponseSource) ? request.body.source as QuestionResponseSource : null);
    if (source === null) return reply.code(400).send({ message: `source must be one of ${Array.from(RESPONSE_SOURCES).join(", ")}.` });

    let linkedEvidenceItemId: string | null = null;
    if (request.body?.linkedEvidenceItemId !== undefined) {
      linkedEvidenceItemId = text(request.body.linkedEvidenceItemId, 200);
      if (!linkedEvidenceItemId || !db.select({ id: evidenceItems.id }).from(evidenceItems).where(eq(evidenceItems.id, linkedEvidenceItemId)).get()) {
        return reply.code(400).send({ message: "linkedEvidenceItemId does not refer to a real evidence item." });
      }
    }
    let linkedExperimentId: string | null = null;
    if (request.body?.linkedExperimentId !== undefined) {
      linkedExperimentId = text(request.body.linkedExperimentId, 200);
      if (!linkedExperimentId || !db.select({ id: experiments.id }).from(experiments).where(eq(experiments.id, linkedExperimentId)).get()) {
        return reply.code(400).send({ message: "linkedExperimentId does not refer to a real experiment." });
      }
    }
    return respondAndReturn(taskId, questionId, {
      answer, resultingStatus: "ANSWERED", source, linkedEvidenceItemId, linkedExperimentId,
      patch: { status: "ANSWERED" },
    });
  });

  app.post<{ Params: { taskId: string; questionId: string }; Body: { reason?: unknown } }>(
    "/api/tasks/:taskId/questions/:questionId/reopen",
    async (request, reply) => {
      const { taskId, questionId } = request.params;
      const found = loadQuestion(taskId, questionId);
      if (!found) return reply.code(404).send({ message: "Question not found." });
      if (found.detail.status === "OPEN") return reply.code(400).send({ message: "Question is already open." });
      return respondAndReturn(taskId, questionId, {
        answer: text(request.body?.reason) ?? "Reopened.",
        resultingStatus: "OPEN",
        patch: { status: "OPEN", duplicateOfQuestionId: null },
      });
    },
  );

  app.post<{ Params: { taskId: string; questionId: string }; Body: { reason?: unknown } }>(
    "/api/tasks/:taskId/questions/:questionId/defer",
    async (request, reply) => {
      const { taskId, questionId } = request.params;
      const found = loadQuestion(taskId, questionId);
      if (!found) return reply.code(404).send({ message: "Question not found." });
      if (found.detail.status !== "OPEN") return reply.code(400).send({ message: "Only an open question can be deferred — reopen it first." });
      return respondAndReturn(taskId, questionId, {
        answer: text(request.body?.reason) ?? "Deferred.",
        resultingStatus: "DEFERRED",
        patch: { status: "DEFERRED" },
      });
    },
  );

  app.post<{ Params: { taskId: string; questionId: string }; Body: { reason?: unknown } }>(
    "/api/tasks/:taskId/questions/:questionId/mark-not-applicable",
    async (request, reply) => {
      const { taskId, questionId } = request.params;
      const found = loadQuestion(taskId, questionId);
      if (!found) return reply.code(404).send({ message: "Question not found." });
      if (found.detail.status !== "OPEN") {
        return reply.code(400).send({ message: "Only an open question can be marked not applicable — reopen it first." });
      }
      return respondAndReturn(taskId, questionId, {
        answer: text(request.body?.reason) ?? "Marked not applicable.",
        resultingStatus: "NOT_APPLICABLE",
        patch: { status: "NOT_APPLICABLE" },
      });
    },
  );

  app.post<{ Params: { taskId: string; questionId: string }; Body: { duplicateOfQuestionId?: unknown } }>(
    "/api/tasks/:taskId/questions/:questionId/confirm-duplicate",
    async (request, reply) => {
      const { taskId, questionId } = request.params;
      const found = loadQuestion(taskId, questionId);
      if (!found) return reply.code(404).send({ message: "Question not found." });
      if (found.detail.status !== "OPEN") {
        return reply.code(400).send({ message: "Only an open question can be confirmed as a duplicate — reopen it first." });
      }
      const targetId = text(request.body?.duplicateOfQuestionId, 200);
      if (!targetId) return reply.code(400).send({ message: "duplicateOfQuestionId is required." });
      if (targetId === questionId) return reply.code(400).send({ message: "A question cannot be a duplicate of itself." });
      const target = loadQuestion(taskId, targetId);
      if (!target) return reply.code(400).send({ message: "duplicateOfQuestionId must refer to another question in the same task." });
      if (target.detail.status === "DUPLICATE") {
        return reply.code(400).send({ message: "The target question is itself a confirmed duplicate — link to its canonical question instead." });
      }
      return respondAndReturn(taskId, questionId, {
        answer: `Confirmed as a duplicate of question ${targetId}.`,
        resultingStatus: "DUPLICATE",
        patch: { status: "DUPLICATE", duplicateOfQuestionId: targetId },
      });
    },
  );

  app.delete<{ Params: { taskId: string; questionId: string } }>(
    "/api/tasks/:taskId/questions/:questionId/duplicate-link",
    async (request, reply) => {
      const { taskId, questionId } = request.params;
      const found = loadQuestion(taskId, questionId);
      if (!found) return reply.code(404).send({ message: "Question not found." });
      if (found.detail.status !== "DUPLICATE") return reply.code(400).send({ message: "This question is not currently linked as a duplicate." });
      return respondAndReturn(taskId, questionId, {
        answer: "Duplicate link removed.",
        resultingStatus: "OPEN",
        patch: { status: "OPEN", duplicateOfQuestionId: null },
      });
    },
  );
}
