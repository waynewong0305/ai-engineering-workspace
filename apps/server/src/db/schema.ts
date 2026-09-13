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

export type TaskType = "BRAINSTORM" | "ARCHITECTURE";
export type TaskStatus = "DRAFT" | "ANALYZING" | "CROSS_REVIEW" | "READY" | "FAILED" | "CANCELLED";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  problemStatement: text("problem_statement").notNull(),
  type: text("type", { enum: ["BRAINSTORM", "ARCHITECTURE"] }).notNull(),
  status: text("status", { enum: ["DRAFT", "ANALYZING", "CROSS_REVIEW", "READY", "FAILED", "CANCELLED"] }).notNull(),
  riskLevel: text("risk_level", { enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] }).notNull(),
  webAccessPolicy: text("web_access_policy", { enum: ["DISABLED", "ENABLED_FOR_TASK"] }).notNull(),
  webAccessPermitted: integer("web_access_permitted", { mode: "boolean" }).notNull(),
  webAccessDecidedAt: text("web_access_decided_at").notNull(),
  webAccessDecidedBy: text("web_access_decided_by", { enum: ["USER"] }).notNull(),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("tasks_project_created_idx").on(table.projectId, table.createdAt)]);

export type TaskRecord = typeof tasks.$inferSelect;

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  role: text("role", { enum: ["REPOSITORY_EXPLANATION", "INDEPENDENT_ANALYSIS", "CROSS_REVIEW"] }).notNull().default("REPOSITORY_EXPLANATION"),
  targetProvider: text("target_provider", { enum: ["CLAUDE", "CODEX"] }),
  prompt: text("prompt").notNull(),
  promptVersion: text("prompt_version").notNull(),
  requestedModel: text("requested_model").notNull(),
  actualModel: text("actual_model"),
  effort: text("effort"),
  permissionProfile: text("permission_profile", { enum: ["READ_ONLY"] }).notNull(),
  webAccessPolicy: text("web_access_policy", { enum: ["DISABLED", "ENABLED_FOR_TASK"] }).notNull(),
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
}, (table) => [
  index("agent_runs_project_created_idx").on(table.projectId, table.createdAt),
  index("agent_runs_task_created_idx").on(table.taskId, table.createdAt),
]);

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

export type BrainstormAnalysis = {
  summary: string;
  facts: string[];
  assumptions: string[];
  unknowns: string[];
  options: Array<{
    name: string;
    description: string;
    advantages: string[];
    disadvantages: string[];
    risks: string[];
  }>;
  recommendedExperiments: string[];
  recommendation: string | null;
};

export type CrossReview = {
  summary: string;
  agreements: string[];
  disagreements: string[];
  factualErrors: string[];
  unsupportedAssumptions: string[];
  missingFailureCases: string[];
  hiddenOperationalCosts: string[];
  migrationRisks: string[];
  openQuestions: string[];
  missingEvidence: string[];
  recommendedExperiments: string[];
};

export const taskArtifacts = sqliteTable("task_artifacts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["ANALYSIS", "CROSS_REVIEW"] }).notNull(),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  targetProvider: text("target_provider", { enum: ["CLAUDE", "CODEX"] }),
  structuredData: text("structured_data", { mode: "json" }).$type<BrainstormAnalysis | CrossReview>(),
  rawOutput: text("raw_output").notNull(),
  parseError: text("parse_error"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("task_artifacts_task_kind_idx").on(table.taskId, table.kind)]);

export type TaskArtifactRecord = typeof taskArtifacts.$inferSelect;

export type TaskComparison = {
  consensus: string[];
  disagreements: string[];
  openQuestions: string[];
  missingEvidence: string[];
  recommendedExperiments: string[];
};

export const taskComparisons = sqliteTable("task_comparisons", {
  taskId: text("task_id").primaryKey().references(() => tasks.id, { onDelete: "cascade" }),
  content: text("content", { mode: "json" }).$type<TaskComparison>().notNull(),
  generatedAt: text("generated_at").notNull(),
});

export type EvidenceType = "FACT" | "ASSUMPTION" | "QUESTION" | "DECISION" | "EXPERIMENT_RESULT";

export const evidenceItems = sqliteTable("evidence_items", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["FACT", "ASSUMPTION", "QUESTION", "DECISION", "EXPERIMENT_RESULT"] }).notNull(),
  content: text("content").notNull(),
  sourceProvider: text("source_provider", { enum: ["CLAUDE", "CODEX"] }),
  sourceArtifactId: text("source_artifact_id").references(() => taskArtifacts.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("evidence_items_task_type_idx").on(table.taskId, table.type)]);

export type EvidenceItemRecord = typeof evidenceItems.$inferSelect;
