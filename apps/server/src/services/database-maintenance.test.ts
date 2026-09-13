import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { maintenanceAudit, projects } from "../db/schema.js";
import { DatabaseMaintenanceService } from "./database-maintenance.js";

describe("DatabaseMaintenanceService", () => {
  it("creates an integrity-checked backup and restores it only on the next database open", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiew-maintenance-"));
    const databasePath = join(directory, "workspace.sqlite");
    const initial = createDatabase(databasePath);
    const now = new Date().toISOString();
    initial.db.insert(projects).values({
      id: "project", name: "Before backup", repositoryPath: "/tmp/fixture", defaultBranch: "main",
      currentBranch: "main", worktreeRoot: "/tmp/worktrees", projectContext: null,
      validationCommands: [], gitStatus: "CLEAN", createdAt: now, updatedAt: now,
    }).run();
    const maintenance = new DatabaseMaintenanceService(initial.db, initial.sqlite, databasePath);
    const backup = await maintenance.createBackup();
    expect(backup.name).toMatch(/^workspace-.*\.sqlite$/);
    expect(backup.sizeBytes).toBeGreaterThan(0);
    expect(await maintenance.listBackups()).toContainEqual(backup);

    initial.db.update(projects).set({ name: "After backup" }).run();
    await expect(maintenance.stageRestore(backup.name, false)).rejects.toThrow(/explicit confirmation/);
    await expect(maintenance.stageRestore("../outside.sqlite", true)).rejects.toThrow(/backup file/);
    await expect(maintenance.stageRestore(backup.name, true)).resolves.toEqual({
      backupName: backup.name, restartRequired: true,
    });
    expect(initial.db.select().from(projects).get()?.name).toBe("After backup");
    initial.sqlite.close();

    const restored = createDatabase(databasePath);
    expect(restored.appliedRestore).toMatchObject({ restoredFrom: backup.name });
    expect(restored.db.select().from(projects).get()?.name).toBe("Before backup");
    expect(restored.db.select().from(maintenanceAudit).all()).toContainEqual(expect.objectContaining({
      category: "RESTORE", action: "RESTORE_APPLIED",
    }));
    await expect(access(restored.appliedRestore!.previousDatabaseBackup!)).resolves.toBeUndefined();
    const previous = createDatabase(restored.appliedRestore!.previousDatabaseBackup!);
    expect(previous.db.select().from(projects).get()?.name).toBe("After backup");
    previous.sqlite.close();
    restored.sqlite.close();
  });

  it("exports audit metadata without prompts or model output", () => {
    const { db, sqlite } = createDatabase(":memory:");
    const maintenance = new DatabaseMaintenanceService(db, sqlite, ":memory:");
    const exported = maintenance.auditExport();
    expect(exported).toMatchObject({
      maintenance: [], usageSafety: [], tasks: [], agentRuns: [], builds: [], experiments: [], adrs: [],
    });
    expect(JSON.stringify(exported)).not.toContain("rawOutput");
    expect(JSON.stringify(exported)).not.toContain("prompt");
    sqlite.close();
  });
});
