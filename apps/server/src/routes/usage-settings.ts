import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { tasks } from "../db/schema.js";
import {
  UsageBudgetService,
  UsageCostSettingsService,
  UsageSettingsValidationError,
} from "../services/usage-settings.js";

function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof UsageSettingsValidationError) {
    return reply.code(error.message === "Task not found." ? 404 : 400).send({ message: error.message });
  }
  throw error;
}

export function registerUsageSettingsRoutes(
  app: FastifyInstance,
  db: WorkspaceDatabase,
  settings = new UsageCostSettingsService(db),
  budgets = new UsageBudgetService(db, settings),
) {
  app.get("/api/usage/settings", async () => settings.get());

  app.patch<{ Body: Record<string, unknown> }>("/api/usage/settings", async (request, reply) => {
    try {
      return settings.update(request.body ?? {});
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/usage-budget", async (request, reply) => {
    if (!db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, request.params.id)).get()) {
      return reply.code(404).send({ message: "Task not found." });
    }
    return budgets.detail(request.params.id);
  });

  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/tasks/:id/usage-budget", async (request, reply) => {
    try {
      const budget = budgets.set(request.params.id, request.body ?? {});
      return { budget, progress: budgets.progress(request.params.id, budget) };
    } catch (error) {
      return failure(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { action?: unknown } }>("/api/tasks/:id/usage-budget/decision", async (request, reply) => {
    try {
      return budgets.decide(request.params.id, request.body?.action);
    } catch (error) {
      return failure(reply, error);
    }
  });
}
