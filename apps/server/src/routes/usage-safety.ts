import type { FastifyInstance, FastifyReply } from "fastify";
import type { UsageProvider } from "../db/schema.js";
import { UsageSafetyService, UsageValidationError } from "../services/usage-safety.js";

function badRequest(reply: FastifyReply, error: unknown) {
  if (error instanceof UsageValidationError) return reply.code(400).send({ message: error.message });
  return reply.code(500).send({ message: "Usage safety operation failed." });
}

function asProvider(value: unknown): UsageProvider | null {
  return value === "CLAUDE" || value === "CODEX" ? value : null;
}

export function registerUsageSafetyRoutes(app: FastifyInstance, usageSafety: UsageSafetyService) {
  app.get("/api/usage", async () => usageSafety.getAllUsage());

  app.get<{ Params: { provider: string } }>("/api/usage/:provider", async (request, reply) => {
    const provider = asProvider(request.params.provider.toUpperCase());
    if (!provider) return reply.code(400).send({ message: "Provider must be CLAUDE or CODEX." });
    return usageSafety.getProviderUsage(provider);
  });

  app.post<{ Params: { provider: string } }>("/api/usage/:provider/refresh", async (request, reply) => {
    const provider = asProvider(request.params.provider.toUpperCase());
    if (!provider) return reply.code(400).send({ message: "Provider must be CLAUDE or CODEX." });
    return usageSafety.refresh(provider);
  });

  app.post<{ Body: Record<string, unknown> }>("/api/usage/manual-snapshot", async (request, reply) => {
    try {
      return reply.code(201).send(usageSafety.submitManualSnapshot(request.body ?? {}));
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get("/api/usage/policy", async () => usageSafety.getPolicy());

  app.patch<{ Body: Record<string, unknown> }>("/api/usage/policy", async (request, reply) => {
    try {
      const body = request.body ?? {};
      const patch: Record<string, number> = {};
      for (const key of ["warningThresholdPercent", "checkpointThresholdPercent", "staleAfterMs", "acknowledgementTtlMs"] as const) {
        if (body[key] !== undefined) {
          if (typeof body[key] !== "number") throw new UsageValidationError(`${key} must be a number.`);
          patch[key] = body[key] as number;
        }
      }
      return usageSafety.updatePolicy(patch);
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.post<{ Body: Record<string, unknown> }>("/api/usage/acknowledge", async (request, reply) => {
    try {
      return reply.code(201).send(usageSafety.recordAcknowledgement(request.body ?? {}));
    } catch (error) {
      return badRequest(reply, error);
    }
  });

  app.get<{ Querystring: { provider?: string } }>("/api/usage/audit", async (request, reply) => {
    if (request.query.provider !== undefined) {
      const provider = asProvider(request.query.provider.toUpperCase());
      if (!provider) return reply.code(400).send({ message: "Provider must be CLAUDE or CODEX." });
      return usageSafety.getAuditHistory(provider);
    }
    return usageSafety.getAuditHistory();
  });
}
