import type { AgentAdapter, AgentEvent, AgentHealth, AgentProvider, AgentRunInput } from "@aiew/agents";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../db/database.js";
import { agentRuns, projects, taskArtifacts, taskComparisons, tasks, usageSafetyAudit } from "../db/schema.js";
import { AgentRunManager } from "./agent-run-manager.js";
import { BrainstormWorkflow } from "./brainstorm-workflow.js";
import { UsageSafetyService } from "./usage-safety.js";

const databases: Array<ReturnType<typeof createDatabase>["sqlite"]> = [];

afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
});

function analysisJson(provider: AgentProvider) {
  return JSON.stringify({
    summary: `${provider} summary`, facts: ["A fact."], assumptions: ["An assumption."], unknowns: ["An unknown."],
    options: [{ name: "Option", description: "A candidate design.", advantages: ["Simple"], disadvantages: ["Slow"], risks: ["Risk"] }],
    recommendedExperiments: ["An experiment."], recommendation: null,
  });
}

function reviewJson(provider: AgentProvider) {
  return JSON.stringify({
    summary: `${provider} review`, agreements: ["Agreed point."], disagreements: [], factualErrors: [],
    unsupportedAssumptions: [], missingFailureCases: [], hiddenOperationalCosts: [], migrationRisks: [],
    openQuestions: [], missingEvidence: [], recommendedExperiments: [],
  });
}

class CountingAdapter implements AgentAdapter {
  runCallsByRole: Record<"INDEPENDENT_ANALYSIS" | "CROSS_REVIEW", number> = { INDEPENDENT_ANALYSIS: 0, CROSS_REVIEW: 0 };

  constructor(readonly name: AgentProvider, private readonly onRun?: (input: AgentRunInput) => void) {}

  async healthCheck(): Promise<AgentHealth> {
    return {
      provider: this.name, available: true, authenticated: true, cliVersion: `fake-${this.name.toLowerCase()} 1.0`,
      capabilities: { structuredOutput: true, sessionResume: false, dynamicModelDiscovery: false, availableModels: null, availableEffortLevels: null },
    };
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const role = input.promptVersion.startsWith("brainstorm") ? "INDEPENDENT_ANALYSIS" : "CROSS_REVIEW";
    this.runCallsByRole[role] += 1;
    this.onRun?.(input);
    const occurredAt = new Date().toISOString();
    yield { type: "started", runId: input.runId, occurredAt };
    const output = role === "INDEPENDENT_ANALYSIS" ? analysisJson(this.name) : reviewJson(this.name);
    yield { type: "stdout", runId: input.runId, occurredAt, chunk: output };
    yield {
      type: "completed", runId: input.runId, occurredAt, exitCode: 0,
      metadata: {
        provider: this.name, requestedModel: input.model.requested, actualModel: `fake-${this.name.toLowerCase()}`,
        effort: null, cliVersion: `fake-${this.name.toLowerCase()} 1.0`, promptVersion: input.promptVersion,
        webAccessPermitted: input.webAccess.permitted === true,
      },
    };
  }

  async cancel() {}
}

function setUp(onCodexAnalysisRun?: (input: AgentRunInput) => void) {
  const { db, sqlite } = createDatabase(":memory:");
  databases.push(sqlite);
  const usageSafety = new UsageSafetyService(db);
  const manager = new AgentRunManager(db, usageSafety);
  const claude = new CountingAdapter("CLAUDE");
  const codex = new CountingAdapter("CODEX", (input) => {
    if (input.promptVersion.startsWith("brainstorm")) onCodexAnalysisRun?.(input);
  });
  const workflow = new BrainstormWorkflow(db, manager, new Map<AgentProvider, AgentAdapter>([["CLAUDE", claude], ["CODEX", codex]]), usageSafety);

  const now = new Date().toISOString();
  db.insert(projects).values({
    id: "project", name: "Fixture", repositoryPath: "/tmp/fixture", defaultBranch: "main", currentBranch: "main",
    worktreeRoot: "/tmp/worktrees", projectContext: null, validationCommands: [], gitStatus: "CLEAN", createdAt: now, updatedAt: now,
  }).run();
  db.insert(tasks).values({
    id: "task", projectId: "project", title: "Usage-safety checkpoint", problemStatement: "Prove the checkpoint/resume path.",
    type: "ARCHITECTURE", status: "DRAFT", riskLevel: "HIGH", webAccessPolicy: "DISABLED", webAccessPermitted: false,
    webAccessDecidedAt: now, webAccessDecidedBy: "USER", errorMessage: null, createdAt: now, updatedAt: now,
  }).run();

  return { db, usageSafety, manager, claude, codex, workflow };
}

function taskStatus(db: ReturnType<typeof createDatabase>["db"]) {
  return db.select({ status: tasks.status, errorMessage: tasks.errorMessage }).from(tasks).where(eq(tasks.id, "task")).get()!;
}

describe("BrainstormWorkflow usage safety", () => {
  it("blocks before the very first provider call when usage is already exhausted, and starts no subprocess at all", async () => {
    const { db, usageSafety, claude, codex, workflow } = setUp();
    usageSafety.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 100 });

    await workflow.start("task");

    expect(claude.runCallsByRole.INDEPENDENT_ANALYSIS).toBe(0);
    expect(codex.runCallsByRole.INDEPENDENT_ANALYSIS).toBe(0);
    expect(db.select().from(agentRuns).all()).toHaveLength(0);
    expect(taskStatus(db).status).toBe("CHECKPOINTED");
    expect(taskStatus(db).errorMessage).toContain("exhausted");
    const audit = db.select().from(usageSafetyAudit).where(eq(usageSafetyAudit.provider, "CLAUDE")).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ eventType: "CHECKPOINT_TRIGGERED", status: "EXHAUSTED" });
  });

  it("recheck before cross-review checkpoints after analysis completes, preserves both completed analyses, refuses cross-review subprocesses, and resumes cleanly once usage is acknowledged", async () => {
    const { db, usageSafety, claude, codex, workflow } = setUp(() => {
      // Simulate usage crossing the checkpoint threshold for CLAUDE while CODEX's analysis call is
      // in flight, so both analyses still complete but the recheck before cross-review must catch it.
      usageSafety.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 92 });
    });
    // Both providers start from a known-safe reading so the analysis phase itself is not blocked;
    // only the mid-flight change (above) should trip the checkpoint, and only before cross-review.
    usageSafety.submitManualSnapshot({ provider: "CLAUDE", windowId: "5H", windowLabel: "5-hour window", usedPercent: 10 });
    usageSafety.submitManualSnapshot({ provider: "CODEX", windowId: "5H", windowLabel: "5-hour window", usedPercent: 10 });

    await workflow.start("task");

    expect(claude.runCallsByRole.INDEPENDENT_ANALYSIS).toBe(1);
    expect(codex.runCallsByRole.INDEPENDENT_ANALYSIS).toBe(1);
    expect(claude.runCallsByRole.CROSS_REVIEW).toBe(0);
    expect(codex.runCallsByRole.CROSS_REVIEW).toBe(0);

    expect(taskStatus(db).status).toBe("CHECKPOINTED");
    expect(taskStatus(db).errorMessage).toContain("checkpoint threshold");

    const analysisArtifacts = db.select().from(taskArtifacts).where(and(eq(taskArtifacts.taskId, "task"), eq(taskArtifacts.kind, "ANALYSIS"))).all();
    expect(analysisArtifacts).toHaveLength(2);
    expect(analysisArtifacts.every((artifact) => artifact.structuredData !== null && artifact.parseError === null)).toBe(true);
    expect(db.select().from(agentRuns).all()).toHaveLength(2);

    const checkpointAudit = db.select().from(usageSafetyAudit).where(eq(usageSafetyAudit.eventType, "CHECKPOINT_TRIGGERED")).all();
    expect(checkpointAudit).toHaveLength(1);
    expect(checkpointAudit[0]).toMatchObject({ provider: "CLAUDE", status: "CHECKPOINT_REQUIRED" });

    // A blind retry without a fresh reading or an override must still refuse the cross-review calls.
    await workflow.resume("task");
    expect(taskStatus(db).status).toBe("CHECKPOINTED");
    expect(claude.runCallsByRole.CROSS_REVIEW).toBe(0);
    expect(db.select().from(agentRuns).all()).toHaveLength(2);

    // An explicit human override tied to the exact reading that triggered the checkpoint clears it.
    const view = usageSafety.getProviderUsage("CLAUDE")[0]!;
    usageSafety.recordAcknowledgement({
      provider: "CLAUDE", status: "CHECKPOINT_REQUIRED", relatedReadingId: view.readingId,
      userAction: "OVERRIDE", reason: "Operator confirmed capacity remains for this session.",
    });

    await workflow.resume("task");

    expect(claude.runCallsByRole.CROSS_REVIEW).toBe(1);
    expect(codex.runCallsByRole.CROSS_REVIEW).toBe(1);
    expect(db.select().from(agentRuns).all()).toHaveLength(4);
    // The original two analysis artifacts are untouched by resume; no re-analysis happened.
    expect(db.select().from(taskArtifacts).where(and(eq(taskArtifacts.taskId, "task"), eq(taskArtifacts.kind, "ANALYSIS"))).all()).toHaveLength(2);
    expect(db.select().from(taskComparisons).where(eq(taskComparisons.taskId, "task")).get()).toBeTruthy();
    expect(taskStatus(db).status).toBe("READY");
  });
});
