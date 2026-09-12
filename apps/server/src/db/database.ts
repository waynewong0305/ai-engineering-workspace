import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export const defaultDatabasePath = fileURLToPath(
  new URL("../../../../data/workspace.sqlite", import.meta.url),
);

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export function createDatabase(databasePath = defaultDatabasePath) {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });

  return { db, sqlite };
}

export type WorkspaceDatabase = ReturnType<typeof createDatabase>["db"];

