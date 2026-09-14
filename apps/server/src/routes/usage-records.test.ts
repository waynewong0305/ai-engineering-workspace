import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("usage dashboard routes", () => {
  it("returns an empty, honestly labeled dashboard", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/usage-records/dashboard?period=7d" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      range: { period: "7d" },
      summary: { runs: 0, totalTokens: 0, exactTokenRuns: 0, unavailableTokenRuns: 0 },
      byProvider: [], byWorkflow: [], runs: [],
    });
  });

  it("rejects an unknown period and an invalid custom range", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/usage-records/dashboard?period=year" })).statusCode).toBe(400);
    expect((await app.inject({
      method: "GET", url: "/api/usage-records/dashboard?period=custom&from=2026-09-20&to=2026-09-10",
    })).statusCode).toBe(400);
  });
});
