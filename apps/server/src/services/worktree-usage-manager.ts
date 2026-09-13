import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { WorkspaceDatabase } from "../db/database.js";
import { worktrees, worktreeUsages } from "../db/schema.js";

export type WorktreeUsageOwner = "AGENT_RUN" | "VALIDATION" | "SYSTEM";

export class WorktreeUsageManager {
  constructor(private readonly db: WorkspaceDatabase) {}

  isInUse(worktreeId: string) {
    return Boolean(this.db.select({ id: worktreeUsages.id }).from(worktreeUsages).where(and(
      eq(worktreeUsages.worktreeId, worktreeId),
      isNull(worktreeUsages.endedAt),
    )).get());
  }

  listActive(worktreeId: string) {
    return this.db.select().from(worktreeUsages).where(and(
      eq(worktreeUsages.worktreeId, worktreeId),
      isNull(worktreeUsages.endedAt),
    )).all();
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
