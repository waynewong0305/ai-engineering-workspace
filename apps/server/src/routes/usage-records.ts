import type { FastifyInstance } from "fastify";
import type { WorkspaceDatabase } from "../db/database.js";
import { backfillUsageRecords } from "../services/usage-backfill.js";

export function registerUsageRecordRoutes(app: FastifyInstance, db: WorkspaceDatabase) {
  app.post("/api/usage-records/backfill", async () => backfillUsageRecords(db));
}
