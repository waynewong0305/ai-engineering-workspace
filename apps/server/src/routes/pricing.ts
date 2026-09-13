import { randomUUID } from "node:crypto";
import type { AgentProvider } from "@aiew/agents";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { pricingEntries } from "../db/schema.js";

type CreatePricingBody = {
  provider?: unknown;
  model?: unknown;
  inputPricePerMillion?: unknown;
  cachedInputPricePerMillion?: unknown;
  cacheCreationInputPricePerMillion?: unknown;
  outputPricePerMillion?: unknown;
  reasoningPricePerMillion?: unknown;
  effectiveFrom?: unknown;
  source?: unknown;
};

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredRate(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function optionalRate(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : "invalid";
}

export function registerPricingRoutes(app: FastifyInstance, db: WorkspaceDatabase) {
  app.get<{ Querystring: { provider?: string; model?: string } }>("/api/usage/pricing", async (request, reply) => {
    const filters = [];
    if (request.query.provider && request.query.provider !== "CLAUDE" && request.query.provider !== "CODEX") {
      return reply.code(400).send({ message: "Provider must be CLAUDE or CODEX." });
    }
    if (request.query.provider === "CLAUDE" || request.query.provider === "CODEX") {
      filters.push(eq(pricingEntries.provider, request.query.provider));
    }
    if (request.query.model?.trim()) filters.push(eq(pricingEntries.model, request.query.model.trim()));
    const query = db.select().from(pricingEntries);
    return filters.length
      ? query.where(and(...filters)).orderBy(desc(pricingEntries.effectiveFrom)).all()
      : query.orderBy(desc(pricingEntries.effectiveFrom)).all();
  });

  app.post<{ Body: CreatePricingBody }>("/api/usage/pricing", async (request, reply) => {
    const provider = requiredString(request.body?.provider) as AgentProvider | null;
    const model = requiredString(request.body?.model);
    const source = requiredString(request.body?.source);
    const inputPricePerMillion = requiredRate(request.body?.inputPricePerMillion);
    const outputPricePerMillion = requiredRate(request.body?.outputPricePerMillion);
    const cachedInputPricePerMillion = optionalRate(request.body?.cachedInputPricePerMillion);
    const cacheCreationInputPricePerMillion = optionalRate(request.body?.cacheCreationInputPricePerMillion);
    const reasoningPricePerMillion = optionalRate(request.body?.reasoningPricePerMillion);
    const effectiveFrom = requiredString(request.body?.effectiveFrom) ?? new Date().toISOString();

    if (provider !== "CLAUDE" && provider !== "CODEX") {
      return reply.code(400).send({ message: "Provider must be CLAUDE or CODEX." });
    }
    if (!model || model.length > 200) return reply.code(400).send({ message: "A model ID of 200 characters or fewer is required." });
    if (!source || source.length > 1_000) return reply.code(400).send({ message: "A pricing source of 1,000 characters or fewer is required." });
    if (inputPricePerMillion === null || outputPricePerMillion === null
      || cachedInputPricePerMillion === "invalid"
      || cacheCreationInputPricePerMillion === "invalid"
      || reasoningPricePerMillion === "invalid") {
      return reply.code(400).send({ message: "Prices must be finite, non-negative numbers; input and output prices are required." });
    }
    if (!Number.isFinite(Date.parse(effectiveFrom))) {
      return reply.code(400).send({ message: "Effective-from must be a valid date and time." });
    }

    const entry = {
      id: randomUUID(), provider, model,
      inputPricePerMillion,
      cachedInputPricePerMillion,
      cacheCreationInputPricePerMillion,
      outputPricePerMillion,
      reasoningPricePerMillion,
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      source,
      createdAt: new Date().toISOString(),
    };
    try {
      db.insert(pricingEntries).values(entry).run();
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return reply.code(409).send({ message: "That provider, model, and effective date already have a pricing version." });
      }
      throw error;
    }
    return reply.code(201).send(entry);
  });
}
