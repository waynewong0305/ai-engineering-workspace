import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { WorkspaceDatabase } from "../db/database.js";
import { DatabaseMaintenanceService, MaintenanceError } from "../services/database-maintenance.js";

function maintenanceError(reply: FastifyReply, error: unknown) {
  if (error instanceof MaintenanceError) return reply.code(400).send({ message: error.message });
  throw error;
}

export function registerMaintenanceRoutes(
  app: FastifyInstance,
  db: WorkspaceDatabase,
  sqlite: Database.Database,
  databasePath: string,
) {
  const maintenance = new DatabaseMaintenanceService(db, sqlite, databasePath);

  app.get("/api/maintenance", async (_request, reply) => {
    try {
      return { backups: await maintenance.listBackups(), ...maintenance.diagnostics() };
    } catch (error) {
      return maintenanceError(reply, error);
    }
  });

  app.post("/api/maintenance/backups", async (_request, reply) => {
    try {
      return reply.code(201).send(await maintenance.createBackup());
    } catch (error) {
      return maintenanceError(reply, error);
    }
  });

  app.post<{ Body: { backupName?: unknown; confirm?: unknown } }>("/api/maintenance/restore", async (request, reply) => {
    try {
      if (typeof request.body?.backupName !== "string") throw new MaintenanceError("Backup name is required.");
      return reply.code(202).send(await maintenance.stageRestore(request.body.backupName, request.body.confirm === true));
    } catch (error) {
      return maintenanceError(reply, error);
    }
  });

  app.delete<{ Body: { confirm?: unknown } }>("/api/maintenance/restore", async (request, reply) => {
    try {
      return maintenance.cancelPendingRestore(request.body?.confirm === true);
    } catch (error) {
      return maintenanceError(reply, error);
    }
  });

  app.get("/api/maintenance/audit/export", async (_request, reply) => {
    reply.header("Content-Disposition", `attachment; filename="workspace-audit-${new Date().toISOString().slice(0, 10)}.json"`);
    return maintenance.auditExport();
  });
}
