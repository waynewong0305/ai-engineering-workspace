import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("maintenance routes", () => {
  it("creates and lists backups, stages/cancels restore explicitly, and exports audit history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiew-maintenance-api-"));
    const app = buildApp({ databasePath: join(directory, "workspace.sqlite"), adapters: [] });
    apps.push(app);

    const created = await app.inject({ method: "POST", url: "/api/maintenance/backups" });
    expect(created.statusCode).toBe(201);
    const backup = created.json();

    const status = await app.inject({ method: "GET", url: "/api/maintenance" });
    expect(status.statusCode).toBe(200);
    expect(status.json().backups).toContainEqual(expect.objectContaining({ name: backup.name }));

    const unconfirmed = await app.inject({
      method: "POST", url: "/api/maintenance/restore", payload: { backupName: backup.name, confirm: false },
    });
    expect(unconfirmed.statusCode).toBe(400);
    const staged = await app.inject({
      method: "POST", url: "/api/maintenance/restore", payload: { backupName: backup.name, confirm: true },
    });
    expect(staged.statusCode).toBe(202);
    expect(staged.json()).toMatchObject({ restartRequired: true });
    expect((await app.inject({ method: "GET", url: "/api/maintenance" })).json().pendingRestore).toBe(true);

    const cancelled = await app.inject({
      method: "DELETE", url: "/api/maintenance/restore", payload: { confirm: true },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/maintenance" })).json().pendingRestore).toBe(false);

    const audit = await app.inject({ method: "GET", url: "/api/maintenance/audit/export" });
    expect(audit.statusCode).toBe(200);
    expect(audit.headers["content-disposition"]).toContain("attachment");
    expect(audit.json().maintenance.map((event: { action: string }) => event.action)).toEqual([
      "BACKUP_CREATED", "RESTORE_STAGED", "PENDING_RESTORE_CANCELLED",
    ]);
  });

  it("reports that file backups are unavailable for an in-memory database", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/maintenance" });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("file-backed");
  });
});
