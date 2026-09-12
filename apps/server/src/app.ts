import Fastify from "fastify";
import { ClaudeAdapter, CodexAdapter, type AgentAdapter, type AgentProvider } from "@aiew/agents";
import { createDatabase } from "./db/database.js";
import { registerAgentRunRoutes } from "./routes/agent-runs.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { inspectLocalTools } from "./services/tool-health.js";

export function buildApp(options: { databasePath?: string; adapters?: AgentAdapter[] } = {}) {
  const app = Fastify({ logger: true });
  const { db, sqlite } = createDatabase(options.databasePath);

  app.addHook("onClose", async () => sqlite.close());

  app.get("/api/health", async () => {
    const databaseCheck = sqlite.prepare("select 1 as ok").get() as { ok: number };
    return {
      status: "ok" as const,
      database: databaseCheck.ok === 1 ? ("connected" as const) : ("unavailable" as const),
      tools: await inspectLocalTools(),
    };
  });

  registerProjectRoutes(app, db);
  const adapters = new Map<AgentProvider, AgentAdapter>(
    (options.adapters ?? [new ClaudeAdapter(), new CodexAdapter()]).map((adapter) => [adapter.name, adapter]),
  );
  registerAgentRunRoutes(app, db, adapters);

  return app;
}
