import type { FastifyInstance } from "fastify";
import type { WorkspaceDatabase } from "../db/database.js";
import { backfillUsageRecords } from "../services/usage-backfill.js";
import { buildUsageDashboard, type UsagePeriod } from "../services/usage-analytics.js";
import { calculateMissingUsageCosts } from "../services/usage-cost.js";

const PERIODS = new Set<UsagePeriod>(["today", "7d", "30d", "month", "all", "custom"]);

export function registerUsageRecordRoutes(app: FastifyInstance, db: WorkspaceDatabase) {
  app.get<{ Querystring: { period?: string; projectId?: string; taskId?: string; from?: string; to?: string } }>(
    "/api/usage-records/dashboard",
    async (request, reply) => {
      const period = (request.query.period ?? "7d") as UsagePeriod;
      if (!PERIODS.has(period)) return reply.code(400).send({ message: "Unknown usage period." });
      if (period === "custom") {
        const from = request.query.from ? new Date(request.query.from) : null;
        const to = request.query.to ? new Date(request.query.to) : null;
        if (!from || !to || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
          return reply.code(400).send({ message: "A custom period requires valid from/to dates in chronological order." });
        }
      }
      return buildUsageDashboard(db, {
        period,
        projectId: request.query.projectId?.trim() || undefined,
        taskId: request.query.taskId?.trim() || undefined,
        from: request.query.from,
        to: request.query.to,
      });
    },
  );
  app.post("/api/usage-records/backfill", async () => backfillUsageRecords(db));
  app.post("/api/usage-records/calculate-costs", async () => calculateMissingUsageCosts(db));
}
