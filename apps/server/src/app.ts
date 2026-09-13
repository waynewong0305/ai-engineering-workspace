import Fastify from "fastify";
import { ClaudeAdapter, CodexAdapter, type AgentAdapter, type AgentProvider } from "@aiew/agents";
import { WorktreeService } from "@aiew/git";
import { createDatabase, defaultDatabasePath } from "./db/database.js";
import { registerAdrRoutes } from "./routes/adrs.js";
import { registerAgentRunRoutes } from "./routes/agent-runs.js";
import { registerBuildRoutes } from "./routes/build-runs.js";
import { registerExperimentRoutes } from "./routes/experiments.js";
import { registerFrontendReviewApprovalRoutes } from "./routes/frontend-review-approvals.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerTaskRoutes } from "./routes/tasks.js";
import { registerUsageSafetyRoutes } from "./routes/usage-safety.js";
import { registerWorktreeRoutes } from "./routes/worktrees.js";
import { AgentRunManager } from "./services/agent-run-manager.js";
import { inspectLocalTools } from "./services/tool-health.js";
import { UsageSafetyService } from "./services/usage-safety.js";
import { WorktreeUsageManager } from "./services/worktree-usage-manager.js";
import { recoverInterruptedState } from "./services/startup-recovery.js";

export function buildApp(options: { databasePath?: string; adapters?: AgentAdapter[] } = {}) {
  const app = Fastify({ logger: true });
  const databasePath = options.databasePath ?? defaultDatabasePath;
  const { db, sqlite, appliedRestore } = createDatabase(databasePath);
  const startupRecovery = recoverInterruptedState(db);

  app.addHook("onClose", async () => sqlite.close());

  app.get("/api/health", async () => {
    const databaseCheck = sqlite.prepare("select 1 as ok").get() as { ok: number };
    return {
      status: "ok" as const,
      database: databaseCheck.ok === 1 ? ("connected" as const) : ("unavailable" as const),
      tools: await inspectLocalTools(),
      maintenance: { appliedRestore, startupRecovery },
    };
  });

  registerProjectRoutes(app, db);
  const adapters = new Map<AgentProvider, AgentAdapter>(
    (options.adapters ?? [new ClaudeAdapter(), new CodexAdapter()]).map((adapter) => [adapter.name, adapter]),
  );
  const usageSafety = new UsageSafetyService(db);
  const runManager = new AgentRunManager(db, usageSafety);
  const worktreeService = new WorktreeService();
  const worktreeUsageManager = new WorktreeUsageManager(db);
  registerAgentRunRoutes(app, db, adapters, runManager, usageSafety);
  registerTaskRoutes(app, db, adapters, runManager, usageSafety);
  registerWorktreeRoutes(app, db, worktreeService, worktreeUsageManager);
  registerBuildRoutes(app, db, adapters, runManager, usageSafety, worktreeService, worktreeUsageManager);
  registerUsageSafetyRoutes(app, usageSafety);
  registerAdrRoutes(app, db);
  registerExperimentRoutes(app, db, adapters, runManager, usageSafety, worktreeService, worktreeUsageManager);
  registerMaintenanceRoutes(app, db, sqlite, databasePath);
  registerFrontendReviewApprovalRoutes(app, db);

  return app;
}
