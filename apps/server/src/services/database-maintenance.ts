import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { asc, desc, eq, isNull } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  adrs,
  agentRuns,
  buildRuns,
  experiments,
  maintenanceAudit,
  tasks,
  usageSafetyAudit,
  worktrees,
  worktreeUsages,
} from "../db/schema.js";
import {
  assertHealthySqliteFile,
  backupDirectoryFor,
  pendingRestoreMetadataPathFor,
  pendingRestorePathFor,
} from "../db/restore.js";

export class MaintenanceError extends Error {}

function safeBackupName(value: string) {
  if (basename(value) !== value || !/^[a-zA-Z0-9._-]+\.sqlite$/.test(value)) {
    throw new MaintenanceError("Choose a backup file from the workspace backup list.");
  }
  return value;
}

export class DatabaseMaintenanceService {
  constructor(
    private readonly db: WorkspaceDatabase,
    private readonly sqlite: Database.Database,
    private readonly databasePath: string,
  ) {}

  private assertFileDatabase() {
    if (this.databasePath === ":memory:") {
      throw new MaintenanceError("Backups require a file-backed workspace database.");
    }
  }

  async listBackups() {
    this.assertFileDatabase();
    const directory = backupDirectoryFor(this.databasePath);
    const names = await readdir(directory).catch(() => [] as string[]);
    const backups = await Promise.all(names.filter((name) => name.endsWith(".sqlite")).map(async (name) => {
      const details = await stat(join(directory, name));
      return { name, sizeBytes: details.size, createdAt: details.mtime.toISOString() };
    }));
    return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createBackup() {
    this.assertFileDatabase();
    const directory = backupDirectoryFor(this.databasePath);
    await mkdir(directory, { recursive: true });
    const name = `workspace-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.sqlite`;
    const destination = join(directory, name);
    await this.sqlite.backup(destination);
    assertHealthySqliteFile(destination);
    this.record("BACKUP", "BACKUP_CREATED", { name });
    return (await this.listBackups()).find((backup) => backup.name === name)!;
  }

  async stageRestore(backupName: string, confirm: boolean) {
    this.assertFileDatabase();
    if (!confirm) throw new MaintenanceError("Restoring a backup requires explicit confirmation.");
    const name = safeBackupName(backupName);
    const source = resolve(backupDirectoryFor(this.databasePath), name);
    if (!source.startsWith(`${resolve(backupDirectoryFor(this.databasePath))}/`)) {
      throw new MaintenanceError("Backup path is outside the workspace backup directory.");
    }
    await stat(source).catch(() => { throw new MaintenanceError("Backup file not found."); });
    assertHealthySqliteFile(source);

    const pending = pendingRestorePathFor(this.databasePath);
    const temporary = `${pending}.${randomUUID()}.tmp`;
    await copyFile(source, temporary);
    assertHealthySqliteFile(temporary);
    await rename(temporary, pending);
    await writeFile(pendingRestoreMetadataPathFor(this.databasePath), JSON.stringify({ backupName: name }), "utf8");
    this.record("RESTORE", "RESTORE_STAGED", { name, pending: true });
    return { backupName: name, restartRequired: true };
  }

  async cancelPendingRestore(confirm: boolean) {
    this.assertFileDatabase();
    if (!confirm) throw new MaintenanceError("Cancelling a staged restore requires explicit confirmation.");
    await rm(pendingRestorePathFor(this.databasePath), { force: true });
    await rm(pendingRestoreMetadataPathFor(this.databasePath), { force: true });
    this.record("CLEANUP", "PENDING_RESTORE_CANCELLED", {});
    return { cancelled: true };
  }

  diagnostics() {
    const staleBefore = Date.now() - 6 * 60 * 60 * 1_000;
    const activeLeases = this.db.select().from(worktreeUsages).where(isNull(worktreeUsages.endedAt)).all();
    return {
      pendingRestore: this.databasePath !== ":memory:" && Boolean(
        requireFileExists(pendingRestorePathFor(this.databasePath)),
      ),
      errorWorktrees: this.db.select().from(worktrees).where(eq(worktrees.status, "ERROR")).all(),
      staleUsageLeases: activeLeases.filter((lease) => Date.parse(lease.startedAt) <= staleBefore),
      recentMaintenance: this.db.select().from(maintenanceAudit)
        .orderBy(desc(maintenanceAudit.createdAt)).limit(20).all(),
    };
  }

  auditExport() {
    return {
      generatedAt: new Date().toISOString(),
      maintenance: this.db.select().from(maintenanceAudit).orderBy(asc(maintenanceAudit.createdAt)).all(),
      usageSafety: this.db.select().from(usageSafetyAudit).orderBy(asc(usageSafetyAudit.createdAt)).all(),
      tasks: this.db.select({
        id: tasks.id, projectId: tasks.projectId, type: tasks.type, status: tasks.status,
        createdAt: tasks.createdAt, updatedAt: tasks.updatedAt,
      }).from(tasks).orderBy(asc(tasks.createdAt)).all(),
      agentRuns: this.db.select({
        id: agentRuns.id, projectId: agentRuns.projectId, taskId: agentRuns.taskId,
        worktreeId: agentRuns.worktreeId, provider: agentRuns.provider, role: agentRuns.role,
        requestedModel: agentRuns.requestedModel, actualModel: agentRuns.actualModel,
        permissionProfile: agentRuns.permissionProfile, webAccessPolicy: agentRuns.webAccessPolicy,
        webAccessPermitted: agentRuns.webAccessPermitted, status: agentRuns.status,
        exitCode: agentRuns.exitCode, createdAt: agentRuns.createdAt, startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
      }).from(agentRuns).orderBy(asc(agentRuns.createdAt)).all(),
      builds: this.db.select({
        id: buildRuns.id, taskId: buildRuns.taskId, projectId: buildRuns.projectId,
        builderProvider: buildRuns.builderProvider, reviewerProvider: buildRuns.reviewerProvider,
        status: buildRuns.status, reviewRound: buildRuns.reviewRound,
        mergeStatus: buildRuns.mergeStatus, mergeTargetBranch: buildRuns.mergeTargetBranch,
        mergeCommitSha: buildRuns.mergeCommitSha, createdAt: buildRuns.createdAt,
        updatedAt: buildRuns.updatedAt,
      }).from(buildRuns).orderBy(asc(buildRuns.createdAt)).all(),
      experiments: this.db.select({
        id: experiments.id, taskId: experiments.taskId, projectId: experiments.projectId,
        builderProvider: experiments.builderProvider, reviewerProvider: experiments.reviewerProvider,
        status: experiments.status, verdict: experiments.verdict, createdAt: experiments.createdAt,
        updatedAt: experiments.updatedAt,
      }).from(experiments).orderBy(asc(experiments.createdAt)).all(),
      adrs: this.db.select({
        id: adrs.id, projectId: adrs.projectId, taskId: adrs.taskId, number: adrs.number,
        status: adrs.status, createdAt: adrs.createdAt, updatedAt: adrs.updatedAt,
      }).from(adrs).orderBy(asc(adrs.createdAt)).all(),
    };
  }

  private record(
    category: "BACKUP" | "RESTORE" | "CLEANUP",
    action: string,
    detail: Record<string, unknown>,
  ) {
    this.db.insert(maintenanceAudit).values({
      id: randomUUID(), category, action, entityType: "DATABASE", entityId: null,
      detail, createdAt: new Date().toISOString(),
    }).run();
  }
}

function requireFileExists(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
