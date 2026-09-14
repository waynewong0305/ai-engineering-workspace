import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export type TaskType = "BRAINSTORM" | "ARCHITECTURE" | "IMPLEMENTATION";
export type TaskStatus = "DRAFT" | "ANALYZING" | "CROSS_REVIEW" | "READY" | "FAILED" | "CANCELLED" | "CHECKPOINTED";
export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  problemStatement: text("problem_statement").notNull(),
  type: text("type", { enum: ["BRAINSTORM", "ARCHITECTURE", "IMPLEMENTATION"] }).notNull(),
  status: text("status", { enum: ["DRAFT", "ANALYZING", "CROSS_REVIEW", "READY", "FAILED", "CANCELLED", "CHECKPOINTED"] }).notNull(),
  riskLevel: text("risk_level", { enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] }).notNull(),
  webAccessPolicy: text("web_access_policy", { enum: ["DISABLED", "ENABLED_FOR_TASK"] }).notNull(),
  webAccessPermitted: integer("web_access_permitted", { mode: "boolean" }).notNull(),
  webAccessDecidedAt: text("web_access_decided_at").notNull(),
  webAccessDecidedBy: text("web_access_decided_by", { enum: ["USER"] }).notNull(),
  // PROJECT_SPEC.md §20: a task promoted from an ADR keeps a link back to it (never inferred after
  // the fact) — the ADR itself already carries the originating architecture task in `taskId` and
  // any related experiments in `relatedTaskIds`, so this one link is enough to walk the whole
  // chain. Not a `.references()` FK: `adrs` is defined later in this file and itself references
  // `tasks`, and TypeScript cannot resolve that mutual cycle through Drizzle's lazy `() => table`
  // reference thunks (a real compiler limitation, not a stylistic choice) — so, like
  // `relatedTaskIds` on the other side, this is a loose, human/system-set id, not FK-enforced.
  // planPhase is a free-text grouping label (e.g. "Phase 1 — Shard Registry") set at promotion
  // time, not a separate relational "plan" entity — a deliberate scope reduction.
  originAdrId: text("origin_adr_id"),
  planPhase: text("plan_phase"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("tasks_project_created_idx").on(table.projectId, table.createdAt)]);

export type TaskRecord = typeof tasks.$inferSelect;

export const worktrees = sqliteTable("worktrees", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  path: text("path").notNull().unique(),
  branchName: text("branch_name").notNull(),
  baseRef: text("base_ref").notNull(),
  status: text("status", { enum: ["CREATING", "ACTIVE", "ERROR"] }).notNull(),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("worktrees_task_provider_idx").on(table.taskId, table.provider),
  uniqueIndex("worktrees_project_branch_idx").on(table.projectId, table.branchName),
]);

export type WorktreeRecord = typeof worktrees.$inferSelect;

export const worktreeUsages = sqliteTable("worktree_usages", {
  id: text("id").primaryKey(),
  worktreeId: text("worktree_id").notNull().references(() => worktrees.id, { onDelete: "cascade" }),
  ownerType: text("owner_type", { enum: ["AGENT_RUN", "VALIDATION", "SYSTEM"] }).notNull(),
  ownerId: text("owner_id").notNull(),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"),
}, (table) => [index("worktree_usages_active_idx").on(table.worktreeId, table.endedAt)]);

export type WorktreeUsageRecord = typeof worktreeUsages.$inferSelect;

export const agentRuns = sqliteTable("agent_runs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  worktreeId: text("worktree_id").references(() => worktrees.id, { onDelete: "set null" }),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  role: text("role", { enum: ["REPOSITORY_EXPLANATION", "INDEPENDENT_ANALYSIS", "CROSS_REVIEW", "BUILD", "REVIEW"] }).notNull().default("REPOSITORY_EXPLANATION"),
  targetProvider: text("target_provider", { enum: ["CLAUDE", "CODEX"] }),
  prompt: text("prompt").notNull(),
  promptVersion: text("prompt_version").notNull(),
  requestedModel: text("requested_model").notNull(),
  actualModel: text("actual_model"),
  effort: text("effort"),
  permissionProfile: text("permission_profile", { enum: ["READ_ONLY", "WORKTREE_WRITE"] }).notNull(),
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

export const pricingEntries = sqliteTable("pricing_entries", {
  id: text("id").primaryKey(),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  model: text("model").notNull(),
  inputPricePerMillion: real("input_price_per_million").notNull(),
  cachedInputPricePerMillion: real("cached_input_price_per_million"),
  cacheCreationInputPricePerMillion: real("cache_creation_input_price_per_million"),
  outputPricePerMillion: real("output_price_per_million").notNull(),
  reasoningPricePerMillion: real("reasoning_price_per_million"),
  effectiveFrom: text("effective_from").notNull(),
  source: text("source").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("pricing_entries_provider_model_effective_idx").on(table.provider, table.model, table.effectiveFrom),
  index("pricing_entries_lookup_idx").on(table.provider, table.model, table.effectiveFrom),
]);

export type PricingEntryRecord = typeof pricingEntries.$inferSelect;

export type UsageCostCategory = {
  category: "INPUT" | "CACHED_INPUT" | "CACHE_CREATION_INPUT" | "OUTPUT" | "REASONING_OUTPUT";
  tokens: number;
  pricePerMillion: number;
  subtotalUsd: number;
};

export type UsageCostBreakdown = {
  model: string;
  pricingEntryId: string;
  pricingEffectiveFrom: string;
  pricingSource: string;
  categories: UsageCostCategory[];
  totalUsd: number;
};

/**
 * Phase 8: one row per agent run, always — even when nothing was recoverable (`usageSource:
 * "unavailable"`, every token field `null`), so "exactly one usage record per run" is an invariant
 * later aggregation can rely on rather than "sometimes there's one." `role` reuses
 * `agentRuns.role`'s own enum instead of the spec's example vocabulary — this app's actual workflow
 * roles already serve as workflowType, so there's no separate field for it.
 */
export const usageRecords = sqliteTable("usage_records", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  taskId: text("task_id"),
  projectId: text("project_id").notNull(),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  role: text("role", { enum: ["REPOSITORY_EXPLANATION", "INDEPENDENT_ANALYSIS", "CROSS_REVIEW", "BUILD", "REVIEW"] }).notNull(),
  modelRequested: text("model_requested"),
  modelActual: text("model_actual"),
  inputTokens: integer("input_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  cacheCreationTokens: integer("cache_creation_tokens"),
  outputTokens: integer("output_tokens"),
  reasoningOutputTokens: integer("reasoning_output_tokens"),
  totalTokens: integer("total_tokens"),
  actualCostUsd: real("actual_cost_usd"),
  apiEquivalentCostUsd: real("api_equivalent_cost_usd"),
  pricingEntryId: text("pricing_entry_id").references(() => pricingEntries.id),
  costSource: text("cost_source", { enum: ["calculated", "unavailable"] }).notNull().default("unavailable"),
  costBreakdown: text("cost_breakdown", { mode: "json" }).$type<UsageCostBreakdown | null>(),
  costCalculatedAt: text("cost_calculated_at"),
  billingMode: text("billing_mode", { enum: ["subscription", "api", "credits", "unknown"] }).notNull().default("unknown"),
  usageSource: text("usage_source", { enum: ["provider_reported", "unavailable"] }).notNull(),
  rawUsageMetadata: text("raw_usage_metadata", { mode: "json" }).$type<Record<string, unknown> | null>(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("usage_records_run_idx").on(table.runId),
  index("usage_records_project_created_idx").on(table.projectId, table.createdAt),
  index("usage_records_task_created_idx").on(table.taskId, table.createdAt),
]);

export type UsageRecordRecord = typeof usageRecords.$inferSelect;

export type UsageBudgetPreset = "NONE" | "ECONOMY" | "BALANCED" | "DEEP" | "CUSTOM";
export type UsageBudgetState = "ACTIVE" | "CHECKPOINTED" | "STOPPED";
export type UsageBudgetPresetLimits = {
  maxAgentRuns: number;
  maxReviewRounds: number;
  warningPercent: number;
};
export type UsageBudgetPresets = Record<"ECONOMY" | "BALANCED" | "DEEP", UsageBudgetPresetLimits>;

/** Local display/capture preferences plus the configurable task-budget preset definitions. */
export const usageCostSettings = sqliteTable("usage_cost_settings", {
  id: text("id").primaryKey(),
  trackUsage: integer("track_usage", { mode: "boolean" }).notNull(),
  showApiEquivalentCost: integer("show_api_equivalent_cost", { mode: "boolean" }).notNull(),
  storeRawTelemetry: integer("store_raw_telemetry", { mode: "boolean" }).notNull(),
  defaultBudgetPreset: text("default_budget_preset", { enum: ["NONE", "ECONOMY", "BALANCED", "DEEP", "CUSTOM"] }).notNull(),
  budgetPresets: text("budget_presets", { mode: "json" }).$type<UsageBudgetPresets>().notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type UsageCostSettingsRecord = typeof usageCostSettings.$inferSelect;

/** A task receives a resolved budget snapshot so later preset edits never rewrite history. */
export const taskUsageBudgets = sqliteTable("task_usage_budgets", {
  taskId: text("task_id").primaryKey().references(() => tasks.id, { onDelete: "cascade" }),
  preset: text("preset", { enum: ["NONE", "ECONOMY", "BALANCED", "DEEP", "CUSTOM"] }).notNull(),
  state: text("state", { enum: ["ACTIVE", "CHECKPOINTED", "STOPPED"] }).notNull(),
  maxTokens: integer("max_tokens"),
  apiEquivalentCostWarningUsd: real("api_equivalent_cost_warning_usd"),
  maxAgentRuns: integer("max_agent_runs"),
  maxReviewRounds: integer("max_review_rounds"),
  warningPercent: real("warning_percent").notNull(),
  continueRunsRemaining: integer("continue_runs_remaining").notNull().default(0),
  checkpointReason: text("checkpoint_reason"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type TaskUsageBudgetRecord = typeof taskUsageBudgets.$inferSelect;

export const usageBudgetAudit = sqliteTable("usage_budget_audit", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  eventType: text("event_type", { enum: ["CHECKPOINT_TRIGGERED", "ACKNOWLEDGEMENT", "BUDGET_UPDATED"] }).notNull(),
  userAction: text("user_action", { enum: ["STOP_AND_SUMMARIZE", "CONTINUE_ONE_RUN", "INCREASE_BUDGET"] }),
  reason: text("reason").notNull(),
  budgetSnapshot: text("budget_snapshot", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("usage_budget_audit_task_created_idx").on(table.taskId, table.createdAt)]);

export type UsageBudgetAuditRecord = typeof usageBudgetAudit.$inferSelect;

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

export type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
export type FindingCategory =
  | "CORRECTNESS"
  | "RACE_CONDITION"
  | "SECURITY"
  | "DATA_INTEGRITY"
  | "PERFORMANCE"
  | "TESTING"
  | "MAINTAINABILITY"
  | "MIGRATION"
  | "COMPATIBILITY";
export type FindingConfidence = "LOW" | "MEDIUM" | "HIGH";
export type FindingStatus = "OPEN" | "RESPONDED" | "RESOLVED";
export type FindingVerdict = "ACCEPTED" | "REJECTED" | "PARTIALLY_ACCEPTED";

export type ParsedFinding = {
  severity: FindingSeverity;
  category: FindingCategory;
  file: string | null;
  startLine: number | null;
  endLine: number | null;
  title: string;
  description: string;
  evidence: string;
  impact: string;
  suggestedFix: string | null;
  suggestedTest: string | null;
  confidence: FindingConfidence;
};

export type ReviewFindingsArtifact = { findings: ParsedFinding[] };

/** A builder's per-finding reply to a round of review findings; see BuildReviewWorkflow.respondToFindings. */
export type FindingResponseArtifact = {
  responses: { ordinal: number; verdict: FindingVerdict; evidence: string; action: string }[];
};

/** A reviewer's recheck of a prior round's findings, plus any new findings from the fresh diff. */
export type ReviewRecheckArtifact = {
  recheckedFindings: { ordinal: number; resolved: boolean; note: string }[];
  newFindings: ParsedFinding[];
};

export type ExperimentVerdict = "PROVEN" | "DISPROVEN" | "INCONCLUSIVE";

/** An experiment reviewer's structured assessment of whether the POC actually supports its hypothesis. */
export type ExperimentVerdictArtifact = {
  verdict: ExperimentVerdict;
  reasoning: string;
  result: string;
  conclusion: string;
};

export const taskArtifacts = sqliteTable("task_artifacts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  runId: text("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["ANALYSIS", "CROSS_REVIEW", "REVIEW_FINDINGS", "FINDING_RESPONSE", "REVIEW_RECHECK", "EXPERIMENT_RESULT"] }).notNull(),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  targetProvider: text("target_provider", { enum: ["CLAUDE", "CODEX"] }),
  structuredData: text("structured_data", { mode: "json" })
    .$type<BrainstormAnalysis | CrossReview | ReviewFindingsArtifact | FindingResponseArtifact | ReviewRecheckArtifact | ExperimentVerdictArtifact>(),
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

export type QuestionStatus = "OPEN" | "ANSWERED" | "DEFERRED" | "NOT_APPLICABLE" | "DUPLICATE";
export type QuestionSuggestionSource = "CLAUDE" | "CODEX" | "HUMAN";
export type QuestionResponseSource = "HUMAN" | "EXPERIMENT" | "PROVIDER";

/**
 * One row per QUESTION-typed evidence item (1:1 via `questionId`, never a separate id) — the
 * evidence item's own `content` stays the immutable original question text; everything about
 * resolving it lives here instead, so the original is never overwritten. `taskId` is denormalized
 * (matches `evidenceItems`' own precedent) so the open-count and list queries never need a join
 * through `evidenceItems` just to filter by task. A missing row for a QUESTION evidence item should
 * not happen (see `ensureQuestionDetails`), but callers treat that case as `OPEN` rather than
 * dropping the question from any count.
 */
export const questionDetails = sqliteTable("question_details", {
  questionId: text("question_id").primaryKey().references(() => evidenceItems.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["OPEN", "ANSWERED", "DEFERRED", "NOT_APPLICABLE", "DUPLICATE"] }).notNull().default("OPEN"),
  whyItMatters: text("why_it_matters"),
  suggestedAction: text("suggested_action"),
  expectedEvidence: text("expected_evidence", { mode: "json" }).$type<string[] | null>(),
  // Multiple-choice candidate answers a provider proposed for this question (never invented by a
  // migration — only ever populated by a real analysis/cross-review or suggestion-generation run).
  // The answer UI offers these as pickable options alongside a free-text "write your own" box; the
  // human's final choice or edit is still recorded as a normal question_responses row either way.
  suggestedAnswers: text("suggested_answers", { mode: "json" }).$type<string[] | null>(),
  suggestionSource: text("suggestion_source", { enum: ["CLAUDE", "CODEX", "HUMAN"] }),
  // Set together with status "DUPLICATE"; always points at a canonical (non-duplicate) question in
  // the same task — see the confirm-duplicate route's validation in routes/questions.ts.
  duplicateOfQuestionId: text("duplicate_of_question_id").references(() => evidenceItems.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("question_details_task_status_idx").on(table.taskId, table.status)]);

export type QuestionDetailRecord = typeof questionDetails.$inferSelect;

/**
 * Append-only: editing an answer inserts another row rather than overwriting a prior one, so the
 * full resolution history survives (see routes/questions.ts). No `updatedAt` — a response is never
 * mutated once written.
 */
export const questionResponses = sqliteTable("question_responses", {
  id: text("id").primaryKey(),
  questionId: text("question_id").notNull().references(() => evidenceItems.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  answer: text("answer").notNull(),
  resultingStatus: text("resulting_status", { enum: ["OPEN", "ANSWERED", "DEFERRED", "NOT_APPLICABLE", "DUPLICATE"] }).notNull(),
  linkedEvidenceItemId: text("linked_evidence_item_id").references(() => evidenceItems.id, { onDelete: "set null" }),
  linkedExperimentId: text("linked_experiment_id").references(() => experiments.id, { onDelete: "set null" }),
  source: text("source", { enum: ["HUMAN", "EXPERIMENT", "PROVIDER"] }).notNull().default("HUMAN"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("question_responses_question_created_idx").on(table.questionId, table.createdAt)]);

export type QuestionResponseRecord = typeof questionResponses.$inferSelect;

export type AdrStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";

/**
 * PROJECT_SPEC.md §18. Numbered sequentially per project (ADR-0001, ADR-0002, ...), not per task —
 * an ADR log reads as one running history for the repository it's about, the same way a real
 * ADR directory would. `relatedTaskIds` is a loose, human-curated list of task IDs (not FK-enforced
 * — a task can be deregistered/deleted independently of an ADR that once referenced it, and this is
 * a documentation link, not a data-integrity constraint) until Phase 6's plan-promotion work gives
 * it a first-class relationship table.
 */
export const adrs = sqliteTable("adrs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  number: integer("number").notNull(),
  title: text("title").notNull(),
  context: text("context").notNull(),
  optionsConsidered: text("options_considered").notNull(),
  decision: text("decision").notNull(),
  reasons: text("reasons").notNull(),
  consequences: text("consequences").notNull(),
  risks: text("risks"),
  rejectedAlternatives: text("rejected_alternatives"),
  requiredFollowUp: text("required_follow_up"),
  relatedTaskIds: text("related_task_ids", { mode: "json" }).$type<string[]>().notNull().default([]),
  status: text("status", { enum: ["PROPOSED", "ACCEPTED", "REJECTED", "SUPERSEDED"] }).notNull().default("PROPOSED"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("adrs_project_number_idx").on(table.projectId, table.number),
  index("adrs_task_idx").on(table.taskId),
]);

export type AdrRecord = typeof adrs.$inferSelect;

/**
 * PROJECT_SPEC.md §24.1. A separate, explicit gate from build/review or usage-safety approval: no
 * model-backed agent of any current or future provider may inspect the rendered frontend or receive
 * screenshots/DOM/accessibility/browser evidence without one of these being requested, approved by
 * a human, and then consumed by exactly the disclosed run it was approved for. Each row is both the
 * request and its own audit trail — reason, scope, provider, agent configuration, decision, and
 * timestamps are recorded here rather than in a separate audit table.
 */
export const frontendReviewApprovals = sqliteTable("frontend_review_approvals", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  agentConfiguration: text("agent_configuration").notNull(),
  reason: text("reason").notNull(),
  scope: text("scope").notNull(),
  triggerDescription: text("trigger_description"),
  status: text("status", { enum: ["PENDING", "APPROVED", "REFUSED", "CONSUMED"] }).notNull().default("PENDING"),
  decidedAt: text("decided_at"),
  consumedAt: text("consumed_at"),
  consumedByRunId: text("consumed_by_run_id"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("frontend_review_approvals_task_idx").on(table.taskId, table.createdAt)]);

export type FrontendReviewApprovalRecord = typeof frontendReviewApprovals.$inferSelect;
export type FrontendReviewApprovalStatus = FrontendReviewApprovalRecord["status"];

export type ExperimentStatus = "RUNNING" | "REVIEWING" | "COMPLETED" | "FAILED" | "CANCELLED" | "CHECKPOINTED";

/**
 * PROJECT_SPEC.md §19. Deliberately reuses the same worktree slot an ordinary Phase 5 build would
 * use for (taskId, builderProvider) — see WorktreeService/ensureWorktreeForTask — rather than a
 * separate experiment-specific worktree-naming scheme; an architecture task running an experiment
 * for a provider and a full Phase 5 build for that same provider at the same time would collide on
 * that slot, a known, documented limitation rather than an oversight (see the completion record).
 * No validation-command integration and no merge: a POC is meant to inform a decision via its
 * resulting evidence-board item, not to land in the target branch.
 */
export const experiments = sqliteTable("experiments", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  hypothesis: text("hypothesis").notNull(),
  builderProvider: text("builder_provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  reviewerProvider: text("reviewer_provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  worktreeId: text("worktree_id").references(() => worktrees.id, { onDelete: "set null" }),
  builderRunId: text("builder_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  reviewerRunId: text("reviewer_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  status: text("status", { enum: ["RUNNING", "REVIEWING", "COMPLETED", "FAILED", "CANCELLED", "CHECKPOINTED"] }).notNull(),
  diffUnstaged: text("diff_unstaged"),
  diffStaged: text("diff_staged"),
  testExecuted: text("test_executed"),
  result: text("result"),
  conclusion: text("conclusion"),
  verdict: text("verdict", { enum: ["PROVEN", "DISPROVEN", "INCONCLUSIVE"] }),
  evidenceItemId: text("evidence_item_id").references(() => evidenceItems.id, { onDelete: "set null" }),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("experiments_task_created_idx").on(table.taskId, table.createdAt)]);

export type ExperimentRecord = typeof experiments.$inferSelect;

export type UsageProvider = "CLAUDE" | "CODEX";
export type UsageSource = "CLI_REPORTED" | "APP_SERVER" | "MANUAL" | "RATE_LIMIT_ERROR";
export type UsageSourceConfidence = "EXACT" | "ESTIMATED";

/**
 * A single point-in-time reading of a provider's usage against one rate/allowance window (for
 * example Claude's rolling 5-hour window, or a weekly plan allowance). History is retained so the
 * latest reading per (provider, windowId) can be distinguished from a stale one, and so an
 * acknowledgement/override can be tied to the exact reading a human accepted.
 */
export const providerUsageReadings = sqliteTable("provider_usage_readings", {
  id: text("id").primaryKey(),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  windowId: text("window_id").notNull(),
  windowLabel: text("window_label").notNull(),
  windowDurationMs: integer("window_duration_ms"),
  usedPercent: real("used_percent").notNull(),
  resetAt: text("reset_at"),
  source: text("source", { enum: ["CLI_REPORTED", "APP_SERVER", "MANUAL", "RATE_LIMIT_ERROR"] }).notNull(),
  sourceConfidence: text("source_confidence", { enum: ["EXACT", "ESTIMATED"] }).notNull(),
  recordedAt: text("recorded_at").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("provider_usage_readings_provider_window_idx").on(table.provider, table.windowId, table.createdAt)]);

export type ProviderUsageReadingRecord = typeof providerUsageReadings.$inferSelect;

/** A single configurable policy row (id is always "default"). */
export const usageSafetySettings = sqliteTable("usage_safety_settings", {
  id: text("id").primaryKey(),
  warningThresholdPercent: real("warning_threshold_percent").notNull(),
  checkpointThresholdPercent: real("checkpoint_threshold_percent").notNull(),
  staleAfterMs: integer("stale_after_ms").notNull(),
  acknowledgementTtlMs: integer("acknowledgement_ttl_ms").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type UsageSafetySettingsRecord = typeof usageSafetySettings.$inferSelect;

export type UsageStatus = "SAFE" | "WARNING" | "CHECKPOINT_REQUIRED" | "EXHAUSTED" | "UNAVAILABLE" | "STALE";
export type UsageSafetyEventType = "CHECKPOINT_TRIGGERED" | "ACKNOWLEDGEMENT" | "OVERRIDE_DENIED";
export type UsageSafetyUserAction = "PROCEED" | "OVERRIDE" | "PAUSE";

/** Append-only audit trail: every checkpoint pause, acknowledgement, and refused override. */
export const usageSafetyAudit = sqliteTable("usage_safety_audit", {
  id: text("id").primaryKey(),
  provider: text("provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  windowId: text("window_id"),
  eventType: text("event_type", { enum: ["CHECKPOINT_TRIGGERED", "ACKNOWLEDGEMENT", "OVERRIDE_DENIED"] }).notNull(),
  status: text("status", { enum: ["SAFE", "WARNING", "CHECKPOINT_REQUIRED", "EXHAUSTED", "UNAVAILABLE", "STALE"] }).notNull(),
  relatedReadingId: text("related_reading_id").references(() => providerUsageReadings.id, { onDelete: "set null" }),
  userAction: text("user_action", { enum: ["PROCEED", "OVERRIDE", "PAUSE"] }),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("usage_safety_audit_provider_created_idx").on(table.provider, table.createdAt)]);

export type UsageSafetyAuditRecord = typeof usageSafetyAudit.$inferSelect;

export type BuildRunStatus =
  | "BUILDING"
  | "VALIDATING"
  | "REVIEWING"
  | "RESPONDING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "CHECKPOINTED";

export type BuildMergeStatus = "NOT_MERGED" | "MERGING" | "MERGED" | "MERGE_CONFLICT" | "MERGE_FAILED";

/**
 * One build/review attempt for a task. Deliberately its own status column rather than folded into
 * tasks.status: BrainstormWorkflow and BuildReviewWorkflow would otherwise collide on the same
 * CHECKPOINTED/FAILED values with no way to tell whose checkpoint it is.
 */
export const buildRuns = sqliteTable("build_runs", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  builderProvider: text("builder_provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  reviewerProvider: text("reviewer_provider", { enum: ["CLAUDE", "CODEX"] }).notNull(),
  worktreeId: text("worktree_id").references(() => worktrees.id, { onDelete: "set null" }),
  builderRunId: text("builder_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  reviewerRunId: text("reviewer_run_id").references(() => agentRuns.id, { onDelete: "set null" }),
  status: text("status", { enum: ["BUILDING", "VALIDATING", "REVIEWING", "RESPONDING", "COMPLETED", "FAILED", "CANCELLED", "CHECKPOINTED"] }).notNull(),
  // Captured once, right after validation, so the UI always shows exactly what the reviewer saw
  // rather than a live re-diff that could drift if the worktree is touched afterward. A re-review
  // round (see respondToFindings) intentionally overwrites this with the new snapshot; the diff
  // history of earlier rounds is not separately retained — a known limitation, not an oversight.
  diffUnstaged: text("diff_unstaged"),
  diffStaged: text("diff_staged"),
  // Round 1 is the initial build+review. respondToFindings increments this before starting the
  // next round. maxReviewRounds is set once at build-start time (default 3, see PROJECT_SPEC.md
  // §23) rather than hardcoded, so a human can raise or lower it per build without a code change.
  reviewRound: integer("review_round").notNull().default(1),
  maxReviewRounds: integer("max_review_rounds").notNull().default(3),
  // Merge is a separate, later, explicitly human-approved action (PROJECT_SPEC.md §12/§21) — these
  // stay NOT_MERGED/null until BuildReviewWorkflow.mergeBuild runs, regardless of review outcome.
  mergeStatus: text("merge_status", { enum: ["NOT_MERGED", "MERGING", "MERGED", "MERGE_CONFLICT", "MERGE_FAILED"] }).notNull().default("NOT_MERGED"),
  mergeTargetBranch: text("merge_target_branch"),
  mergeCommitSha: text("merge_commit_sha"),
  mergedAt: text("merged_at"),
  mergeError: text("merge_error"),
  // Landing a merge moves the target branch's ref with update-ref, never by checking anything out
  // (see WorktreeService.finalizeMerge). If that branch happened to already be checked out
  // somewhere (commonly the developer's primary checkout), that checkout's index/working tree is
  // now stale relative to the branch it's on — not corrupted, just needing a refresh — and this
  // records exactly where so the UI can say so instead of the human discovering a mystery `git
  // status` output later.
  mergeTargetCheckedOutAt: text("merge_target_checked_out_at"),
  // Recorded even when automatic, so the detail pane can always say what happened and why — never
  // inferred after the fact from whether the worktree/branch still happens to exist.
  worktreeRemovedAfterMerge: integer("worktree_removed_after_merge", { mode: "boolean" }),
  branchDeletedAfterMerge: integer("branch_deleted_after_merge", { mode: "boolean" }),
  worktreeCleanupSkippedReason: text("worktree_cleanup_skipped_reason"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("build_runs_task_created_idx").on(table.taskId, table.createdAt)]);

export type BuildRunRecord = typeof buildRuns.$inferSelect;

export type ValidationRunStatus = "PASSED" | "FAILED" | "ERROR";
export type ValidationRunPhase = "BUILD" | "POST_MERGE";

export const validationRuns = sqliteTable("validation_runs", {
  id: text("id").primaryKey(),
  buildRunId: text("build_run_id").notNull().references(() => buildRuns.id, { onDelete: "cascade" }),
  worktreeId: text("worktree_id").references(() => worktrees.id, { onDelete: "set null" }),
  // BUILD: the pre-merge validation already run after every builder/response round. POST_MERGE:
  // re-run inside the temporary merge worktree once merged, before deciding on auto-cleanup.
  phase: text("phase", { enum: ["BUILD", "POST_MERGE"] }).notNull().default("BUILD"),
  commandId: text("command_id").notNull(),
  commandLabel: text("command_label").notNull(),
  command: text("command").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
  exitCode: integer("exit_code"),
  stdout: text("stdout").notNull(),
  stderr: text("stderr").notNull(),
  status: text("status", { enum: ["PASSED", "FAILED", "ERROR"] }).notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("validation_runs_build_created_idx").on(table.buildRunId, table.createdAt)]);

export type ValidationRunRecord = typeof validationRuns.$inferSelect;

/**
 * One row per structured finding a reviewer returned (see ParsedFinding above for the same shape).
 * `id` and `status` are always server-assigned; a model's own id/status in its JSON output is
 * discarded, never trusted. `round` records which review round first raised the finding; the
 * builder* / reviewerRecheckNote columns are populated only once a re-review round processes it
 * (see BuildReviewWorkflow.respondToFindings) and stay null on a finding still awaiting a response.
 */
export const reviewFindings = sqliteTable("review_findings", {
  id: text("id").primaryKey(),
  buildRunId: text("build_run_id").notNull().references(() => buildRuns.id, { onDelete: "cascade" }),
  reviewerRunId: text("reviewer_run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
  round: integer("round").notNull().default(1),
  ordinal: integer("ordinal").notNull(),
  severity: text("severity", { enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] }).notNull(),
  category: text("category", {
    enum: [
      "CORRECTNESS",
      "RACE_CONDITION",
      "SECURITY",
      "DATA_INTEGRITY",
      "PERFORMANCE",
      "TESTING",
      "MAINTAINABILITY",
      "MIGRATION",
      "COMPATIBILITY",
    ],
  }).notNull(),
  file: text("file"),
  startLine: integer("start_line"),
  endLine: integer("end_line"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  evidence: text("evidence").notNull(),
  impact: text("impact").notNull(),
  suggestedFix: text("suggested_fix"),
  suggestedTest: text("suggested_test"),
  confidence: text("confidence", { enum: ["LOW", "MEDIUM", "HIGH"] }).notNull(),
  status: text("status", { enum: ["OPEN", "RESPONDED", "RESOLVED"] }).notNull().default("OPEN"),
  builderVerdict: text("builder_verdict", { enum: ["ACCEPTED", "REJECTED", "PARTIALLY_ACCEPTED"] }),
  builderEvidence: text("builder_evidence"),
  builderAction: text("builder_action"),
  respondedAt: text("responded_at"),
  reviewerRecheckNote: text("reviewer_recheck_note"),
  createdAt: text("created_at").notNull(),
}, (table) => [index("review_findings_build_idx").on(table.buildRunId, table.ordinal)]);

export type ReviewFindingRecord = typeof reviewFindings.$inferSelect;

export type MaintenanceAuditCategory = "RECOVERY" | "BACKUP" | "RESTORE" | "CLEANUP";

/** Append-only operational history for Phase 7 recovery and maintenance actions. */
export const maintenanceAudit = sqliteTable("maintenance_audit", {
  id: text("id").primaryKey(),
  category: text("category", { enum: ["RECOVERY", "BACKUP", "RESTORE", "CLEANUP"] }).notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  detail: text("detail", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("maintenance_audit_created_idx").on(table.createdAt)]);

export type MaintenanceAuditRecord = typeof maintenanceAudit.$inferSelect;
