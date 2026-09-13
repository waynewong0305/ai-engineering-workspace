import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type AppliedRestore = {
  restoredFrom: string;
  previousDatabaseBackup: string | null;
};

export function backupDirectoryFor(databasePath: string) {
  return join(dirname(databasePath), "backups");
}

export function pendingRestorePathFor(databasePath: string) {
  return `${databasePath}.restore-pending`;
}

export function pendingRestoreMetadataPathFor(databasePath: string) {
  return `${pendingRestorePathFor(databasePath)}.json`;
}

export function assertHealthySqliteFile(path: string) {
  const candidate = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const result = candidate.pragma("integrity_check") as Array<{ integrity_check: string }>;
    if (result.length !== 1 || result[0]?.integrity_check !== "ok") {
      throw new Error("SQLite integrity check failed.");
    }
  } finally {
    candidate.close();
  }
}

export function applyPendingRestore(databasePath: string): AppliedRestore | null {
  if (databasePath === ":memory:") return null;
  const pendingPath = pendingRestorePathFor(databasePath);
  if (!existsSync(pendingPath)) return null;
  assertHealthySqliteFile(pendingPath);
  const metadataPath = pendingRestoreMetadataPathFor(databasePath);
  let restoredFrom = basename(pendingPath);
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { backupName?: unknown };
      if (typeof metadata.backupName === "string") restoredFrom = metadata.backupName;
    } catch {
      // The verified staged database remains usable even if its optional provenance file was damaged.
    }
  }

  const backupDirectory = backupDirectoryFor(databasePath);
  mkdirSync(backupDirectory, { recursive: true });
  let previousDatabaseBackup: string | null = null;
  if (existsSync(databasePath)) {
    const current = new Database(databasePath);
    try {
      current.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      current.close();
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    previousDatabaseBackup = join(backupDirectory, `pre-restore-${timestamp}.sqlite`);
    copyFileSync(databasePath, previousDatabaseBackup);
    assertHealthySqliteFile(previousDatabaseBackup);
  }

  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  renameSync(pendingPath, databasePath);
  rmSync(metadataPath, { force: true });
  return { restoredFrom, previousDatabaseBackup };
}
