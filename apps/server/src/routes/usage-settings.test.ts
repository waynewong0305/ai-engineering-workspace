import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("usage and cost settings routes", () => {
  it("reads and updates collection preferences and named task-budget presets", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);

    const initial = await app.inject({ method: "GET", url: "/api/usage/settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ trackUsage: true, defaultBudgetPreset: "BALANCED" });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/usage/settings",
      payload: {
        trackUsage: false,
        showApiEquivalentCost: false,
        storeRawTelemetry: false,
        defaultBudgetPreset: "ECONOMY",
        budgetPresets: {
          ECONOMY: { maxAgentRuns: 2, maxReviewRounds: 1, warningPercent: 70 },
          BALANCED: { maxAgentRuns: 6, maxReviewRounds: 3, warningPercent: 80 },
          DEEP: { maxAgentRuns: 12, maxReviewRounds: 5, warningPercent: 90 },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ trackUsage: false, showApiEquivalentCost: false, defaultBudgetPreset: "ECONOMY" });

    const invalid = await app.inject({
      method: "PATCH", url: "/api/usage/settings", payload: { defaultBudgetPreset: "CUSTOM" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("returns an honest not-found response for a missing task budget", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/tasks/missing/usage-budget" })).statusCode).toBe(404);
  });
});
