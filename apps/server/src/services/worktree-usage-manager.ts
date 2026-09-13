import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { worktrees, worktreeUsages } from "../db/schema.js";

export type WorktreeUsageOwner = "AGENT_RUN" | "VALIDATION" | "SYSTEM";

/** A lease held longer than this without ending is surfaced as stale so a human can recover it. */
export const STALE_USAGE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export class WorktreeUsageManager {
  constructor(private readonly db: WorkspaceDatabase, private readonly staleAfterMs = STALE_USAGE_THRESHOLD_MS) {}

  isInUse(worktreeId: string) {
    return Boolean(this.db.select({ id: worktreeUsages.id }).from(worktreeUsages).where(and(
      eq(worktreeUsages.worktreeId, worktreeId),
      isNull(worktreeUsages.endedAt),
    )).get());
  }

  listActive(worktreeId: string) {
    const now = Date.now();
    return this.db.select().from(worktreeUsages).where(and(
      eq(worktreeUsages.worktreeId, worktreeId),
      isNull(worktreeUsages.endedAt),
    )).all().map((usage) => ({ ...usage, stale: now - Date.parse(usage.startedAt) > this.staleAfterMs }));
  }

  /** Explicit human recovery for a lease that a crashed or forgotten process never released. */
  releaseById(worktreeId: string, usageId: string) {
    const endedAt = new Date().toISOString();
    const result = this.db.update(worktreeUsages).set({ endedAt }).where(and(
      eq(worktreeUsages.id, usageId),
      eq(worktreeUsages.worktreeId, worktreeId),
      isNull(worktreeUsages.endedAt),
    )).run();
    return result.changes > 0;
  }

  acquire(worktreeId: string, ownerType: WorktreeUsageOwner, ownerId: string) {
    if (!this.db.select({ id: worktrees.id }).from(worktrees).where(eq(worktrees.id, worktreeId)).get()) {
      throw new Error("Worktree not found.");
    }
    const existing = this.db.select().from(worktreeUsages).where(and(
      eq(worktreeUsages.worktreeId, worktreeId),
      eq(worktreeUsages.ownerType, ownerType),
      eq(worktreeUsages.ownerId, ownerId),
      isNull(worktreeUsages.endedAt),
    )).get();
    if (existing) return existing;
    const usage = { id: randomUUID(), worktreeId, ownerType, ownerId, startedAt: new Date().toISOString(), endedAt: null };
    this.db.insert(worktreeUsages).values(usage).run();
    return usage;
  }

  release(worktreeId: string, ownerType: WorktreeUsageOwner, ownerId: string) {
    const endedAt = new Date().toISOString();
    const result = this.db.update(worktreeUsages).set({ endedAt }).where(and(
      eq(worktreeUsages.worktreeId, worktreeId),
      eq(worktreeUsages.ownerType, ownerType),
      eq(worktreeUsages.ownerId, ownerId),
      isNull(worktreeUsages.endedAt),
    )).run();
    return result.changes > 0;
  }
}
