import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type ValidationCommand = {
  id: string;
  label: string;
  command: string;
};

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repositoryPath: text("repository_path").notNull().unique(),
  defaultBranch: text("default_branch").notNull(),
  currentBranch: text("current_branch").notNull(),
  worktreeRoot: text("worktree_root").notNull(),
  projectContext: text("project_context"),
  validationCommands: text("validation_commands", { mode: "json" })
    .$type<ValidationCommand[]>()
    .notNull(),
  gitStatus: text("git_status", { enum: ["CLEAN", "DIRTY"] }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type ProjectRecord = typeof projects.$inferSelect;

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  prompt: text("prompt").notNull(),
  promptVersion: text("prompt_version").notNull(),
  requestedModel: text("requested_model").notNull(),
  actualModel: text("actual_model"),
  effort: text("effort"),
  permissionProfile: text("permission_profile", { enum: ["READ_ONLY"] }).notNull(),
  webAccessPolicy: text("web_access_policy", { enum: ["DISABLED"] }).notNull(),
  webAccessPermitted: integer("web_access_permitted", { mode: "boolean" }).notNull(),
  status: text("status", { enum: ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] }).notNull(),
  output: text("output").notNull(),
  rawOutput: text("raw_output").notNull(),
  errorOutput: text("error_output").notNull(),
  errorMessage: text("error_message"),
  exitCode: integer("exit_code"),
  cliVersion: text("cli_version"),
  durationMs: integer("duration_ms"),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("agent_runs_project_created_idx").on(table.projectId, table.createdAt)]);

export type AgentRunRecord = typeof agentRuns.$inferSelect;

export const agentRunEvents = sqliteTable("agent_run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  occurredAt: text("occurred_at").notNull(),
}, (table) => [index("agent_run_events_run_sequence_idx").on(table.runId, table.sequence)]);

export type AgentRunEventRecord = typeof agentRunEvents.$inferSelect;
