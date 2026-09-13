import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";
import { applyPendingRestore } from "./restore.js";

export const defaultDatabasePath = fileURLToPath(
  new URL("../../../../data/workspace.sqlite", import.meta.url),
);

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function createDatabase(databasePath = defaultDatabasePath) {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

  const appliedRestore = applyPendingRestore(databasePath);

  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  if (appliedRestore) {
    const createdAt = new Date().toISOString();
    db.insert(schema.maintenanceAudit).values({
      id: randomUUID(),
      category: "RESTORE",
      action: "RESTORE_APPLIED",
      entityType: "DATABASE",
      entityId: null,
      detail: appliedRestore,
      createdAt,
    }).run();
  }

  return { db, sqlite, appliedRestore };
}

export type WorkspaceDatabase = ReturnType<typeof createDatabase>["db"];
