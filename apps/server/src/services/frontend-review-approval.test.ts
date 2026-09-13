import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { projects, tasks } from "../db/schema.js";
import { FrontendReviewApprovalError, FrontendReviewApprovalService } from "./frontend-review-approval.js";

const databases: Array<ReturnType<typeof createDatabase>["sqlite"]> = [];

function serviceWithTask() {
  const { db, sqlite } = createDatabase(":memory:");
  databases.push(sqlite);
  const now = new Date().toISOString();
  const projectId = randomUUID();
  db.insert(projects).values({
    id: projectId, name: "Fixture", repositoryPath: `/tmp/fixture-${projectId}`, defaultBranch: "main",
    currentBranch: "main", worktreeRoot: `/tmp/fixture-${projectId}-worktrees`, projectContext: null,
    validationCommands: [], gitStatus: "CLEAN", createdAt: now, updatedAt: now,
  }).run();
  const taskId = randomUUID();
  db.insert(tasks).values({
    id: taskId, projectId, title: "Ship the new dashboard", problemStatement: "Needs a UI review.",
    type: "IMPLEMENTATION", status: "READY", riskLevel: "MEDIUM", webAccessPolicy: "DISABLED",
    webAccessPermitted: false, webAccessDecidedAt: now, webAccessDecidedBy: "USER",
    originAdrId: null, planPhase: null, errorMessage: null, createdAt: now, updatedAt: now,
  }).run();
  return { service: new FrontendReviewApprovalService(db), taskId };
}

function validRequest(overrides: Record<string, unknown> = {}) {
  return {
    provider: "CLAUDE",
    agentConfiguration: "claude-sonnet-5, effort: medium",
    reason: "The responsive layout regression test failed on the new checkout page.",
    scope: "Checkout page only, desktop and mobile screenshots plus console/network capture.",
    triggerDescription: "Automated responsive check flagged an overlapping element at 375px width.",
    ...overrides,
  };
}

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
});

describe("FrontendReviewApprovalService", () => {
  it("records a pending request with everything a human must see before deciding", () => {
    const { service, taskId } = serviceWithTask();
    const request = service.request(taskId, validRequest());
    expect(request).toMatchObject({
      taskId, provider: "CLAUDE", status: "PENDING", decidedAt: null, consumedAt: null, consumedByRunId: null,
    });
    expect(request.reason).toContain("responsive layout regression");
    expect(service.listForTask(taskId)).toEqual([request]);
  });

  it("rejects a request missing required disclosure fields, and an unknown task", () => {
    const { service, taskId } = serviceWithTask();
    expect(() => service.request(taskId, validRequest({ reason: "" }))).toThrow(FrontendReviewApprovalError);
    expect(() => service.request(taskId, validRequest({ provider: "GPT" }))).toThrow(FrontendReviewApprovalError);
    expect(() => service.request("does-not-exist", validRequest())).toThrowError(
      expect.objectContaining({ code: "TASK_NOT_FOUND" }),
    );
  });

  it("only ever lets a PENDING request be decided once", () => {
    const { service, taskId } = serviceWithTask();
    const request = service.request(taskId, validRequest());
    const approved = service.decide(request.id, "APPROVED");
    expect(approved.status).toBe("APPROVED");
    expect(approved.decidedAt).toBeTruthy();
    expect(() => service.decide(request.id, "REFUSED")).toThrowError(expect.objectContaining({ code: "ALREADY_DECIDED" }));
  });

  it("consumes an approval exactly once for the disclosed run, and never lets a refusal or undecided request through", () => {
    const { service, taskId } = serviceWithTask();

    const refused = service.request(taskId, validRequest());
    service.decide(refused.id, "REFUSED");
    expect(() => service.assertApprovedAndConsume(refused.id, "run-1")).toThrowError(expect.objectContaining({ code: "REFUSED" }));

    const pending = service.request(taskId, validRequest());
    expect(() => service.assertApprovedAndConsume(pending.id, "run-2")).toThrowError(expect.objectContaining({ code: "NOT_DECIDED" }));

    const approved = service.request(taskId, validRequest());
    service.decide(approved.id, "APPROVED");
    const consumed = service.assertApprovedAndConsume(approved.id, "run-3");
    expect(consumed).toMatchObject({ status: "CONSUMED", consumedByRunId: "run-3" });
    expect(consumed.consumedAt).toBeTruthy();

    // The same approval can never be reused for a second, broader, or later run.
    expect(() => service.assertApprovedAndConsume(approved.id, "run-4")).toThrowError(expect.objectContaining({ code: "ALREADY_CONSUMED" }));
  });

  it("throws NOT_FOUND for an unknown approval id on decide or consume", () => {
    const { service } = serviceWithTask();
    expect(() => service.decide("does-not-exist", "APPROVED")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => service.assertApprovedAndConsume("does-not-exist", "run-1")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
  });
});
