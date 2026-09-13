import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import {
  frontendReviewApprovals,
  tasks,
  type FrontendReviewApprovalRecord,
  type FrontendReviewApprovalStatus,
  type UsageProvider,
} from "../db/schema.js";

const MAX_SHORT_FIELD = 300;
const MAX_LONG_FIELD = 10_000;

export class FrontendReviewApprovalError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "FrontendReviewApprovalError";
  }
}

function requiredText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength ? value.trim() : null;
}

/**
 * PROJECT_SPEC.md §24.1: the single, provider-neutral gate a model-backed agent run must pass
 * through before it may inspect the rendered frontend or receive screenshots, rendered pages,
 * DOM/accessibility output, or other browser evidence. This is the only place that decision is
 * made — mirroring UsageSafetyService's role for provider-usage safety — so a future frontend
 * verification runner (or any other current or future adapter) must call `assertApprovedAndConsume`
 * immediately before launching such a run rather than deciding on its own.
 *
 * Deliberately excludes any decision about *whether* a frontend review is warranted or what the
 * runner actually does: that recommendation logic and the browser-automation runner itself are a
 * separate, not-yet-built piece of work. This service only enforces that a human explicitly saw and
 * approved the disclosed reason/scope/provider/configuration before any provider run consumes it.
 */
export class FrontendReviewApprovalService {
  constructor(private readonly db: WorkspaceDatabase) {}

  request(taskId: string, input: Record<string, unknown>): FrontendReviewApprovalRecord {
    if (!this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).get()) {
      throw new FrontendReviewApprovalError("Task not found.", "TASK_NOT_FOUND");
    }
    if (input.provider !== "CLAUDE" && input.provider !== "CODEX") {
      throw new FrontendReviewApprovalError("provider must be CLAUDE or CODEX.", "INVALID_INPUT");
    }
    const agentConfiguration = requiredText(input.agentConfiguration, MAX_SHORT_FIELD);
    const reason = requiredText(input.reason, MAX_LONG_FIELD);
    const scope = requiredText(input.scope, MAX_LONG_FIELD);
    if (!agentConfiguration || !reason || !scope) {
      throw new FrontendReviewApprovalError(
        "agentConfiguration (300 characters), reason, and scope (10,000 characters each) are all required — a human must see why review is recommended, which agent configuration will run, and exactly which pages/scenarios/evidence will be shared.",
        "INVALID_INPUT",
      );
    }
    let triggerDescription: string | null = null;
    if (input.triggerDescription !== undefined && input.triggerDescription !== null) {
      triggerDescription = requiredText(input.triggerDescription, MAX_LONG_FIELD);
      if (!triggerDescription) throw new FrontendReviewApprovalError("triggerDescription must be a non-blank string of 10,000 characters or fewer.", "INVALID_INPUT");
    }
    const record: FrontendReviewApprovalRecord = {
      id: randomUUID(), taskId, provider: input.provider as UsageProvider, agentConfiguration, reason, scope,
      triggerDescription, status: "PENDING", decidedAt: null, consumedAt: null, consumedByRunId: null,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(frontendReviewApprovals).values(record).run();
    return record;
  }

  listForTask(taskId: string): FrontendReviewApprovalRecord[] {
    return this.db.select().from(frontendReviewApprovals).where(eq(frontendReviewApprovals.taskId, taskId))
      .orderBy(desc(frontendReviewApprovals.createdAt)).all();
  }

  get(id: string): FrontendReviewApprovalRecord | undefined {
    return this.db.select().from(frontendReviewApprovals).where(eq(frontendReviewApprovals.id, id)).get();
  }

  /** The human's explicit decision on one disclosed request. Only a still-PENDING request may be decided. */
  decide(id: string, decision: "APPROVED" | "REFUSED"): FrontendReviewApprovalRecord {
    const current = this.get(id);
    if (!current) throw new FrontendReviewApprovalError("Frontend review approval request not found.", "NOT_FOUND");
    if (current.status !== "PENDING") {
      throw new FrontendReviewApprovalError(`This request was already decided (${current.status}); a new request is needed to ask again.`, "ALREADY_DECIDED");
    }
    const decidedAt = new Date().toISOString();
    this.db.update(frontendReviewApprovals).set({ status: decision, decidedAt }).where(eq(frontendReviewApprovals.id, id)).run();
    return { ...current, status: decision, decidedAt };
  }

  /**
   * The actual enforcement point: call this immediately before starting the disclosed model-backed
   * run, never before. Throws for anything other than a currently-APPROVED, unconsumed request — a
   * refusal, an undecided request, or one already spent on a different run — so a caller can produce
   * an honest `HUMAN_REVIEW_REQUIRED`/`UI_REVIEW_SKIPPED` outcome instead of ever fabricating
   * `UI_VERIFIED`. On success, marks the request CONSUMED so it can never be reused for a broader or
   * later run — exactly one disclosed run per approval.
   */
  assertApprovedAndConsume(id: string, consumedByRunId: string): FrontendReviewApprovalRecord {
    const current = this.get(id);
    if (!current) throw new FrontendReviewApprovalError("Frontend review approval request not found.", "NOT_FOUND");
    if (current.status === "PENDING") {
      throw new FrontendReviewApprovalError("This request has not yet been decided by a human.", "NOT_DECIDED");
    }
    if (current.status === "REFUSED") {
      throw new FrontendReviewApprovalError("This frontend review was refused and cannot be started.", "REFUSED");
    }
    if (current.status === "CONSUMED") {
      throw new FrontendReviewApprovalError("This approval was already used to start a different run; a new approval is required.", "ALREADY_CONSUMED");
    }
    const consumedAt = new Date().toISOString();
    this.db.update(frontendReviewApprovals).set({ status: "CONSUMED", consumedAt, consumedByRunId }).where(eq(frontendReviewApprovals.id, id)).run();
    return { ...current, status: "CONSUMED", consumedAt, consumedByRunId };
  }
}

export type { FrontendReviewApprovalStatus };
