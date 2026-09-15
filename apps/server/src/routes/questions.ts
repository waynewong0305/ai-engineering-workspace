import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentProvider } from "@aiew/agents";
import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  evidenceItems,
  experiments,
  projects,
  questionDetails,
  questionResponses,
  tasks,
  type QuestionResponseSource,
  type QuestionStatus,
} from "../db/schema.js";
import { AgentRunManager } from "../services/agent-run-manager.js";
import { generateDuplicateSuggestions } from "../services/duplicate-detection.js";
import type { UsageSafetyService } from "../services/usage-safety.js";

const RESPONSE_SOURCES = new Set<QuestionResponseSource>(["HUMAN", "EXPERIMENT", "PROVIDER"]);
const MAX_ANSWER_CHARS = 5_000;

function text(value: unknown, maxLength = MAX_ANSWER_CHARS) {
  return typeof value === "string" && value.trim() && value.length <= maxLength ? value.trim() : null;
}

/** Lowercase, collapse whitespace, strip trailing punctuation — catches typo/case-level duplicates only; semantically-similar-but-differently-worded questions need the AI-judged scan instead. */
export function normalizeQuestionText(content: string): string {
  return content.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "");
}

type ResponsePatch = { status: QuestionStatus; duplicateOfQuestionId?: string | null };

/**
 * PROJECT_SPEC.md-adjacent user requirement: every question lifecycle action is recorded as an
 * append-only question_responses row before question_details is updated, so the resolution history
 * (including a later reopen) is always reconstructable — never a silent status flip.
 */
export function registerQuestionRoutes(
  app: FastifyInstance,
  db: WorkspaceDatabase,
  adapters: Map<AgentProvider, AgentAdapter>,
  manager: AgentRunManager,
  usageSafety: UsageSafetyService,
) {
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

  /**
   * Core transition shared by the per-pair confirm-duplicate route and the free exact-match batch
   * route below — validates the target is a real, canonical (non-duplicate) question in the same
   * task, then applies the same DUPLICATE status/duplicateOfQuestionId patch either way. `source`
   * lets the batch route attribute the response to the human who triggered the batch (still `HUMAN`,
   * since no per-pair click happened but a human did explicitly start the action) with different
   * answer text than the interactive one-at-a-time flow.
   */
  function confirmDuplicateInternal(taskId: string, questionId: string, targetId: string, answer?: string) {
    const found = loadQuestion(taskId, questionId);
    if (!found) return { ok: false as const, message: "Question not found." };
    if (found.detail.status !== "OPEN") {
      return { ok: false as const, message: "Only an open question can be confirmed as a duplicate — reopen it first." };
    }
    if (targetId === questionId) return { ok: false as const, message: "A question cannot be a duplicate of itself." };
    const target = loadQuestion(taskId, targetId);
    if (!target) return { ok: false as const, message: "duplicateOfQuestionId must refer to another question in the same task." };
    if (target.detail.status === "DUPLICATE") {
      return { ok: false as const, message: "The target question is itself a confirmed duplicate — link to its canonical question instead." };
    }
    return {
      ok: true as const,
      result: respondAndReturn(taskId, questionId, {
        answer: answer ?? `Confirmed as a duplicate of question ${targetId}.`,
        resultingStatus: "DUPLICATE",
        patch: { status: "DUPLICATE", duplicateOfQuestionId: targetId },
      }),
    };
  }

  app.post<{ Params: { taskId: string; questionId: string }; Body: { duplicateOfQuestionId?: unknown } }>(
    "/api/tasks/:taskId/questions/:questionId/confirm-duplicate",
    async (request, reply) => {
      const { taskId, questionId } = request.params;
      if (!loadQuestion(taskId, questionId)) return reply.code(404).send({ message: "Question not found." });
      const targetId = text(request.body?.duplicateOfQuestionId, 200);
      if (!targetId) return reply.code(400).send({ message: "duplicateOfQuestionId is required." });
      const outcome = confirmDuplicateInternal(taskId, questionId, targetId);
      if (!outcome.ok) return reply.code(400).send({ message: outcome.message });
      return outcome.result;
    },
  );

  /**
   * Free, instant, no-provider-call batch action: groups OPEN questions whose text is identical
   * after normalization (case/whitespace/trailing-punctuation-insensitive). Per the spec, exact
   * matches "may be grouped automatically" — unlike a per-pair confirm-duplicate click, the human
   * triggers the whole batch at once rather than confirming each pair, but every grouping still goes
   * through the identical confirmDuplicateInternal transition (and its own question_responses row),
   * so the audit trail is indistinguishable in shape from a manual confirmation.
   */
  app.post<{ Params: { id: string } }>("/api/tasks/:id/questions/group-exact-duplicates", async (request, reply) => {
    const taskId = request.params.id;
    if (!db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get()) {
      return reply.code(404).send({ message: "Task not found." });
    }
    const openQuestions = db.select().from(evidenceItems).where(eq(evidenceItems.taskId, taskId)).all()
      .filter((item) => item.type === "QUESTION")
      .flatMap((item) => {
        const detail = db.select().from(questionDetails).where(eq(questionDetails.questionId, item.id)).get();
        return detail?.status === "OPEN" ? [{ item, detail }] : [];
      });
    if (!openQuestions.length) return { groupedCount: 0 };

    const byNormalized = new Map<string, typeof openQuestions>();
    for (const entry of openQuestions) {
      const key = normalizeQuestionText(entry.item.content);
      const list = byNormalized.get(key) ?? [];
      list.push(entry);
      byNormalized.set(key, list);
    }

    let groupedCount = 0;
    for (const group of byNormalized.values()) {
      if (group.length < 2) continue;
      const sorted = [...group].sort((a, b) => a.item.createdAt.localeCompare(b.item.createdAt));
      const canonical = sorted[0]!;
      const duplicates = sorted.slice(1);
      for (const duplicate of duplicates) {
        const outcome = confirmDuplicateInternal(taskId, duplicate.item.id, canonical.item.id, "Automatically grouped as an exact-normalized duplicate.");
        if (outcome.ok) groupedCount += 1;
      }
    }
    return { groupedCount };
  });

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

  app.post<{ Params: { id: string }; Body: { provider?: unknown } }>("/api/tasks/:id/questions/detect-duplicates", async (request, reply) => {
    const taskId = request.params.id;
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return reply.code(404).send({ message: "Task not found." });
    const provider = text(request.body?.provider) as AgentProvider | null;
    if (provider !== "CLAUDE" && provider !== "CODEX") return reply.code(400).send({ message: "provider must be CLAUDE or CODEX." });
    const project = db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    if (!project) return reply.code(404).send({ message: "The registered project no longer exists." });
    // Single-provider action: only the selected provider's usage matters (combined: false), matching
    // /api/agent-runs' own repository-explanation pre-check and /report/synthesize exactly.
    const usageDecision = usageSafety.evaluate(provider, { combined: false });
    if (!usageDecision.allowed) {
      return reply.code(409).send({ message: usageDecision.reason, code: "USAGE_CHECKPOINT", decision: usageDecision });
    }
    void generateDuplicateSuggestions(db, manager, adapters, task.id, task.projectId, project.repositoryPath, provider);
    return reply.code(202).send({ message: "Scanning open questions for possible duplicates.", taskId: task.id });
  });
}
