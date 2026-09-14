import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter } from "@aiew/agents";
import { buildApp } from "../app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("usage safety routes", () => {
  it("reports UNAVAILABLE for both providers with no fabricated data before any reading exists", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const usage = (await app.inject({ method: "GET", url: "/api/usage" })).json();
    expect(usage.CLAUDE).toMatchObject([{ status: "UNAVAILABLE", usedPercent: null }]);
    expect(usage.CODEX).toMatchObject([{ status: "UNAVAILABLE", usedPercent: null }]);
  });

  it("accepts a validated manual snapshot and reflects it in the provider's usage view", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const invalid = await app.inject({
      method: "POST", url: "/api/usage/manual-snapshot",
      payload: { provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 150 },
    });
    expect(invalid.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST", url: "/api/usage/manual-snapshot",
      payload: { provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 80 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ source: "MANUAL", sourceConfidence: "ESTIMATED" });

    const view = (await app.inject({ method: "GET", url: "/api/usage/CLAUDE" })).json();
    expect(view[0]).toMatchObject({ status: "WARNING", usedPercent: 80, source: "MANUAL" });
  });

  it("reads and updates the safety policy, rejecting an invalid threshold pair", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const policy = (await app.inject({ method: "GET", url: "/api/usage/policy" })).json();
    expect(policy).toMatchObject({ warningThresholdPercent: 75, checkpointThresholdPercent: 90 });

    const rejected = await app.inject({
      method: "PATCH", url: "/api/usage/policy",
      payload: { warningThresholdPercent: 95, checkpointThresholdPercent: 50 },
    });
    expect(rejected.statusCode).toBe(400);

    const updated = await app.inject({
      method: "PATCH", url: "/api/usage/policy",
      payload: { warningThresholdPercent: 50, checkpointThresholdPercent: 70 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ warningThresholdPercent: 50, checkpointThresholdPercent: 70 });
  });

  it("records an acknowledgement and makes it visible in the audit history", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/api/usage/acknowledge",
      payload: { provider: "CODEX", status: "UNAVAILABLE", userAction: "PROCEED", reason: "Proceeding without automatic usage data." },
    });
    expect(response.statusCode).toBe(201);
    const audit = (await app.inject({ method: "GET", url: "/api/usage/audit?provider=CODEX" })).json();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ eventType: "ACKNOWLEDGEMENT", userAction: "PROCEED", provider: "CODEX" });
  });

  it("refresh reports no automatic source rather than fabricating a percentage", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/usage/CLAUDE/refresh" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ updated: false });
  });

  it("refreshes Codex through its adapter and exposes the exact App Server source", async () => {
    const adapter = {
      name: "CODEX",
      readUsage: async () => [{
        windowId: "5H", windowLabel: "5-hour usage window", windowDurationMs: 18_000_000,
        usedPercent: 44, resetAt: "2026-09-14T02:00:00.000Z",
      }],
    } as AgentAdapter;
    const app = buildApp({ databasePath: ":memory:", adapters: [adapter] });
    apps.push(app);

    const refreshed = await app.inject({ method: "POST", url: "/api/usage/CODEX/refresh" });
    expect(refreshed.json()).toMatchObject({ provider: "CODEX", updated: true });
    const view = (await app.inject({ method: "GET", url: "/api/usage/CODEX" })).json();
    expect(view[0]).toMatchObject({ usedPercent: 44, source: "APP_SERVER", sourceConfidence: "EXACT" });
  });
});
