import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { asc, eq, max } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { adrs, projects, tasks, type AdrRecord, type AdrStatus } from "../db/schema.js";

const ADR_STATUSES = new Set<AdrStatus>(["PROPOSED", "ACCEPTED", "REJECTED", "SUPERSEDED"]);
const MAX_SHORT_FIELD = 300;
const MAX_LONG_FIELD = 10_000;

type CreateAdrBody = {
  title?: unknown;
  context?: unknown;
  optionsConsidered?: unknown;
  decision?: unknown;
  reasons?: unknown;
  consequences?: unknown;
  risks?: unknown;
  rejectedAlternatives?: unknown;
  requiredFollowUp?: unknown;
  relatedTaskIds?: unknown;
  status?: unknown;
};

function text(value: unknown, maxLength = MAX_LONG_FIELD) {
  return typeof value === "string" && value.trim() && value.length <= maxLength ? value.trim() : null;
}

function optionalText(value: unknown, maxLength = MAX_LONG_FIELD): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return text(value, maxLength);
}

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string")) return null;
  return value.map((item) => item.trim()).filter(Boolean);
}

export function registerAdrRoutes(app: FastifyInstance, db: WorkspaceDatabase) {
  app.get<{ Params: { id: string } }>("/api/projects/:id/adrs", async (request, reply) => {
    if (!db.select({ id: projects.id }).from(projects).where(eq(projects.id, request.params.id)).get()) {
      return reply.code(404).send({ message: "Project not found." });
    }
    return db.select().from(adrs).where(eq(adrs.projectId, request.params.id)).orderBy(asc(adrs.number)).all();
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/adrs", async (request, reply) => {
    if (!db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, request.params.id)).get()) {
      return reply.code(404).send({ message: "Task not found." });
    }
    return db.select().from(adrs).where(eq(adrs.taskId, request.params.id)).orderBy(asc(adrs.number)).all();
  });

  app.post<{ Params: { id: string }; Body: CreateAdrBody }>("/api/tasks/:id/adrs", async (request, reply) => {
    const task = db.select().from(tasks).where(eq(tasks.id, request.params.id)).get();
    if (!task) return reply.code(404).send({ message: "Task not found." });

    const title = text(request.body?.title, MAX_SHORT_FIELD);
    const context = text(request.body?.context);
    const optionsConsidered = text(request.body?.optionsConsidered);
    const decision = text(request.body?.decision);
    const reasons = text(request.body?.reasons);
    const consequences = text(request.body?.consequences);
    if (!title || !context || !optionsConsidered || !decision || !reasons || !consequences) {
      return reply.code(400).send({
        message: "title, context, optionsConsidered, decision, reasons, and consequences are all required (300 characters for title, 10,000 for the rest).",
      });
    }
    const risks = optionalText(request.body?.risks);
    const rejectedAlternatives = optionalText(request.body?.rejectedAlternatives);
    const requiredFollowUp = optionalText(request.body?.requiredFollowUp);
    if (risks === null && request.body?.risks !== undefined && request.body.risks !== null) {
      return reply.code(400).send({ message: "risks must be a string of 10,000 characters or fewer." });
    }
    const relatedTaskIds = stringArray(request.body?.relatedTaskIds);
    if (!relatedTaskIds) return reply.code(400).send({ message: "relatedTaskIds must be an array of strings." });

    const nextNumber = (db.select({ highest: max(adrs.number) }).from(adrs).where(eq(adrs.projectId, task.projectId)).get()?.highest ?? 0) + 1;
    const now = new Date().toISOString();
    const record: AdrRecord = {
      id: randomUUID(), projectId: task.projectId, taskId: task.id, number: nextNumber,
      title, context, optionsConsidered, decision, reasons, consequences,
      risks: risks ?? null, rejectedAlternatives: rejectedAlternatives ?? null, requiredFollowUp: requiredFollowUp ?? null,
      relatedTaskIds, status: "PROPOSED", createdAt: now, updatedAt: now,
    };
    db.insert(adrs).values(record).run();
    return reply.code(201).send(record);
  });

  app.get<{ Params: { id: string } }>("/api/adrs/:id", async (request, reply) => {
    const adr = db.select().from(adrs).where(eq(adrs.id, request.params.id)).get();
    if (!adr) return reply.code(404).send({ message: "ADR not found." });
    return adr;
  });

  app.patch<{ Params: { id: string }; Body: CreateAdrBody }>("/api/adrs/:id", async (request, reply) => {
    const current = db.select().from(adrs).where(eq(adrs.id, request.params.id)).get();
    if (!current) return reply.code(404).send({ message: "ADR not found." });

    const body = request.body ?? {};
    const status = body.status === undefined ? current.status : (typeof body.status === "string" && ADR_STATUSES.has(body.status as AdrStatus) ? body.status as AdrStatus : null);
    if (status === null) return reply.code(400).send({ message: `status must be one of ${Array.from(ADR_STATUSES).join(", ")}.` });

    const title = body.title === undefined ? current.title : text(body.title, MAX_SHORT_FIELD);
    const context = body.context === undefined ? current.context : text(body.context);
    const optionsConsidered = body.optionsConsidered === undefined ? current.optionsConsidered : text(body.optionsConsidered);
    const decision = body.decision === undefined ? current.decision : text(body.decision);
    const reasons = body.reasons === undefined ? current.reasons : text(body.reasons);
    const consequences = body.consequences === undefined ? current.consequences : text(body.consequences);
    if (!title || !context || !optionsConsidered || !decision || !reasons || !consequences) {
      return reply.code(400).send({ message: "title, context, optionsConsidered, decision, reasons, and consequences may not be blank." });
    }
    const risks = body.risks === undefined ? current.risks : optionalText(body.risks);
    const rejectedAlternatives = body.rejectedAlternatives === undefined ? current.rejectedAlternatives : optionalText(body.rejectedAlternatives);
    const requiredFollowUp = body.requiredFollowUp === undefined ? current.requiredFollowUp : optionalText(body.requiredFollowUp);
    const relatedTaskIds = body.relatedTaskIds === undefined ? current.relatedTaskIds : stringArray(body.relatedTaskIds);
    if (!relatedTaskIds) return reply.code(400).send({ message: "relatedTaskIds must be an array of strings." });

    db.update(adrs).set({
      title, context, optionsConsidered, decision, reasons, consequences,
      risks: risks ?? null, rejectedAlternatives: rejectedAlternatives ?? null, requiredFollowUp: requiredFollowUp ?? null,
      relatedTaskIds, status, updatedAt: new Date().toISOString(),
    }).where(eq(adrs.id, current.id)).run();
    return db.select().from(adrs).where(eq(adrs.id, current.id)).get();
  });
}
