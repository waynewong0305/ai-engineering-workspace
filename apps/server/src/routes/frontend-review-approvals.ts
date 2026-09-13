import type { FastifyInstance, FastifyReply } from "fastify";
import type { WorkspaceDatabase } from "../db/database.js";
import { FrontendReviewApprovalError, FrontendReviewApprovalService } from "../services/frontend-review-approval.js";

function approvalError(reply: FastifyReply, error: unknown) {
  if (error instanceof FrontendReviewApprovalError) {
    const notFound = error.code === "TASK_NOT_FOUND" || error.code === "NOT_FOUND";
    return reply.code(notFound ? 404 : error.code === "INVALID_INPUT" ? 400 : 409).send({ message: error.message, code: error.code });
  }
  throw error;
}

type RequestBody = {
  provider?: unknown;
  agentConfiguration?: unknown;
  reason?: unknown;
  scope?: unknown;
  triggerDescription?: unknown;
};

type DecideBody = { decision?: unknown };

export function registerFrontendReviewApprovalRoutes(
  app: FastifyInstance,
  db: WorkspaceDatabase,
  service: FrontendReviewApprovalService = new FrontendReviewApprovalService(db),
) {
  app.get<{ Params: { id: string } }>("/api/tasks/:id/frontend-review-approvals", async (request, reply) => {
    try {
      return service.listForTask(request.params.id);
    } catch (error) {
      return approvalError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: RequestBody }>("/api/tasks/:id/frontend-review-approvals", async (request, reply) => {
    try {
      return reply.code(201).send(service.request(request.params.id, request.body ?? {}));
    } catch (error) {
      return approvalError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/frontend-review-approvals/:id", async (request, reply) => {
    const record = service.get(request.params.id);
    if (!record) return reply.code(404).send({ message: "Frontend review approval request not found." });
    return record;
  });

  app.post<{ Params: { id: string }; Body: DecideBody }>("/api/frontend-review-approvals/:id/decide", async (request, reply) => {
    if (request.body?.decision !== "APPROVED" && request.body?.decision !== "REFUSED") {
      return reply.code(400).send({ message: "decision must be APPROVED or REFUSED." });
    }
    try {
      return service.decide(request.params.id, request.body.decision);
    } catch (error) {
      return approvalError(reply, error);
    }
  });
}
