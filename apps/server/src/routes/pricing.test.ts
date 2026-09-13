import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";

const apps: Array<ReturnType<typeof buildApp>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("pricing routes", () => {
  it("creates immutable pricing versions and lists newest-effective first", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const first = {
      provider: "CODEX", model: "model-v1", inputPricePerMillion: 2,
      cachedInputPricePerMillion: 0.5, outputPricePerMillion: 8,
      effectiveFrom: "2026-01-01T00:00:00.000Z", source: "Fixture source v1",
    };
    expect((await app.inject({ method: "POST", url: "/api/usage/pricing", payload: first })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/usage/pricing", payload: {
      ...first, inputPricePerMillion: 3, effectiveFrom: "2026-06-01T00:00:00.000Z", source: "Fixture source v2",
    } })).statusCode).toBe(201);

    const listed = (await app.inject({ method: "GET", url: "/api/usage/pricing?provider=CODEX&model=model-v1" })).json();
    expect(listed).toHaveLength(2);
    expect(listed.map((entry: { source: string }) => entry.source)).toEqual(["Fixture source v2", "Fixture source v1"]);
    expect((await app.inject({ method: "POST", url: "/api/usage/pricing", payload: first })).statusCode).toBe(409);
  });

  it("rejects missing sources, unknown providers, invalid dates, and invalid prices", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const valid = {
      provider: "CLAUDE", model: "model-v1", inputPricePerMillion: 3,
      outputPricePerMillion: 15, effectiveFrom: "2026-01-01T00:00:00.000Z", source: "Fixture source",
    };
    for (const payload of [
      { ...valid, source: "" },
      { ...valid, provider: "OTHER" },
      { ...valid, effectiveFrom: "not-a-date" },
      { ...valid, inputPricePerMillion: -1 },
      { ...valid, cachedInputPricePerMillion: -0.1 },
    ]) {
      expect((await app.inject({ method: "POST", url: "/api/usage/pricing", payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/api/usage/pricing?provider=OTHER" })).statusCode).toBe(400);
  });

  it("exposes an explicit cost-calculation pass", async () => {
    const app = buildApp({ databasePath: ":memory:", adapters: [] });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/usage-records/calculate-costs" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ scanned: 0, calculated: 0, unavailable: 0 });
  });
});
