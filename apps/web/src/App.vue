<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";

type ToolHealth = {
  available: boolean;
  version: string | null;
  authenticated?: boolean | null;
};

type HealthResponse = {
  status: "ok";
  database: "connected" | "unavailable";
  tools: {
    git: ToolHealth;
    claude: ToolHealth;
    codex: ToolHealth;
  };
};

type ValidationCommand = { id: string; label: string; command: string };

type Project = {
  id: string;
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  currentBranch: string;
  worktreeRoot: string;
  projectContext: string | null;
  validationCommands: ValidationCommand[];
  gitStatus: "CLEAN" | "DIRTY";
  updatedAt: string;
};

type AgentProvider = "CLAUDE" | "CODEX";
type AgentHealth = {
  provider: AgentProvider;
  available: boolean;
  authenticated: boolean | null;
  cliVersion: string | null;
  message?: string;
  capabilities: { availableModels: string[] | null; availableEffortLevels: string[] | null };
};
type UsageRecord = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  usageSource: "provider_reported" | "unavailable";
  actualCostUsd: number | null;
  apiEquivalentCostUsd: number | null;
  costSource: "calculated" | "unavailable";
  costBreakdown: {
    model: string;
    pricingEffectiveFrom: string;
    pricingSource: string;
    categories: Array<{
      category: "INPUT" | "CACHED_INPUT" | "CACHE_CREATION_INPUT" | "OUTPUT" | "REASONING_OUTPUT";
      tokens: number;
      pricePerMillion: number;
      subtotalUsd: number;
    }>;
    totalUsd: number;
  } | null;
};
type UsageBreakdown = {
  key: string;
  label: string;
  runs: number;
  tokens: number;
  apiEquivalentCostUsd: number;
  calculatedCostRuns: number;
  unavailableCostRuns: number;
};
type UsageDashboard = {
  range: { period: "today" | "7d" | "30d" | "month" | "all" | "custom"; from: string | null; to: string | null };
  summary: {
    runs: number;
    totalTokens: number;
    exactTokenRuns: number;
    unavailableTokenRuns: number;
    apiEquivalentCostUsd: number;
    calculatedCostRuns: number;
    unavailableCostRuns: number;
    browserEnabledRuns: number;
    averageTokensPerTask: number | null;
  };
  byProvider: UsageBreakdown[];
  byModel: UsageBreakdown[];
  byWorkflow: UsageBreakdown[];
  byRole: UsageBreakdown[];
  highestUsageTasks: Array<UsageBreakdown & { taskId: string; projectId: string }>;
  timeline: Array<{
    date: string;
    runs: number;
    tokens: number;
    apiEquivalentCostUsd: number;
    calculatedCostRuns: number;
    unavailableCostRuns: number;
  }>;
  efficiency: {
    tokensPerCompletedTask: number | null;
    tokensPerReviewRound: number | null;
    tokensPerAcceptedFinding: number | null;
    tokensPerImplementationRun: number | null;
    cacheHitRatio: number | null;
  };
  taskReviewRounds: { current: number; maximum: number } | null;
  runs: Array<{
    runId: string;
    taskId: string | null;
    projectId: string;
    provider: AgentProvider;
    model: string;
    role: string;
    workflow: string;
    status: string;
    tokens: number | null;
    tokenSource: "EXACT" | "CALCULATED" | "UNAVAILABLE";
    apiEquivalentCostUsd: number | null;
    costSource: "CALCULATED" | "UNAVAILABLE";
    inputTokens: number | null;
    cachedInputTokens: number | null;
    cacheCreationTokens: number | null;
    outputTokens: number | null;
    reasoningOutputTokens: number | null;
    durationMs: number | null;
    browserEnabled: boolean;
    browserSearchCount: null;
    createdAt: string;
  }>;
};
type AgentRun = {
  id: string;
  projectId: string;
  provider: AgentProvider;
  requestedModel: string;
  actualModel: string | null;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  output: string;
  errorOutput: string;
  errorMessage: string | null;
  durationMs: number | null;
  usage: UsageRecord | null;
};

function usageLine(usage: UsageRecord | null | undefined): string {
  if (!usage || usage.usageSource === "unavailable") return "Tokens: unavailable";
  const parts = [
    usage.inputTokens !== null ? `in ${usage.inputTokens.toLocaleString()}` : null,
    usage.outputTokens !== null ? `out ${usage.outputTokens.toLocaleString()}` : null,
    usage.cachedInputTokens !== null ? `cached ${usage.cachedInputTokens.toLocaleString()}` : null,
  ].filter((part): part is string => part !== null);
  return `Tokens: ${parts.join(" · ")} · EXACT`;
}

function formatUsd(value: number): string {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  });
}

function formatNumber(value: number | null): string {
  return value === null ? "Unavailable" : Math.round(value).toLocaleString();
}

function formatPercent(value: number | null): string {
  return value === null ? "Unavailable" : `${(value * 100).toFixed(1)}%`;
}

function formatAggregateCost(value: number, calculatedRuns: number): string {
  if (usageCostSettings.value?.showApiEquivalentCost === false) return "Hidden by settings";
  return calculatedRuns ? formatUsd(value) : "Unavailable";
}

function costCategoryLabel(category: NonNullable<UsageRecord["costBreakdown"]>["categories"][number]["category"]): string {
  return ({
    INPUT: "Input",
    CACHED_INPUT: "Cached input",
    CACHE_CREATION_INPUT: "Cache creation input",
    OUTPUT: "Output",
    REASONING_OUTPUT: "Reasoning output",
  })[category];
}

type TaskStatus = "DRAFT" | "ANALYZING" | "CROSS_REVIEW" | "READY" | "FAILED" | "CANCELLED" | "CHECKPOINTED";
type BrainstormAnalysis = {
  summary: string;
  facts: string[];
  assumptions: string[];
  unknowns: string[];
  options: Array<{ name: string; description: string; advantages: string[]; disadvantages: string[]; risks: string[] }>;
  recommendedExperiments: string[];
  recommendation: string | null;
};
type CrossReview = {
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
type ReportSynthesis = {
  executiveSummary: string;
  keyRisks: string[];
  recommendation: string;
};
type DuplicateSuggestions = {
  groups: { canonicalQuestionId: string; duplicateQuestionIds: string[] }[];
};
/** An editable, not-yet-accepted suggestion from POST .../generate-suggestions — expectedEvidence and
 * suggestedAnswers are held as one-item-per-line text while being edited, and split into arrays only
 * when submitted to accept-suggestions. */
type QuestionSuggestionDraft = {
  questionId: string;
  priority: "BLOCKING" | "HIGH" | "MEDIUM" | "LOW";
  whyItMatters: string;
  suggestedAction: string;
  expectedEvidenceText: string;
  suggestedAnswersText: string;
};
type QuestionSuggestion = {
  questionId: string;
  priority: "BLOCKING" | "HIGH" | "MEDIUM" | "LOW";
  whyItMatters: string;
  suggestedAction: string;
  expectedEvidence: string[];
  suggestedAnswers: string[];
};
type QuestionSuggestions = { suggestions: QuestionSuggestion[] };
type TaskArtifact = {
  id: string;
  kind: "ANALYSIS" | "CROSS_REVIEW" | "REPORT_SYNTHESIS" | "DUPLICATE_SUGGESTIONS" | "QUESTION_SUGGESTIONS";
  provider: AgentProvider;
  targetProvider: AgentProvider | null;
  structuredData: BrainstormAnalysis | CrossReview | ReportSynthesis | DuplicateSuggestions | QuestionSuggestions | null;
  rawOutput: string;
  parseError: string | null;
};
type EvidenceItem = {
  id: string;
  type: "FACT" | "ASSUMPTION" | "QUESTION" | "DECISION" | "EXPERIMENT_RESULT";
  content: string;
  sourceProvider: AgentProvider | null;
};
type QuestionStatus = "OPEN" | "ANSWERED" | "DEFERRED" | "NOT_APPLICABLE" | "DUPLICATE";
type QuestionResponseSource = "HUMAN" | "EXPERIMENT" | "PROVIDER";
type QuestionResponse = {
  id: string;
  questionId: string;
  answer: string;
  resultingStatus: QuestionStatus;
  linkedEvidenceItemId: string | null;
  linkedExperimentId: string | null;
  source: QuestionResponseSource;
  createdAt: string;
};
type QuestionDetail = {
  questionId: string;
  status: QuestionStatus;
  whyItMatters: string | null;
  suggestedAction: string | null;
  expectedEvidence: string[] | null;
  suggestedAnswers: string[] | null;
  suggestionSource: "CLAUDE" | "CODEX" | "HUMAN" | null;
  duplicateOfQuestionId: string | null;
  responses: QuestionResponse[];
};
type ExperimentStatus = "RUNNING" | "REVIEWING" | "COMPLETED" | "FAILED" | "CANCELLED" | "CHECKPOINTED";
type ExperimentVerdict = "PROVEN" | "DISPROVEN" | "INCONCLUSIVE";
type Experiment = {
  id: string;
  taskId: string;
  hypothesis: string;
  builderProvider: AgentProvider;
  reviewerProvider: AgentProvider;
  status: ExperimentStatus;
  testExecuted: string | null;
  result: string | null;
  conclusion: string | null;
  verdict: ExperimentVerdict | null;
  errorMessage: string | null;
  createdAt: string;
  builderRun: AgentRun | null;
  reviewerRun: AgentRun | null;
};
type AdrStatus = "PROPOSED" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
type Adr = {
  id: string;
  projectId: string;
  taskId: string;
  number: number;
  title: string;
  context: string;
  optionsConsidered: string;
  decision: string;
  reasons: string;
  consequences: string;
  risks: string | null;
  rejectedAlternatives: string | null;
  requiredFollowUp: string | null;
  relatedTaskIds: string[];
  status: AdrStatus;
  openBlockingQuestionCount: number;
};
type PromotedTask = {
  id: string;
  title: string;
  status: TaskStatus;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  planPhase: string | null;
};
type BrainstormTask = {
  id: string;
  projectId: string;
  title: string;
  problemStatement: string;
  type: "BRAINSTORM" | "ARCHITECTURE";
  status: TaskStatus;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  webAccessPolicy: "DISABLED" | "ENABLED_FOR_TASK";
  webAccessPermitted: boolean;
  webAccessDecidedAt: string;
  errorMessage: string | null;
  runs?: Array<AgentRun & { role: "INDEPENDENT_ANALYSIS" | "CROSS_REVIEW"; targetProvider: AgentProvider | null }>;
  artifacts?: TaskArtifact[];
  evidence?: EvidenceItem[];
  questionDetails?: QuestionDetail[];
  openQuestionCount: number;
  comparison?: {
    consensus: string[];
    disagreements: string[];
    openQuestions: string[];
    missingEvidence: string[];
    recommendedExperiments: string[];
  } | null;
  comparisonHistory?: Array<{ id: string; version: number; generatedAt: string; content: NonNullable<BrainstormTask["comparison"]> }>;
};
type WorktreeProposal = {
  provider: AgentProvider;
  path: string;
  branchName: string;
  baseRef: string;
  available: boolean;
  message: string | null;
};
type ManagedWorktree = {
  id: string;
  taskId: string;
  projectId: string;
  provider: AgentProvider;
  path: string;
  branchName: string;
  baseRef: string;
  status: "CREATING" | "ACTIVE" | "ERROR";
  lastError: string | null;
  inUse: boolean;
  activeUsages: Array<{ id: string; ownerType: string; ownerId: string; startedAt: string; stale: boolean }>;
  inspection: {
    head: string | null;
    branchName: string | null;
    gitStatus: "CLEAN" | "DIRTY";
    porcelain: string;
    locked: boolean;
    prunable: boolean;
  } | null;
  inspectionError: string | null;
};

type BuildRunStatus = "BUILDING" | "VALIDATING" | "REVIEWING" | "RESPONDING" | "COMPLETED" | "FAILED" | "CANCELLED" | "CHECKPOINTED";
type ValidationRunStatus = "PASSED" | "FAILED" | "ERROR";
type FindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
type FindingCategory =
  | "CORRECTNESS" | "RACE_CONDITION" | "SECURITY" | "DATA_INTEGRITY" | "PERFORMANCE"
  | "TESTING" | "MAINTAINABILITY" | "MIGRATION" | "COMPATIBILITY";
type FindingConfidence = "LOW" | "MEDIUM" | "HIGH";
type FindingVerdict = "ACCEPTED" | "REJECTED" | "PARTIALLY_ACCEPTED";
type ValidationRunRow = {
  id: string;
  commandId: string;
  commandLabel: string;
  command: string;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  status: ValidationRunStatus;
  phase: "BUILD" | "POST_MERGE";
};
type ReviewFinding = {
  id: string;
  ordinal: number;
  round: number;
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
  status: "OPEN" | "RESPONDED" | "RESOLVED";
  builderVerdict: FindingVerdict | null;
  builderEvidence: string | null;
  builderAction: string | null;
  reviewerRecheckNote: string | null;
};
type BuildMergeStatus = "NOT_MERGED" | "MERGING" | "MERGED" | "MERGE_CONFLICT" | "MERGE_FAILED";
type BuildRun = {
  id: string;
  taskId: string;
  builderProvider: AgentProvider;
  reviewerProvider: AgentProvider;
  worktreeId: string | null;
  status: BuildRunStatus;
  diffUnstaged: string | null;
  diffStaged: string | null;
  reviewRound: number;
  maxReviewRounds: number;
  mergeStatus: BuildMergeStatus;
  mergeTargetBranch: string | null;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  mergeError: string | null;
  mergeTargetCheckedOutAt: string | null;
  worktreeRemovedAfterMerge: boolean | null;
  branchDeletedAfterMerge: boolean | null;
  worktreeCleanupSkippedReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  builderRun: AgentRun | null;
  reviewerRun: AgentRun | null;
  validationRuns: ValidationRunRow[];
  findings: ReviewFinding[];
  reviewArtifact: { rawOutput: string; parseError: string | null } | null;
};

type PrePrReport = {
  generatedAt: string;
  taskId: string;
  taskTitle: string;
  problemStatement: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  buildRunId: string;
  builderProvider: AgentProvider;
  reviewerProvider: AgentProvider;
  reviewRound: number;
  implementationSummary: string | null;
  filesChanged: string[];
  findings: { total: number; accepted: ReviewFinding[]; rejected: ReviewFinding[]; unresolved: ReviewFinding[] };
  tests: { commandLabel: string; status: ValidationRunStatus; exitCode: number | null; phase: "BUILD" | "POST_MERGE" }[];
  merge: { status: BuildMergeStatus; targetBranch: string | null; commitSha: string | null; mergedAt: string | null };
  architectureDecisions: { id: string; number: number; title: string; status: AdrStatus; decision: string }[];
  humanReviewRequired: true;
  recommendedNextAction: string;
};

type QuestionReportEntry = {
  id: string;
  content: string;
  sourceProvider: AgentProvider | null;
  priority: "BLOCKING" | "HIGH" | "MEDIUM" | "LOW" | null;
  whyItMatters: string | null;
  suggestedAction: string | null;
  responses: { answer: string; resultingStatus: QuestionStatus; source: QuestionResponseSource; createdAt: string }[];
};
type BrainstormPlanReport = {
  generatedAt: string;
  taskId: string;
  taskTitle: string;
  taskType: "BRAINSTORM" | "ARCHITECTURE";
  problemStatement: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: TaskStatus;
  analyses: { provider: AgentProvider; data: BrainstormAnalysis | null; rawOutput: string; parseError: string | null }[];
  crossReviews: { provider: AgentProvider; targetProvider: AgentProvider | null; data: CrossReview | null; rawOutput: string; parseError: string | null }[];
  comparison: BrainstormTask["comparison"];
  comparisonVersion: number | null;
  evidence: {
    facts: EvidenceItem[];
    assumptions: EvidenceItem[];
    decisions: EvidenceItem[];
    experimentResults: EvidenceItem[];
    questions: {
      open: QuestionReportEntry[];
      answered: QuestionReportEntry[];
      deferred: QuestionReportEntry[];
      notApplicable: QuestionReportEntry[];
      duplicateGroups: { canonical: QuestionReportEntry; duplicates: QuestionReportEntry[] }[];
    };
  };
  architectureDecisions: { id: string; number: number; title: string; status: AdrStatus; decision: string }[];
  experiments: { id: string; hypothesis: string; builderProvider: AgentProvider; reviewerProvider: AgentProvider; status: ExperimentStatus; verdict: ExperimentVerdict | null; conclusion: string | null }[];
  blockingQuestionsRemain: boolean;
  humanDecisionRequired: true;
  recommendedNextAction: string;
};

type UsageStatus = "SAFE" | "WARNING" | "CHECKPOINT_REQUIRED" | "EXHAUSTED" | "UNAVAILABLE" | "STALE";
type UsageWindowView = {
  provider: AgentProvider;
  windowId: string;
  windowLabel: string;
  windowDurationMs: number | null;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  timeUntilReset: string | null;
  source: "CLI_REPORTED" | "APP_SERVER" | "MANUAL" | "RATE_LIMIT_ERROR" | null;
  sourceConfidence: "EXACT" | "ESTIMATED" | null;
  lastRefreshedAt: string | null;
  freshness: "FRESH" | "STALE" | "UNKNOWN";
  status: UsageStatus;
  readingId: string | null;
};
type UsagePolicy = {
  warningThresholdPercent: number;
  checkpointThresholdPercent: number;
  staleAfterMs: number;
  acknowledgementTtlMs: number;
};
type UsageDecision = {
  allowed: boolean;
  requiresAcknowledgement: boolean;
  status: UsageStatus;
  provider: AgentProvider;
  windowId: string;
  readingId: string | null;
  reason: string;
};
type UsageBudgetPreset = "NONE" | "ECONOMY" | "BALANCED" | "DEEP" | "CUSTOM";
type UsageBudget = {
  taskId: string;
  preset: UsageBudgetPreset;
  state: "ACTIVE" | "CHECKPOINTED" | "STOPPED";
  maxTokens: number | null;
  apiEquivalentCostWarningUsd: number | null;
  maxAgentRuns: number | null;
  maxReviewRounds: number | null;
  warningPercent: number;
  continueRunsRemaining: number;
  checkpointReason: string | null;
};
type UsageBudgetDetail = {
  budget: UsageBudget;
  progress: {
    agentRuns: number;
    totalTokens: number;
    apiEquivalentCostUsd: number;
    unavailableTokenRuns: number;
    unavailableCostRuns: number;
    utilizationPercent: number;
  };
  audit?: Array<{ id: string; eventType: string; userAction: string | null; reason: string; createdAt: string }>;
};
type UsageCostSettings = {
  trackUsage: boolean;
  showApiEquivalentCost: boolean;
  storeRawTelemetry: boolean;
  defaultBudgetPreset: Exclude<UsageBudgetPreset, "CUSTOM">;
  budgetPresets: Record<"ECONOMY" | "BALANCED" | "DEEP", { maxAgentRuns: number; maxReviewRounds: number; warningPercent: number }>;
};
type PricingEntry = {
  id: string;
  provider: AgentProvider;
  model: string;
  inputPricePerMillion: number;
  cachedInputPricePerMillion: number | null;
  cacheCreationInputPricePerMillion: number | null;
  outputPricePerMillion: number;
  reasoningPricePerMillion: number | null;
  effectiveFrom: string;
  source: string;
};
type MaintenanceBackup = { name: string; sizeBytes: number; createdAt: string };
type MaintenanceLease = {
  id: string;
  worktreeId: string;
  ownerType: string;
  ownerId: string;
  startedAt: string;
};
type MaintenanceStatus = {
  backups: MaintenanceBackup[];
  pendingRestore: boolean;
  errorWorktrees: Array<{ id: string; path: string; lastError: string | null }>;
  staleUsageLeases: MaintenanceLease[];
  recentMaintenance: Array<{ id: string; action: string; createdAt: string }>;
};

const health = ref<HealthResponse | null>(null);
const loading = ref(true);
const healthError = ref("");
const projects = ref<Project[]>([]);
const projectsLoading = ref(true);
const submitError = ref("");
const successMessage = ref("");
const submitting = ref(false);
const editingProjectId = ref("");
const savingProjectId = ref("");
const deletingProjectId = ref("");
const projectActionError = ref("");
const projectActionMessage = ref("");
const agentHealth = ref<Partial<Record<AgentProvider, AgentHealth>>>({});
const selectedProjectId = ref("");
const selectedProvider = ref<AgentProvider>("CODEX");
const agentPrompt = ref("Explain this repository at a high level. Focus on its purpose, architecture, and main entry points.");
const agentModel = ref("");
const agentEffort = ref("");
const runError = ref("");
const startingRun = ref(false);
const currentRun = ref<AgentRun | null>(null);
let eventSource: EventSource | null = null;
let taskPollTimer: number | null = null;
const tasks = ref<BrainstormTask[]>([]);
const tasksLoading = ref(true);
const selectedTask = ref<BrainstormTask | null>(null);
const taskError = ref("");
const taskRefreshError = ref("");
const taskMessage = ref("");
const creatingTask = ref(false);
const startingTask = ref(false);
const deletingTaskId = ref("");
const evidenceType = ref<EvidenceItem["type"]>("FACT");
const evidenceContent = ref("");
const editingEvidenceId = ref("");
const editingEvidenceContent = ref("");
const editingEvidenceType = ref<EvidenceItem["type"]>("FACT");
const questionFilter = ref<"OPEN" | "ANSWERED" | "DEFERRED" | "DUPLICATE" | "ALL">("OPEN");
const answeringQuestionId = ref("");
const answerDraft = ref("");
const confirmingDuplicateQuestionId = ref("");
const duplicateTargetId = ref("");
const questionActionError = ref("");
const usingCustomAnswer = ref(false);
const questionDetailByQuestionId = computed(() => {
  const map = new Map<string, QuestionDetail>();
  for (const detail of selectedTask.value?.questionDetails ?? []) map.set(detail.questionId, detail);
  return map;
});
function questionDetailFor(item: EvidenceItem): QuestionDetail | undefined {
  return questionDetailByQuestionId.value.get(item.id);
}
function questionContentById(questionId: string): string {
  return selectedTask.value?.evidence?.find((item) => item.id === questionId)?.content ?? "(question no longer available)";
}
const nonQuestionEvidence = computed(() => (selectedTask.value?.evidence ?? []).filter((item) => item.type !== "QUESTION"));
const allQuestions = computed(() => (selectedTask.value?.evidence ?? []).filter((item): item is EvidenceItem => item.type === "QUESTION"));
function otherOpenQuestions(questionId: string): EvidenceItem[] {
  return allQuestions.value.filter((item) => item.id !== questionId && (questionDetailFor(item)?.status ?? "OPEN") === "OPEN");
}
const filteredQuestions = computed(() => allQuestions.value.filter((item) => {
  const status = questionDetailFor(item)?.status ?? "OPEN";
  if (questionFilter.value === "ALL") return true;
  return status === questionFilter.value;
}));
const brainstormReport = ref<BrainstormPlanReport | null>(null);
const loadingBrainstormReport = ref(false);
const brainstormReportError = ref("");
const synthesisProvider = ref<AgentProvider>("CLAUDE");
const generatingSynthesis = ref(false);
const synthesisError = ref("");
const duplicateDetectionProvider = ref<AgentProvider>("CLAUDE");
const detectingDuplicates = ref(false);
const duplicateDetectionError = ref("");
const groupingExactDuplicates = ref(false);
const dismissedDuplicateSuggestionIds = ref(new Set<string>());
const suggestionProvider = ref<AgentProvider>("CLAUDE");
const generatingSuggestions = ref(false);
const acceptingSuggestions = ref(false);
const suggestionError = ref("");
const suggestionPreview = ref<QuestionSuggestionDraft[]>([]);
const experimentsForTask = ref<Experiment[]>([]);
const experimentHypothesis = ref("");
const experimentBuilderProvider = ref<AgentProvider>("CLAUDE");
const experimentReviewerProvider = ref<AgentProvider>("CODEX");
const startingExperiment = ref(false);
const experimentError = ref("");
let experimentPollTimer: number | null = null;
const taskForm = reactive({
  projectId: "",
  title: "Database horizontal scaling",
  type: "ARCHITECTURE" as "BRAINSTORM" | "ARCHITECTURE",
  riskLevel: "HIGH" as BrainstormTask["riskLevel"],
  problemStatement: "How should this system support database sharding?",
  webAccessPermitted: false,
  budgetPreset: "BALANCED" as Exclude<UsageBudgetPreset, "CUSTOM">,
  claudeModel: "",
  codexModel: "",
  claudeEffort: "",
});
const selectedWorktreeTaskId = ref("");
const worktreePreview = ref<WorktreeProposal[]>([]);
const managedWorktrees = ref<ManagedWorktree[]>([]);
const worktreeLoading = ref(false);
const worktreeError = ref("");
const worktreeMessage = ref("");
const creatingWorktree = ref<AgentProvider | null>(null);
const selectedWorktree = ref<ManagedWorktree | null>(null);
const worktreeDiff = ref<{ unstaged: string; staged: string } | null>(null);
const renamePath = ref("");
const renameBranch = ref("");
const removalArmedId = ref("");
const removalConfirmed = ref(false);
const deleteMergedBranch = ref(false);
const worktreeDrafts = reactive<Record<AgentProvider, { path: string; branchName: string; baseRef: string }>>({
  CLAUDE: { path: "", branchName: "", baseRef: "" },
  CODEX: { path: "", branchName: "", baseRef: "" },
});

const selectedBuildTaskId = ref("");
const buildBuilderProvider = ref<AgentProvider>("CLAUDE");
const buildReviewerProvider = ref<AgentProvider>("CODEX");
const buildMaxReviewRounds = ref(3);
const buildValidationSelection = reactive<Record<string, boolean>>({});
const builds = ref<BuildRun[]>([]);
const buildsLoading = ref(false);
const buildError = ref("");
const buildMessage = ref("");
const startingBuild = ref(false);
const respondingToFindings = ref(false);
const merging = ref(false);
const mergeTargetBranch = ref("");
const mergeCommitMessage = ref("");
const keepWorktreeAfterMerge = ref(false);
const deleteBranchAfterMerge = ref(false);
const selectedBuild = ref<BuildRun | null>(null);
const prePrReport = ref<PrePrReport | null>(null);
const loadingReport = ref(false);
const reportError = ref("");
let buildPollTimer: number | null = null;

const selectedAdrTaskId = ref("");
const adrsForTask = ref<Adr[]>([]);
const adrError = ref("");
const creatingAdr = ref(false);
const adrForm = reactive({
  title: "", context: "", optionsConsidered: "", decision: "", reasons: "", consequences: "",
  risks: "", rejectedAlternatives: "", requiredFollowUp: "",
});
const promotedTasksByAdr = reactive<Record<string, PromotedTask[]>>({});
const promoteForms = reactive<Record<string, { title: string; problemStatement: string; planPhase: string; riskLevel: string }>>({});
const promotingAdrId = ref("");

const usage = ref<Record<AgentProvider, UsageWindowView[]>>({ CLAUDE: [], CODEX: [] });
const usagePolicy = ref<UsagePolicy | null>(null);
const usageError = ref("");
const usageMessage = ref("");
const usageLoading = ref(false);
const refreshingProvider = ref<AgentProvider | null>(null);
const manualSnapshotForm = reactive<Record<AgentProvider, { windowId: string; windowLabel: string; usedPercent: string; resetAt: string }>>({
  CLAUDE: { windowId: "5H", windowLabel: "5-hour window", usedPercent: "", resetAt: "" },
  CODEX: { windowId: "5H", windowLabel: "5-hour window", usedPercent: "", resetAt: "" },
});
const policyForm = reactive({ warningThresholdPercent: "", checkpointThresholdPercent: "" });
const usageBlockedDecision = ref<UsageDecision | null>(null);
const acknowledging = ref(false);
const maintenance = ref<MaintenanceStatus | null>(null);
const maintenanceLoading = ref(false);
const maintenanceError = ref("");
const maintenanceMessage = ref("");
const usageDashboard = ref<UsageDashboard | null>(null);
const usageDashboardLoading = ref(false);
const usageDashboardError = ref("");
const usageDashboardPeriod = ref<UsageDashboard["range"]["period"]>("7d");
const usageDashboardProjectId = ref("");
const usageDashboardTaskId = ref("");
const usageDashboardFrom = ref("");
const usageDashboardTo = ref("");
const selectedTaskUsage = ref<UsageDashboard | null>(null);
const selectedTaskUsageLoading = ref(false);
const selectedTaskBudget = ref<UsageBudgetDetail | null>(null);
const taskBudgetError = ref("");
const taskBudgetMessage = ref("");
const taskBudgetSaving = ref(false);
const taskBudgetForm = reactive({
  preset: "BALANCED" as UsageBudgetPreset,
  maxTokens: "",
  apiEquivalentCostWarningUsd: "",
  maxAgentRuns: "",
  maxReviewRounds: "",
  warningPercent: "80",
});
const usageCostSettings = ref<UsageCostSettings | null>(null);
const usageSettingsForm = reactive<UsageCostSettings>({
  trackUsage: true,
  showApiEquivalentCost: true,
  storeRawTelemetry: true,
  defaultBudgetPreset: "BALANCED",
  budgetPresets: {
    ECONOMY: { maxAgentRuns: 4, maxReviewRounds: 1, warningPercent: 75 },
    BALANCED: { maxAgentRuns: 8, maxReviewRounds: 3, warningPercent: 80 },
    DEEP: { maxAgentRuns: 16, maxReviewRounds: 5, warningPercent: 85 },
  },
});
const usageSettingsSaving = ref(false);
const usageSettingsMessage = ref("");
const pricingEntries = ref<PricingEntry[]>([]);
const pricingSaving = ref(false);
const pricingForm = reactive({
  provider: "CODEX" as AgentProvider,
  model: "",
  inputPricePerMillion: "",
  cachedInputPricePerMillion: "",
  cacheCreationInputPricePerMillion: "",
  outputPricePerMillion: "",
  reasoningPricePerMillion: "",
  effectiveFrom: "",
  source: "",
});

const usageDashboardTaskOptions = computed(() => tasks.value.filter((task) =>
  !usageDashboardProjectId.value || task.projectId === usageDashboardProjectId.value,
));
const usageTimelineMaximum = computed(() => Math.max(1, ...(usageDashboard.value?.timeline.map((point) => point.tokens) ?? [0])));

function providerLabel(provider: AgentProvider) {
  return provider === "CLAUDE" ? "Claude Code" : "Codex";
}

function projectName(projectId: string): string {
  return projects.value.find((project) => project.id === projectId)?.name ?? "Unknown project";
}

function taskName(taskId: string | null): string {
  if (!taskId) return "Standalone run";
  return tasks.value.find((task) => task.id === taskId)?.title ?? "Unknown task";
}

const USAGE_STATUS_RANK: Record<UsageStatus, number> = { SAFE: 0, WARNING: 1, UNAVAILABLE: 2, STALE: 2, CHECKPOINT_REQUIRED: 3, EXHAUSTED: 4 };
function worstUsageStatus(provider: AgentProvider): UsageStatus {
  const views = usage.value[provider];
  if (!views.length) return "UNAVAILABLE";
  return views.reduce((worst, view) => (USAGE_STATUS_RANK[view.status] > USAGE_STATUS_RANK[worst] ? view.status : worst), "SAFE" as UsageStatus);
}

function usageStatusLabel(status: UsageStatus) {
  return {
    SAFE: "Safe", WARNING: "Warning", CHECKPOINT_REQUIRED: "Checkpoint required",
    EXHAUSTED: "Exhausted", UNAVAILABLE: "Unavailable", STALE: "Stale",
  }[status];
}

async function loadUsage() {
  usageLoading.value = true;
  usageError.value = "";
  try {
    const [usageResponse, policyResponse] = await Promise.all([fetch("/api/usage"), fetch("/api/usage/policy")]);
    if (!usageResponse.ok) throw new Error("Could not load provider usage.");
    usage.value = await usageResponse.json();
    if (policyResponse.ok) {
      usagePolicy.value = await policyResponse.json();
      policyForm.warningThresholdPercent = String(usagePolicy.value!.warningThresholdPercent);
      policyForm.checkpointThresholdPercent = String(usagePolicy.value!.checkpointThresholdPercent);
    }
  } catch (error) {
    usageError.value = error instanceof Error ? error.message : "Could not load provider usage.";
  } finally {
    usageLoading.value = false;
  }
}

function onUsageDashboardProjectChange() {
  if (!usageDashboardTaskOptions.value.some((task) => task.id === usageDashboardTaskId.value)) {
    usageDashboardTaskId.value = "";
  }
}

async function loadUsageDashboard() {
  usageDashboardLoading.value = true;
  usageDashboardError.value = "";
  try {
    const parameters = new URLSearchParams({ period: usageDashboardPeriod.value });
    if (usageDashboardProjectId.value) parameters.set("projectId", usageDashboardProjectId.value);
    if (usageDashboardTaskId.value) parameters.set("taskId", usageDashboardTaskId.value);
    if (usageDashboardPeriod.value === "custom") {
      if (!usageDashboardFrom.value || !usageDashboardTo.value) throw new Error("Choose both dates for a custom period.");
      parameters.set("from", new Date(`${usageDashboardFrom.value}T00:00:00`).toISOString());
      parameters.set("to", new Date(`${usageDashboardTo.value}T23:59:59.999`).toISOString());
    }
    const response = await fetch(`/api/usage-records/dashboard?${parameters}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not load usage and cost history.");
    usageDashboard.value = result;
  } catch (error) {
    usageDashboardError.value = error instanceof Error ? error.message : "Could not load usage and cost history.";
  } finally {
    usageDashboardLoading.value = false;
  }
}

async function loadSelectedTaskUsage(taskId: string, showLoading = true) {
  if (showLoading) selectedTaskUsageLoading.value = true;
  try {
    const response = await fetch(`/api/usage-records/dashboard?period=all&taskId=${encodeURIComponent(taskId)}`);
    const result = response.ok ? await response.json() : null;
    if (selectedTask.value?.id === taskId) selectedTaskUsage.value = result;
  } finally {
    if (showLoading) selectedTaskUsageLoading.value = false;
  }
}

function copyBudgetToForm(detail: UsageBudgetDetail) {
  taskBudgetForm.preset = detail.budget.preset;
  taskBudgetForm.maxTokens = detail.budget.maxTokens === null ? "" : String(detail.budget.maxTokens);
  taskBudgetForm.apiEquivalentCostWarningUsd = detail.budget.apiEquivalentCostWarningUsd === null ? "" : String(detail.budget.apiEquivalentCostWarningUsd);
  taskBudgetForm.maxAgentRuns = detail.budget.maxAgentRuns === null ? "" : String(detail.budget.maxAgentRuns);
  taskBudgetForm.maxReviewRounds = detail.budget.maxReviewRounds === null ? "" : String(detail.budget.maxReviewRounds);
  taskBudgetForm.warningPercent = String(detail.budget.warningPercent);
}

async function loadSelectedTaskBudget(taskId: string, syncForm = true) {
  if (syncForm) taskBudgetError.value = "";
  const response = await fetch(`/api/tasks/${taskId}/usage-budget`);
  if (!response.ok) {
    if (syncForm && selectedTask.value?.id === taskId) taskBudgetError.value = "Could not load this task's budget.";
    return;
  }
  const result: UsageBudgetDetail = await response.json();
  if (selectedTask.value?.id !== taskId) return;
  selectedTaskBudget.value = result;
  if (syncForm) copyBudgetToForm(result);
}

async function saveTaskBudget() {
  if (!selectedTask.value) return;
  taskBudgetSaving.value = true;
  taskBudgetError.value = "";
  taskBudgetMessage.value = "";
  const numberOrNull = (value: string) => value.trim() ? Number(value) : null;
  const payload = taskBudgetForm.preset === "CUSTOM" ? {
    preset: "CUSTOM",
    maxTokens: numberOrNull(taskBudgetForm.maxTokens),
    apiEquivalentCostWarningUsd: numberOrNull(taskBudgetForm.apiEquivalentCostWarningUsd),
    maxAgentRuns: numberOrNull(taskBudgetForm.maxAgentRuns),
    maxReviewRounds: numberOrNull(taskBudgetForm.maxReviewRounds),
    warningPercent: Number(taskBudgetForm.warningPercent),
  } : { preset: taskBudgetForm.preset };
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/usage-budget`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not save this task budget.");
    selectedTaskBudget.value = result;
    copyBudgetToForm(result);
    taskBudgetMessage.value = "Task budget saved. Existing usage remains counted against the new limits.";
  } catch (error) {
    taskBudgetError.value = error instanceof Error ? error.message : "Could not save this task budget.";
  } finally {
    taskBudgetSaving.value = false;
  }
}

async function decideTaskBudget(action: "STOP_AND_SUMMARIZE" | "CONTINUE_ONE_RUN") {
  if (!selectedTask.value) return;
  taskBudgetSaving.value = true;
  taskBudgetError.value = "";
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/usage-budget/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not record the budget decision.");
    const next = { ...selectedTaskBudget.value!, ...result } as UsageBudgetDetail;
    selectedTaskBudget.value = next;
    copyBudgetToForm(next);
    taskBudgetMessage.value = action === "CONTINUE_ONE_RUN"
      ? "One additional model run is allowed. Resume the checkpointed workflow when ready."
      : "Further model runs are stopped. The task's accumulated results and usage summary remain available.";
  } catch (error) {
    taskBudgetError.value = error instanceof Error ? error.message : "Could not record the budget decision.";
  } finally {
    taskBudgetSaving.value = false;
  }
}

async function loadUsageSettings() {
  const [settingsResponse, pricingResponse] = await Promise.all([fetch("/api/usage/settings"), fetch("/api/usage/pricing")]);
  if (settingsResponse.ok) {
    const result = await settingsResponse.json() as UsageCostSettings;
    usageCostSettings.value = result;
    usageSettingsForm.trackUsage = result.trackUsage;
    usageSettingsForm.showApiEquivalentCost = result.showApiEquivalentCost;
    usageSettingsForm.storeRawTelemetry = result.storeRawTelemetry;
    usageSettingsForm.defaultBudgetPreset = result.defaultBudgetPreset;
    usageSettingsForm.budgetPresets = JSON.parse(JSON.stringify(result.budgetPresets)) as UsageCostSettings["budgetPresets"];
    taskForm.budgetPreset = result.defaultBudgetPreset;
  }
  if (pricingResponse.ok) pricingEntries.value = await pricingResponse.json();
}

async function saveUsageSettings() {
  usageSettingsSaving.value = true;
  usageSettingsMessage.value = "";
  usageDashboardError.value = "";
  try {
    const [settingsResponse, policyResponse] = await Promise.all([
      fetch("/api/usage/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(usageSettingsForm),
      }),
      fetch("/api/usage/policy", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ warningThresholdPercent: Number(policyForm.warningThresholdPercent) }),
      }),
    ]);
    const settingsResult = await settingsResponse.json();
    const policyResult = await policyResponse.json();
    if (!settingsResponse.ok) throw new Error(settingsResult.message ?? "Could not save usage and cost settings.");
    if (!policyResponse.ok) throw new Error(policyResult.message ?? "Could not save the default warning threshold.");
    usageCostSettings.value = settingsResult;
    usagePolicy.value = policyResult;
    usageSettingsMessage.value = "Usage, cost, pricing-preset, and warning settings saved.";
  } catch (error) {
    usageDashboardError.value = error instanceof Error ? error.message : "Could not save usage and cost settings.";
  } finally {
    usageSettingsSaving.value = false;
  }
}

async function createPricingVersion() {
  pricingSaving.value = true;
  usageDashboardError.value = "";
  const optionalNumber = (value: string) => value.trim() ? Number(value) : null;
  try {
    const response = await fetch("/api/usage/pricing", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: pricingForm.provider,
        model: pricingForm.model,
        inputPricePerMillion: Number(pricingForm.inputPricePerMillion),
        cachedInputPricePerMillion: optionalNumber(pricingForm.cachedInputPricePerMillion),
        cacheCreationInputPricePerMillion: optionalNumber(pricingForm.cacheCreationInputPricePerMillion),
        outputPricePerMillion: Number(pricingForm.outputPricePerMillion),
        reasoningPricePerMillion: optionalNumber(pricingForm.reasoningPricePerMillion),
        effectiveFrom: pricingForm.effectiveFrom ? new Date(pricingForm.effectiveFrom).toISOString() : undefined,
        source: pricingForm.source,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not add the pricing version.");
    pricingEntries.value.unshift(result);
    pricingForm.model = "";
    pricingForm.source = "";
    usageSettingsMessage.value = "Immutable pricing version added. Existing calculated costs were not rewritten.";
  } catch (error) {
    usageDashboardError.value = error instanceof Error ? error.message : "Could not add the pricing version.";
  } finally {
    pricingSaving.value = false;
  }
}

async function refreshUsage(provider: AgentProvider) {
  if (provider === "CLAUDE") {
    const confirmed = window.confirm(
      "Unlike Codex, Claude has no free way to check usage on demand. Refreshing will send one minimal request to the cheapest Claude model just to read your current usage, which will use a small amount of your Claude usage. Continue?",
    );
    if (!confirmed) return;
  }
  refreshingProvider.value = provider;
  usageError.value = "";
  try {
    const response = await fetch(`/api/usage/${provider}/refresh`, { method: "POST" });
    const result = await response.json();
    usageMessage.value = result.message ?? "Refreshed.";
    await loadUsage();
  } catch (error) {
    usageError.value = error instanceof Error ? error.message : "Could not refresh usage.";
  } finally {
    refreshingProvider.value = null;
  }
}

async function submitManualSnapshot(provider: AgentProvider) {
  usageError.value = "";
  usageMessage.value = "";
  const draft = manualSnapshotForm[provider];
  const usedPercent = Number(draft.usedPercent);
  const response = await fetch("/api/usage/manual-snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider, windowId: draft.windowId, windowLabel: draft.windowLabel, usedPercent,
      resetAt: draft.resetAt ? new Date(draft.resetAt).toISOString() : null,
    }),
  });
  const result = await response.json();
  if (!response.ok) usageError.value = result.message ?? "Could not submit the manual snapshot.";
  else {
    usageMessage.value = `Manual ${providerLabel(provider)} snapshot recorded. Manual readings are estimates you entered, not automatic provider data.`;
    await loadUsage();
  }
}

async function updateUsagePolicy() {
  usageError.value = "";
  const response = await fetch("/api/usage/policy", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      warningThresholdPercent: Number(policyForm.warningThresholdPercent),
      checkpointThresholdPercent: Number(policyForm.checkpointThresholdPercent),
    }),
  });
  const result = await response.json();
  if (!response.ok) usageError.value = result.message ?? "Could not update the policy.";
  else {
    usagePolicy.value = result;
    usageMessage.value = "Usage safety thresholds updated.";
  }
}

async function acknowledgeUsageAndRetryStart() {
  const decision = usageBlockedDecision.value;
  if (!decision) return;
  acknowledging.value = true;
  try {
    await fetch("/api/usage/acknowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: decision.provider, status: decision.status, windowId: decision.windowId,
        relatedReadingId: decision.readingId,
        userAction: decision.status === "CHECKPOINT_REQUIRED" ? "OVERRIDE" : "PROCEED",
        reason: `Human acknowledged from the UI: ${decision.reason}`,
      }),
    });
    usageBlockedDecision.value = null;
    await startBrainstorm();
  } finally {
    acknowledging.value = false;
  }
}

/**
 * A soft, advisory hint only — never auto-recorded, never persisted. Deliberately broader/looser
 * than the server's strict EXHAUSTION_PATTERNS in usage-safety.ts (which must be precise enough to
 * safely auto-record an EXHAUSTED reading with no human involved); here a false positive only
 * costs the user one extra glance at an already-visible error, not a wrongly blocked provider. Kept
 * as a separate, intentionally looser list rather than reusing the strict one.
 */
const USAGE_HINT_PATTERNS = [
  /\busage\b/i, /\bquota\b/i, /\ballowance\b/i, /\bexhausted\b/i, /\bcapacity\b/i,
  /\bthrottl/i, /\binsufficient (credits?|balance)\b/i, /\b5[- ]hour\b/i, /\bweekly limit\b/i,
];
const USAGE_HINT_EXCLUSIONS = /\b(tokens?[- ]per[- ]minute|requests?[- ]per[- ]minute|\btpm\b|\brpm\b|rate[_-]?limit[_-]?error|\b429\b)/i;
function looksUsageRelated(text: string | null | undefined): boolean {
  if (!text || USAGE_HINT_EXCLUSIONS.test(text)) return false;
  return USAGE_HINT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Automatic detection only catches a rate-limit refusal whose wording matches a known pattern
 * (see usage-safety.ts). When it doesn't, a failed run looks like any other failure and nothing
 * blocks the next attempt. This lets a human close that gap explicitly after the fact, the same
 * way a manual snapshot works elsewhere: it is always labeled MANUAL, never silently inferred.
 */
async function markProviderExhausted(provider: AgentProvider) {
  usageError.value = "";
  const response = await fetch("/api/usage/manual-snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, windowId: "5H", windowLabel: "5-hour window", usedPercent: 100 }),
  });
  const result = await response.json();
  if (!response.ok) usageError.value = result.message ?? "Could not record the exhausted reading.";
  else {
    usageMessage.value = `Recorded ${providerLabel(provider)} as exhausted (manual). Provider calls for ${providerLabel(provider)} are blocked until reset or a fresh reading.`;
    await loadUsage();
  }
}

function failedProviders(task: BrainstormTask): Array<{ provider: AgentProvider; hint: boolean }> {
  const failedRuns = (task.runs ?? []).filter((run) => run.status === "FAILED");
  const byProvider = new Map(failedRuns.map((run) => [run.provider, run]));
  return (["CLAUDE", "CODEX"] as const)
    .filter((provider) => byProvider.has(provider) && worstUsageStatus(provider) !== "EXHAUSTED")
    .map((provider) => {
      const run = byProvider.get(provider)!;
      return { provider, hint: looksUsageRelated(`${run.errorMessage ?? ""} ${run.errorOutput ?? ""}`) };
    });
}

const form = reactive({
  name: "",
  repositoryPath: "",
  defaultBranch: "",
  worktreeRoot: "",
  projectContext: "",
  tests: "",
  lint: "",
  build: "",
});
const editProjectForm = reactive({
  name: "",
  repositoryPath: "",
  defaultBranch: "",
  worktreeRoot: "",
  projectContext: "",
  validationCommands: [] as ValidationCommand[],
});

const connectedCount = computed(() => {
  if (!health.value) return 0;
  return Object.values(health.value.tools).filter((tool) => tool.available).length;
});

const currentRunUsageHint = computed(() => {
  if (!currentRun.value) return false;
  return looksUsageRelated(`${currentRun.value.errorMessage ?? ""} ${currentRun.value.errorOutput ?? ""}`);
});

async function loadHealth() {
  loading.value = true;
  healthError.value = "";
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error(`Health check failed (${response.status})`);
    health.value = await response.json();
  } catch (error) {
    healthError.value = error instanceof Error ? error.message : "Health check failed";
  } finally {
    loading.value = false;
  }
}

async function loadProjects() {
  projectsLoading.value = true;
  try {
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error("Could not load projects.");
    projects.value = await response.json();
    if (!selectedProjectId.value && projects.value[0]) selectedProjectId.value = projects.value[0].id;
    if (!taskForm.projectId && projects.value[0]) taskForm.projectId = projects.value[0].id;
  } finally {
    projectsLoading.value = false;
  }
}

async function loadTasks() {
  tasksLoading.value = true;
  try {
    const response = await fetch("/api/tasks");
    if (!response.ok) throw new Error("Could not load brainstorming tasks.");
    tasks.value = await response.json();
    if (!selectedTask.value && tasks.value[0]) await selectTask(tasks.value[0].id);
    if (!selectedWorktreeTaskId.value && tasks.value[0]) {
      selectedWorktreeTaskId.value = tasks.value[0].id;
      await loadWorktreesForTask();
    }
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : "Could not load brainstorming tasks.";
  } finally {
    tasksLoading.value = false;
  }
}

async function loadWorktreesForTask() {
  if (!selectedWorktreeTaskId.value) {
    worktreePreview.value = [];
    managedWorktrees.value = [];
    return;
  }
  worktreeLoading.value = true;
  worktreeError.value = "";
  try {
    const [previewResponse, listResponse] = await Promise.all([
      fetch(`/api/tasks/${selectedWorktreeTaskId.value}/worktrees/preview`),
      fetch(`/api/tasks/${selectedWorktreeTaskId.value}/worktrees`),
    ]);
    const preview = await previewResponse.json();
    const list = await listResponse.json();
    if (!previewResponse.ok) throw new Error(preview.message ?? "Could not generate worktree proposals.");
    if (!listResponse.ok) throw new Error(list.message ?? "Could not load managed worktrees.");
    worktreePreview.value = preview.proposals;
    managedWorktrees.value = list;
    for (const proposal of worktreePreview.value) {
      const managed = managedWorktrees.value.find((record) => record.provider === proposal.provider);
      worktreeDrafts[proposal.provider] = managed
        ? { path: managed.path, branchName: managed.branchName, baseRef: managed.baseRef }
        : { path: proposal.path, branchName: proposal.branchName, baseRef: proposal.baseRef };
    }
    if (selectedWorktree.value) {
      selectedWorktree.value = managedWorktrees.value.find((record) => record.id === selectedWorktree.value?.id) ?? null;
    }
    if (!selectedWorktree.value && managedWorktrees.value[0]) selectManagedWorktree(managedWorktrees.value[0]);
  } catch (error) {
    worktreeError.value = error instanceof Error ? error.message : "Could not load worktrees.";
  } finally {
    worktreeLoading.value = false;
  }
}

function proposalFor(provider: AgentProvider) {
  return worktreePreview.value.find((proposal) => proposal.provider === provider);
}

function managedFor(provider: AgentProvider) {
  return managedWorktrees.value.find((record) => record.provider === provider);
}

async function createWorktree(provider: AgentProvider) {
  creatingWorktree.value = provider;
  worktreeError.value = "";
  worktreeMessage.value = "";
  try {
    const response = await fetch(`/api/tasks/${selectedWorktreeTaskId.value}/worktrees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, ...worktreeDrafts[provider] }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not create the worktree.");
    worktreeMessage.value = `${provider === "CLAUDE" ? "Claude" : "Codex"} worktree created without changing the active checkout.`;
    await loadWorktreesForTask();
    const created = managedWorktrees.value.find((record) => record.id === result.id);
    if (created) selectManagedWorktree(created);
  } catch (error) {
    worktreeError.value = error instanceof Error ? error.message : "Could not create the worktree.";
  } finally {
    creatingWorktree.value = null;
  }
}

function selectManagedWorktree(record: ManagedWorktree) {
  selectedWorktree.value = record;
  renamePath.value = record.path;
  renameBranch.value = record.branchName;
  removalArmedId.value = "";
  removalConfirmed.value = false;
  deleteMergedBranch.value = false;
  void loadWorktreeDiff(record.id);
}

async function loadWorktreeDiff(worktreeId: string) {
  const response = await fetch(`/api/worktrees/${worktreeId}/diff`);
  const result = await response.json();
  if (response.ok) worktreeDiff.value = result;
  else {
    worktreeDiff.value = null;
    worktreeError.value = result.message ?? "Could not read the worktree diff.";
  }
}

async function renameWorktreePath() {
  if (!selectedWorktree.value) return;
  worktreeError.value = "";
  const response = await fetch(`/api/worktrees/${selectedWorktree.value.id}/path`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: renamePath.value }),
  });
  const result = await response.json();
  if (!response.ok) worktreeError.value = result.message ?? "Could not move the worktree.";
  else {
    worktreeMessage.value = "Worktree directory moved. Its branch name was not changed.";
    await loadWorktreesForTask();
  }
}

async function renameWorktreeBranch() {
  if (!selectedWorktree.value) return;
  worktreeError.value = "";
  const response = await fetch(`/api/worktrees/${selectedWorktree.value.id}/branch`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ branchName: renameBranch.value }),
  });
  const result = await response.json();
  if (!response.ok) worktreeError.value = result.message ?? "Could not rename the branch.";
  else {
    worktreeMessage.value = "Branch renamed. Its worktree directory was not changed.";
    await loadWorktreesForTask();
  }
}

function armWorktreeRemoval(record: ManagedWorktree) {
  removalArmedId.value = record.id;
  removalConfirmed.value = false;
  deleteMergedBranch.value = false;
}

async function removeWorktree() {
  if (!selectedWorktree.value || !removalConfirmed.value) return;
  worktreeError.value = "";
  const response = await fetch(`/api/worktrees/${selectedWorktree.value.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true, deleteBranch: deleteMergedBranch.value }),
  });
  const result = await response.json();
  if (!response.ok) worktreeError.value = result.message ?? "Could not remove the worktree.";
  else {
    worktreeMessage.value = result.forgotten
      ? "No live Git worktree was found for this record, so the stale entry was cleared. Nothing was deleted from Git."
      : result.deletedBranch
        ? "Clean worktree and merged branch removed."
        : `Clean worktree removed; branch ${result.retainedBranch} was retained.`;
    selectedWorktree.value = null;
    worktreeDiff.value = null;
    await loadWorktreesForTask();
  }
}

async function releaseUsage(usageId: string) {
  if (!selectedWorktree.value) return;
  worktreeError.value = "";
  const response = await fetch(`/api/worktrees/${selectedWorktree.value.id}/usages/${usageId}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) worktreeError.value = result.message ?? "Could not release the usage lease.";
  else {
    worktreeMessage.value = "Usage lease released. Confirm no process is actually still running before trusting this worktree as idle.";
    await loadWorktreesForTask();
  }
}

function projectForTask(taskId: string) {
  const task = tasks.value.find((item) => item.id === taskId);
  return task ? projects.value.find((project) => project.id === task.projectId) ?? null : null;
}

const buildHasNonTerminalRun = computed(() => builds.value.some((build) => ["BUILDING", "VALIDATING", "REVIEWING", "CHECKPOINTED"].includes(build.status)));

async function loadBuildsForTask() {
  if (!selectedBuildTaskId.value) {
    builds.value = [];
    selectedBuild.value = null;
    return;
  }
  buildsLoading.value = true;
  buildError.value = "";
  try {
    const response = await fetch(`/api/tasks/${selectedBuildTaskId.value}/builds`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not load builds for this task.");
    builds.value = result;
    for (const command of projectForTask(selectedBuildTaskId.value)?.validationCommands ?? []) {
      if (!(command.id in buildValidationSelection)) buildValidationSelection[command.id] = true;
    }
    if (builds.value[0]) await selectBuild(builds.value[0].id);
    else selectedBuild.value = null;
  } catch (error) {
    buildError.value = error instanceof Error ? error.message : "Could not load builds for this task.";
  } finally {
    buildsLoading.value = false;
  }
}

async function selectBuild(buildRunId: string) {
  const response = await fetch(`/api/builds/${buildRunId}`);
  if (!response.ok) {
    buildError.value = "Could not load the build.";
    return;
  }
  selectedBuild.value = await response.json();
  if (selectedBuild.value?.status === "CHECKPOINTED" && selectedTask.value?.id === selectedBuild.value.taskId) {
    await loadSelectedTaskBudget(selectedBuild.value.taskId);
  }
  prePrReport.value = null;
  reportError.value = "";
  scheduleBuildRefresh();
}

function scheduleBuildRefresh() {
  if (buildPollTimer !== null) window.clearTimeout(buildPollTimer);
  const active = selectedBuild.value && (
    ["BUILDING", "VALIDATING", "REVIEWING", "RESPONDING"].includes(selectedBuild.value.status)
    || selectedBuild.value.mergeStatus === "MERGING"
  );
  if (!active) return;
  buildPollTimer = window.setTimeout(async () => {
    if (selectedBuild.value) await selectBuild(selectedBuild.value.id);
  }, 1500);
}

async function startBuild() {
  if (!selectedBuildTaskId.value) return;
  startingBuild.value = true;
  buildError.value = "";
  buildMessage.value = "";
  try {
    const validationCommandIds = Object.entries(buildValidationSelection).filter(([, checked]) => checked).map(([id]) => id);
    const response = await fetch(`/api/tasks/${selectedBuildTaskId.value}/builds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        builderProvider: buildBuilderProvider.value,
        reviewerProvider: buildReviewerProvider.value,
        validationCommandIds,
        maxReviewRounds: buildMaxReviewRounds.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not start the build.");
    buildMessage.value = "The build is starting: the builder will edit its worktree, then validation and review follow automatically.";
    await loadBuildsForTask();
  } catch (error) {
    buildError.value = error instanceof Error ? error.message : "Could not start the build.";
  } finally {
    startingBuild.value = false;
  }
}

async function cancelBuild() {
  if (!selectedBuild.value) return;
  buildError.value = "";
  const response = await fetch(`/api/builds/${selectedBuild.value.id}/cancel`, { method: "POST" });
  const result = await response.json();
  if (!response.ok) buildError.value = result.message ?? "Could not cancel the build.";
  else await selectBuild(selectedBuild.value.id);
}

function findingSeverityCounts(build: BuildRun) {
  const counts: Record<FindingSeverity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const finding of build.findings) counts[finding.severity] += 1;
  return counts;
}

function openFindingsCount(build: BuildRun) {
  return build.findings.filter((finding) => finding.status === "OPEN").length;
}

function canRespondToFindings(build: BuildRun) {
  return build.status === "COMPLETED" && openFindingsCount(build) > 0 && build.reviewRound < build.maxReviewRounds;
}

async function respondToFindings() {
  if (!selectedBuild.value) return;
  respondingToFindings.value = true;
  buildError.value = "";
  buildMessage.value = "";
  try {
    const response = await fetch(`/api/builds/${selectedBuild.value.id}/respond`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not start a review-response round.");
    buildMessage.value = "Sending the open findings back to the builder, then the reviewer will recheck them.";
    await selectBuild(selectedBuild.value.id);
  } catch (error) {
    buildError.value = error instanceof Error ? error.message : "Could not start a review-response round.";
  } finally {
    respondingToFindings.value = false;
  }
}

function canMergeBuild(build: BuildRun) {
  return build.status === "COMPLETED" && !["MERGING", "MERGED"].includes(build.mergeStatus);
}

async function mergeBuild() {
  if (!selectedBuild.value) return;
  merging.value = true;
  buildError.value = "";
  buildMessage.value = "";
  try {
    const response = await fetch(`/api/builds/${selectedBuild.value.id}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetBranch: mergeTargetBranch.value.trim() || undefined,
        commitMessage: mergeCommitMessage.value.trim() || undefined,
        keepWorktreeAfterMerge: keepWorktreeAfterMerge.value,
        deleteBranchAfterMerge: deleteBranchAfterMerge.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not start the merge.");
    buildMessage.value = "Merging into the target branch…";
    await selectBuild(selectedBuild.value.id);
  } catch (error) {
    buildError.value = error instanceof Error ? error.message : "Could not start the merge.";
  } finally {
    merging.value = false;
  }
}

async function loadPrePrReport() {
  if (!selectedBuild.value) return;
  loadingReport.value = true;
  reportError.value = "";
  try {
    const response = await fetch(`/api/builds/${selectedBuild.value.id}/report`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not generate the report.");
    prePrReport.value = result;
  } catch (error) {
    reportError.value = error instanceof Error ? error.message : "Could not generate the report.";
  } finally {
    loadingReport.value = false;
  }
}

async function loadAdrsForTask() {
  adrError.value = "";
  if (!selectedAdrTaskId.value) {
    adrsForTask.value = [];
    return;
  }
  const response = await fetch(`/api/tasks/${selectedAdrTaskId.value}/adrs`);
  if (!response.ok) {
    adrError.value = "Could not load ADRs for this task.";
    return;
  }
  adrsForTask.value = await response.json();
  await Promise.all(adrsForTask.value.map(async (adr) => {
    if (!promoteForms[adr.id]) promoteForms[adr.id] = { title: "", problemStatement: "", planPhase: "", riskLevel: "MEDIUM" };
    const promotedResponse = await fetch(`/api/adrs/${adr.id}/promoted-tasks`);
    promotedTasksByAdr[adr.id] = promotedResponse.ok ? await promotedResponse.json() : [];
  }));
}

async function promoteAdr(adr: Adr) {
  const form = promoteForms[adr.id];
  if (!form?.title.trim() || !form.problemStatement.trim()) return;
  promotingAdrId.value = adr.id;
  adrError.value = "";
  try {
    const response = await fetch(`/api/adrs/${adr.id}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: form.title, problemStatement: form.problemStatement,
        riskLevel: form.riskLevel, planPhase: form.planPhase || undefined,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not promote this ADR into a task.");
    Object.assign(form, { title: "", problemStatement: "", planPhase: "" });
    const promotedResponse = await fetch(`/api/adrs/${adr.id}/promoted-tasks`);
    promotedTasksByAdr[adr.id] = promotedResponse.ok ? await promotedResponse.json() : [];
    await loadTasks();
  } catch (error) {
    adrError.value = error instanceof Error ? error.message : "Could not promote this ADR into a task.";
  } finally {
    promotingAdrId.value = "";
  }
}

async function createAdr() {
  if (!selectedAdrTaskId.value) return;
  creatingAdr.value = true;
  adrError.value = "";
  try {
    const response = await fetch(`/api/tasks/${selectedAdrTaskId.value}/adrs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: adrForm.title, context: adrForm.context, optionsConsidered: adrForm.optionsConsidered,
        decision: adrForm.decision, reasons: adrForm.reasons, consequences: adrForm.consequences,
        risks: adrForm.risks || undefined, rejectedAlternatives: adrForm.rejectedAlternatives || undefined,
        requiredFollowUp: adrForm.requiredFollowUp || undefined,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not create the ADR.");
    Object.assign(adrForm, {
      title: "", context: "", optionsConsidered: "", decision: "", reasons: "", consequences: "",
      risks: "", rejectedAlternatives: "", requiredFollowUp: "",
    });
    await loadAdrsForTask();
  } catch (error) {
    adrError.value = error instanceof Error ? error.message : "Could not create the ADR.";
  } finally {
    creatingAdr.value = false;
  }
}

async function updateAdrStatus(adr: Adr, status: AdrStatus) {
  adrError.value = "";
  const response = await fetch(`/api/adrs/${adr.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
  });
  const result = await response.json();
  if (!response.ok) {
    adrError.value = result.message ?? "Could not update the ADR's status.";
    return;
  }
  await loadAdrsForTask();
}

async function selectTask(taskId: string) {
  taskError.value = "";
  taskRefreshError.value = "";
  const response = await fetch(`/api/tasks/${taskId}`);
  if (!response.ok) {
    taskError.value = "Could not load the task.";
    return;
  }
  selectedTask.value = await response.json();
  const index = tasks.value.findIndex((task) => task.id === taskId);
  if (index >= 0) tasks.value[index] = selectedTask.value!;
  brainstormReport.value = null;
  brainstormReportError.value = "";
  experimentError.value = "";
  await Promise.all([loadExperimentsForTask(), loadSelectedTaskUsage(taskId), loadSelectedTaskBudget(taskId)]);
  scheduleTaskRefresh();
}

async function refreshSelectedTaskStatus(taskId: string) {
  if (selectedTask.value?.id !== taskId) return;
  try {
    const response = await fetch(`/api/tasks/${taskId}`);
    if (!response.ok) {
      taskRefreshError.value = "Could not get the latest task status. Retrying automatically.";
      return;
    }
    const refreshedTask: BrainstormTask = await response.json();
    if (selectedTask.value?.id !== taskId) return;

    const previousStatus = selectedTask.value.status;
    selectedTask.value = refreshedTask;
    const index = tasks.value.findIndex((task) => task.id === taskId);
    if (index >= 0) tasks.value[index] = refreshedTask;
    taskRefreshError.value = "";

    if (refreshedTask.status !== previousStatus) {
      void Promise.allSettled([
        loadSelectedTaskUsage(taskId, false),
        loadSelectedTaskBudget(taskId, false),
      ]);
    }
  } catch {
    taskRefreshError.value = "Could not get the latest task status. Retrying automatically.";
  } finally {
    scheduleTaskRefresh();
  }
}

async function loadExperimentsForTask() {
  if (!selectedTask.value) {
    experimentsForTask.value = [];
    return;
  }
  const response = await fetch(`/api/tasks/${selectedTask.value.id}/experiments`);
  if (response.ok) {
    experimentsForTask.value = await response.json();
    if (experimentsForTask.value.some((experiment) => experiment.status === "CHECKPOINTED")) {
      await loadSelectedTaskBudget(selectedTask.value.id);
    }
  }
  scheduleExperimentRefresh();
}

function scheduleExperimentRefresh() {
  if (experimentPollTimer !== null) window.clearTimeout(experimentPollTimer);
  const active = experimentsForTask.value.some((experiment) => ["RUNNING", "REVIEWING"].includes(experiment.status));
  if (!active) return;
  experimentPollTimer = window.setTimeout(() => { void loadExperimentsForTask(); }, 1500);
}

async function startExperiment() {
  if (!selectedTask.value || !experimentHypothesis.value.trim()) return;
  startingExperiment.value = true;
  experimentError.value = "";
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/experiments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hypothesis: experimentHypothesis.value,
        builderProvider: experimentBuilderProvider.value,
        reviewerProvider: experimentReviewerProvider.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not start the experiment.");
    experimentHypothesis.value = "";
    await loadExperimentsForTask();
  } catch (error) {
    experimentError.value = error instanceof Error ? error.message : "Could not start the experiment.";
  } finally {
    startingExperiment.value = false;
  }
}

async function cancelExperiment(experiment: Experiment) {
  experimentError.value = "";
  const response = await fetch(`/api/experiments/${experiment.id}/cancel`, { method: "POST" });
  if (!response.ok) {
    const result = await response.json();
    experimentError.value = result.message ?? "Could not cancel the experiment.";
    return;
  }
  await loadExperimentsForTask();
}

async function resumeExperiment(experiment: Experiment) {
  experimentError.value = "";
  const response = await fetch(`/api/experiments/${experiment.id}/resume`, { method: "POST" });
  const result = await response.json();
  if (!response.ok) {
    experimentError.value = result.message ?? "Could not resume the experiment.";
    return;
  }
  await loadExperimentsForTask();
}

async function loadBrainstormReport() {
  if (!selectedTask.value) return;
  loadingBrainstormReport.value = true;
  brainstormReportError.value = "";
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/report`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not generate the report.");
    brainstormReport.value = result;
  } catch (error) {
    brainstormReportError.value = error instanceof Error ? error.message : "Could not generate the report.";
  } finally {
    loadingBrainstormReport.value = false;
  }
}

/**
 * A single explicit, usage-safety-gated provider call, separate from the free "Generate report"
 * action — never triggered automatically. The result lands as a REPORT_SYNTHESIS task artifact
 * discovered by polling the task the same way `refreshSelectedTaskStatus` already does elsewhere;
 * it deliberately does not touch `brainstormReport` itself so the report on screen doesn't flicker
 * while this runs.
 */
async function generateReportSynthesis() {
  if (!selectedTask.value) return;
  generatingSynthesis.value = true;
  synthesisError.value = "";
  const taskId = selectedTask.value.id;
  try {
    const response = await fetch(`/api/tasks/${taskId}/report/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: synthesisProvider.value }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.code === "USAGE_CHECKPOINT") usageBlockedDecision.value = result.decision;
      throw new Error(result.message ?? "Could not generate an AI summary.");
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (selectedTask.value?.id !== taskId) return;
      await refreshSelectedTaskStatus(taskId);
      if (selectedTask.value?.artifacts?.some((artifact) => artifact.kind === "REPORT_SYNTHESIS")) return;
    }
    synthesisError.value = "The AI summary is taking longer than expected — check back shortly.";
  } catch (error) {
    synthesisError.value = error instanceof Error ? error.message : "Could not generate an AI summary.";
  } finally {
    generatingSynthesis.value = false;
  }
}

const duplicateSuggestions = computed(() =>
  (selectedTask.value?.artifacts?.find((artifact) => artifact.kind === "DUPLICATE_SUGGESTIONS")?.structuredData as DuplicateSuggestions | undefined) ?? null);

/** The suggestion (if any, and not yet dismissed) naming this OPEN question as a duplicate of another. */
function duplicateSuggestionFor(questionId: string): { canonicalQuestionId: string } | null {
  if (dismissedDuplicateSuggestionIds.value.has(questionId)) return null;
  const group = duplicateSuggestions.value?.groups.find((entry) => entry.duplicateQuestionIds.includes(questionId));
  return group ? { canonicalQuestionId: group.canonicalQuestionId } : null;
}

function dismissDuplicateSuggestion(questionId: string) {
  dismissedDuplicateSuggestionIds.value = new Set([...dismissedDuplicateSuggestionIds.value, questionId]);
}

async function groupExactDuplicates() {
  if (!selectedTask.value) return;
  groupingExactDuplicates.value = true;
  duplicateDetectionError.value = "";
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/questions/group-exact-duplicates`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not group exact duplicates.");
    taskMessage.value = result.groupedCount > 0
      ? `Grouped ${result.groupedCount} exact-match duplicate(s).`
      : "No exact-match duplicates were found.";
    await selectTask(selectedTask.value.id);
  } catch (error) {
    duplicateDetectionError.value = error instanceof Error ? error.message : "Could not group exact duplicates.";
  } finally {
    groupingExactDuplicates.value = false;
  }
}

async function detectPossibleDuplicates() {
  if (!selectedTask.value) return;
  detectingDuplicates.value = true;
  duplicateDetectionError.value = "";
  const taskId = selectedTask.value.id;
  try {
    const response = await fetch(`/api/tasks/${taskId}/questions/detect-duplicates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: duplicateDetectionProvider.value }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.code === "USAGE_CHECKPOINT") usageBlockedDecision.value = result.decision;
      throw new Error(result.message ?? "Could not scan for possible duplicates.");
    }
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (selectedTask.value?.id !== taskId) return;
      await refreshSelectedTaskStatus(taskId);
      if (selectedTask.value?.artifacts?.some((artifact) => artifact.kind === "DUPLICATE_SUGGESTIONS")) return;
    }
    duplicateDetectionError.value = "The duplicate scan is taking longer than expected — check back shortly.";
  } catch (error) {
    duplicateDetectionError.value = error instanceof Error ? error.message : "Could not scan for possible duplicates.";
  } finally {
    detectingDuplicates.value = false;
  }
}

/** Open questions that predate v2 analysis (or otherwise never got a suggestion) — the pool "Generate missing suggestions" offers to fill in. */
const questionsMissingSuggestions = computed(() => allQuestions.value.filter((item) => {
  const detail = questionDetailFor(item);
  return (detail?.status ?? "OPEN") === "OPEN" && !detail?.whyItMatters;
}));

async function generateQuestionSuggestions() {
  if (!selectedTask.value) return;
  generatingSuggestions.value = true;
  suggestionError.value = "";
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/questions/generate-suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: suggestionProvider.value }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.code === "USAGE_CHECKPOINT") usageBlockedDecision.value = result.decision;
      throw new Error(result.message ?? "Could not generate question suggestions.");
    }
    const suggestions = result.suggestions as QuestionSuggestion[];
    if (!suggestions.length) {
      taskMessage.value = "No questions currently need a generated suggestion.";
      return;
    }
    suggestionPreview.value = suggestions.map((entry) => ({
      questionId: entry.questionId,
      priority: entry.priority,
      whyItMatters: entry.whyItMatters,
      suggestedAction: entry.suggestedAction,
      expectedEvidenceText: entry.expectedEvidence.join("\n"),
      suggestedAnswersText: entry.suggestedAnswers.join("\n"),
    }));
  } catch (error) {
    suggestionError.value = error instanceof Error ? error.message : "Could not generate question suggestions.";
  } finally {
    generatingSuggestions.value = false;
  }
}

function discardSuggestion(questionId: string) {
  suggestionPreview.value = suggestionPreview.value.filter((draft) => draft.questionId !== questionId);
}

function linesToList(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function acceptSuggestions(drafts: QuestionSuggestionDraft[]) {
  if (!selectedTask.value || !drafts.length) return;
  acceptingSuggestions.value = true;
  suggestionError.value = "";
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/questions/accept-suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        suggestions: drafts.map((draft) => ({
          questionId: draft.questionId,
          priority: draft.priority,
          whyItMatters: draft.whyItMatters,
          suggestedAction: draft.suggestedAction,
          expectedEvidence: linesToList(draft.expectedEvidenceText),
          suggestedAnswers: linesToList(draft.suggestedAnswersText),
        })),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not accept the suggestion(s).");
    const acceptedIds = new Set(drafts.map((draft) => draft.questionId));
    suggestionPreview.value = suggestionPreview.value.filter((draft) => !acceptedIds.has(draft.questionId));
    taskMessage.value = result.skippedCount > 0
      ? `Accepted ${result.acceptedCount} suggestion(s); skipped ${result.skippedCount} that already had suggestions.`
      : `Accepted ${result.acceptedCount} suggestion(s).`;
    await selectTask(selectedTask.value.id);
  } catch (error) {
    suggestionError.value = error instanceof Error ? error.message : "Could not accept the suggestion(s).";
  } finally {
    acceptingSuggestions.value = false;
  }
}

const reportSummary = computed(() => {
  const report = brainstormReport.value;
  if (!report) return null;
  const q = report.evidence.questions;
  return {
    openCount: q.open.length,
    blockingOpenCount: q.open.filter((entry) => entry.priority === "BLOCKING").length,
    answeredCount: q.answered.length,
    deferredCount: q.deferred.length,
    notApplicableCount: q.notApplicable.length,
    duplicateGroupCount: q.duplicateGroups.length,
    consensusCount: report.comparison?.consensus.length ?? 0,
    disagreementCount: report.comparison?.disagreements.length ?? 0,
    missingEvidenceCount: report.comparison?.missingEvidence.length ?? 0,
  };
});

const reportSynthesis = computed(() =>
  (selectedTask.value?.artifacts?.find((artifact) => artifact.kind === "REPORT_SYNTHESIS")?.structuredData as ReportSynthesis | undefined) ?? null);

function mdList(items: string[]): string {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "_None recorded._";
}

/**
 * Mirrors the on-page report section-for-section so the two never drift apart. Pure function of
 * data already fetched for on-screen rendering — no extra request, no provider call.
 */
function formatReportAsMarkdown(report: BrainstormPlanReport): string {
  const summary = reportSummary.value!;
  const lines: string[] = [];
  lines.push(`# Brainstorm Plan Report — ${report.taskTitle}`);
  lines.push("");
  lines.push(`Generated ${new Date(report.generatedAt).toLocaleString()} · ${report.taskType} · risk ${report.riskLevel} · status ${report.status}${report.comparisonVersion ? ` · plan version ${report.comparisonVersion}` : ""}`);
  lines.push("");
  lines.push("## Problem");
  lines.push(report.problemStatement);
  lines.push("");
  if (report.blockingQuestionsRemain) {
    lines.push("> ⚠️ Blocking questions remain unresolved — review the OPEN questions below before promoting this plan.");
    lines.push("");
  }
  lines.push("## Executive summary");
  lines.push(`- Questions: ${summary.openCount} open (${summary.blockingOpenCount} blocking), ${summary.answeredCount} answered, ${summary.deferredCount} deferred, ${summary.notApplicableCount} not applicable, ${summary.duplicateGroupCount} duplicate group(s)`);
  lines.push(`- Comparison: ${summary.consensusCount} consensus point(s), ${summary.disagreementCount} disagreement(s), ${summary.missingEvidenceCount} missing-evidence item(s)`);
  if (reportSynthesis.value) lines.push(`- AI summary: ${reportSynthesis.value.executiveSummary}`);
  lines.push(`- Recommended next action: ${report.recommendedNextAction}`);
  lines.push("");
  if (reportSynthesis.value) {
    lines.push("## AI-generated synthesis");
    lines.push(reportSynthesis.value.executiveSummary);
    lines.push("");
    lines.push("**Key risks**");
    lines.push(mdList(reportSynthesis.value.keyRisks));
    lines.push("");
    lines.push(`**Recommendation:** ${reportSynthesis.value.recommendation}`);
    lines.push("");
  }
  lines.push("## Independent analyses");
  for (const entry of report.analyses) {
    lines.push(`### ${providerLabel(entry.provider)}`);
    if (entry.data) {
      lines.push(entry.data.summary);
      lines.push("");
      lines.push("**Facts**");
      lines.push(mdList(entry.data.facts));
      lines.push("");
      lines.push("**Assumptions**");
      lines.push(mdList(entry.data.assumptions));
      lines.push("");
      lines.push("**Options**");
      for (const option of entry.data.options) {
        lines.push(`1. **${option.name}** — ${option.description} (${option.advantages.length} advantages, ${option.disadvantages.length} disadvantages, ${option.risks.length} risks)`);
      }
      lines.push("");
      lines.push(`**Recommendation:** ${entry.data.recommendation ?? "None given."}`);
    } else {
      lines.push(`Could not be parsed${entry.parseError ? `: ${entry.parseError}` : "."}`);
    }
    lines.push("");
  }
  lines.push("## Cross-reviews");
  for (const entry of report.crossReviews) {
    lines.push(`### ${providerLabel(entry.provider)} reviewing ${entry.targetProvider ? providerLabel(entry.targetProvider) : "unknown"}`);
    lines.push(entry.data ? entry.data.summary : `Could not be parsed${entry.parseError ? `: ${entry.parseError}` : "."}`);
    lines.push("");
  }
  lines.push("## Comparison");
  if (report.comparison) {
    for (const [label, items] of Object.entries(report.comparison)) {
      lines.push(`### ${label.replace(/([A-Z])/g, " $1")}`);
      lines.push(mdList(items));
      lines.push("");
    }
  } else {
    lines.push("Not available yet.");
    lines.push("");
  }
  lines.push("## Questions");
  lines.push(`${summary.openCount} open · ${summary.answeredCount} answered · ${summary.deferredCount} deferred · ${summary.notApplicableCount} not applicable · ${summary.duplicateGroupCount} duplicate group(s)`);
  lines.push("");
  const questionLine = (entry: QuestionReportEntry) => `- ${entry.priority ? `**[${entry.priority}]** ` : ""}${entry.content}`;
  lines.push("**Open**");
  lines.push(report.evidence.questions.open.length ? report.evidence.questions.open.map(questionLine).join("\n") : "_None._");
  lines.push("");
  lines.push("**Answered**");
  lines.push(report.evidence.questions.answered.length
    ? report.evidence.questions.answered.map((entry) => `- ${entry.content}\n  - Answer: ${entry.responses.at(-1)?.answer ?? ""}`).join("\n")
    : "_None._");
  lines.push("");
  lines.push("**Deferred**");
  lines.push(report.evidence.questions.deferred.length ? report.evidence.questions.deferred.map((entry) => `- ${entry.content}`).join("\n") : "_None._");
  lines.push("");
  lines.push("**Not applicable**");
  lines.push(report.evidence.questions.notApplicable.length ? report.evidence.questions.notApplicable.map((entry) => `- ${entry.content}`).join("\n") : "_None._");
  lines.push("");
  lines.push("**Duplicate groups**");
  lines.push(report.evidence.questions.duplicateGroups.length
    ? report.evidence.questions.duplicateGroups.map((group) => `- ${group.canonical.content}\n${group.duplicates.map((dup) => `  - Also asked as: ${dup.content}`).join("\n")}`).join("\n")
    : "_None._");
  lines.push("");
  lines.push("## Other evidence");
  lines.push(`${report.evidence.facts.length} fact(s) · ${report.evidence.assumptions.length} assumption(s) · ${report.evidence.decisions.length} decision(s) · ${report.evidence.experimentResults.length} experiment result(s)`);
  lines.push("");
  if (report.architectureDecisions.length) {
    lines.push("## Architecture decisions");
    lines.push(report.architectureDecisions.map((adr) => `- ADR-${String(adr.number).padStart(4, "0")} — ${adr.title} (${adr.status})`).join("\n"));
    lines.push("");
  }
  if (report.experiments.length) {
    lines.push("## Experiments");
    lines.push(report.experiments.map((experiment) => `- ${experiment.hypothesis} — ${experiment.verdict ?? experiment.status}`).join("\n"));
    lines.push("");
  }
  lines.push("## Human decision required");
  lines.push("YES — this is a plan to review, not an approved decision.");
  return lines.join("\n");
}

async function copyReportAsMarkdown() {
  if (!brainstormReport.value) return;
  try {
    await navigator.clipboard.writeText(formatReportAsMarkdown(brainstormReport.value));
    taskMessage.value = "Report copied as Markdown.";
  } catch {
    brainstormReportError.value = "Could not copy the report — your browser may be blocking clipboard access.";
  }
}

function downloadReportAsMarkdown() {
  if (!brainstormReport.value) return;
  const blob = new Blob([formatReportAsMarkdown(brainstormReport.value)], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `plan-report-${brainstormReport.value.taskId}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function scheduleTaskRefresh() {
  if (taskPollTimer !== null) {
    window.clearTimeout(taskPollTimer);
    taskPollTimer = null;
  }
  if (!selectedTask.value || !["ANALYZING", "CROSS_REVIEW"].includes(selectedTask.value.status)) return;
  const taskId = selectedTask.value.id;
  taskPollTimer = window.setTimeout(() => {
    taskPollTimer = null;
    void refreshSelectedTaskStatus(taskId);
  }, 1500);
}

async function createTask() {
  creatingTask.value = true;
  taskError.value = "";
  taskMessage.value = "";
  try {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: taskForm.projectId,
        title: taskForm.title,
        type: taskForm.type,
        riskLevel: taskForm.riskLevel,
        problemStatement: taskForm.problemStatement,
        webAccessPermitted: taskForm.webAccessPermitted,
        budgetPreset: taskForm.budgetPreset,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not create the task.");
    tasks.value.unshift(result);
    selectedTask.value = result;
    taskMessage.value = "Draft created. Review the web decision, then start the four-run workflow when ready.";
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : "Could not create the task.";
  } finally {
    creatingTask.value = false;
  }
}

async function startBrainstorm() {
  if (!selectedTask.value) return;
  startingTask.value = true;
  taskError.value = "";
  taskMessage.value = "";
  usageBlockedDecision.value = null;
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        claudeModel: taskForm.claudeModel,
        codexModel: taskForm.codexModel,
        claudeEffort: taskForm.claudeEffort,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.code === "USAGE_CHECKPOINT") usageBlockedDecision.value = result.decision;
      if (result.code === "BUDGET_CHECKPOINT") {
        selectedTaskBudget.value = { budget: result.decision.budget, progress: result.decision.progress };
        copyBudgetToForm(selectedTaskBudget.value);
      }
      throw new Error(result.message ?? "Could not start the task.");
    }
    taskMessage.value = "Both independent analyses are starting. Cross-reviews will follow only after both finish.";
    await selectTask(selectedTask.value.id);
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : "Could not start the task.";
  } finally {
    startingTask.value = false;
  }
}

async function resumeBrainstorm() {
  if (!selectedTask.value) return;
  startingTask.value = true;
  taskError.value = "";
  taskMessage.value = "";
  usageBlockedDecision.value = null;
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/resume`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) {
      if (result.code === "USAGE_CHECKPOINT") usageBlockedDecision.value = result.decision;
      if (result.code === "BUDGET_CHECKPOINT") {
        selectedTaskBudget.value = { budget: result.decision.budget, progress: result.decision.progress };
        copyBudgetToForm(selectedTaskBudget.value);
      }
      throw new Error(result.message ?? "Could not resume the task.");
    }
    taskMessage.value = "Resuming the checkpointed workflow.";
    await selectTask(selectedTask.value.id);
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : "Could not resume the task.";
  } finally {
    startingTask.value = false;
  }
}

const canReviseWithAnswers = computed(() =>
  selectedTask.value?.status === "READY" && (selectedTask.value.questionDetails ?? []).some((detail) => detail.status === "ANSWERED"));

async function reviseBrainstormPlan() {
  if (!selectedTask.value) return;
  startingTask.value = true;
  taskError.value = "";
  taskMessage.value = "";
  usageBlockedDecision.value = null;
  try {
    const response = await fetch(`/api/tasks/${selectedTask.value.id}/revise`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) {
      if (result.code === "USAGE_CHECKPOINT") usageBlockedDecision.value = result.decision;
      if (result.code === "BUDGET_CHECKPOINT") {
        selectedTaskBudget.value = { budget: result.decision.budget, progress: result.decision.progress };
        copyBudgetToForm(selectedTaskBudget.value);
      }
      throw new Error(result.message ?? "Could not revise the plan.");
    }
    taskMessage.value = "Revising the plan with the answers recorded so far.";
    await selectTask(selectedTask.value.id);
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : "Could not revise the plan.";
  } finally {
    startingTask.value = false;
  }
}

async function cancelBrainstorm() {
  if (!selectedTask.value) return;
  const response = await fetch(`/api/tasks/${selectedTask.value.id}/cancel`, { method: "POST" });
  const result = await response.json();
  if (!response.ok) taskError.value = result.message ?? "Could not cancel the task.";
  await selectTask(selectedTask.value.id);
}

async function deleteTask() {
  if (!selectedTask.value) return;
  const task = selectedTask.value;
  const confirmed = window.confirm(
    `Delete “${task.title}”? This permanently removes the task, its agent-run history, reports, evidence, experiments, builds, and linked decisions from AI Engineering Workspace. Your Git repository and files will not be changed.`,
  );
  if (!confirmed) return;

  deletingTaskId.value = task.id;
  taskError.value = "";
  taskMessage.value = "";
  try {
    const response = await fetch(`/api/tasks/${task.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.message ?? "Could not delete the task.");
    }

    if (taskPollTimer !== null) window.clearTimeout(taskPollTimer);
    if (experimentPollTimer !== null) window.clearTimeout(experimentPollTimer);
    tasks.value = tasks.value.filter((item) => item.id !== task.id);
    selectedTask.value = null;
    brainstormReport.value = null;
    selectedTaskUsage.value = null;
    selectedTaskBudget.value = null;
    experimentsForTask.value = [];
    if (selectedWorktreeTaskId.value === task.id) selectedWorktreeTaskId.value = "";
    if (selectedBuildTaskId.value === task.id) {
      selectedBuildTaskId.value = "";
      builds.value = [];
      selectedBuild.value = null;
    }
    if (selectedAdrTaskId.value === task.id) {
      selectedAdrTaskId.value = "";
      adrsForTask.value = [];
    }
    if (usageDashboardTaskId.value === task.id) usageDashboardTaskId.value = "";
    taskMessage.value = `Deleted “${task.title}”. Its Git repository and files were not changed.`;
    await Promise.all([loadTasks(), loadUsageDashboard()]);
  } catch (error) {
    taskError.value = error instanceof Error ? error.message : "Could not delete the task.";
  } finally {
    deletingTaskId.value = "";
  }
}

async function addEvidence() {
  if (!selectedTask.value || !evidenceContent.value.trim()) return;
  const response = await fetch(`/api/tasks/${selectedTask.value.id}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: evidenceType.value, content: evidenceContent.value }),
  });
  const result = await response.json();
  if (!response.ok) taskError.value = result.message ?? "Could not add the record.";
  else {
    evidenceContent.value = "";
    await selectTask(selectedTask.value.id);
  }
}

function editEvidence(item: EvidenceItem) {
  editingEvidenceId.value = item.id;
  editingEvidenceContent.value = item.content;
  editingEvidenceType.value = item.type;
}

async function saveEvidence(item: EvidenceItem) {
  if (!selectedTask.value || !editingEvidenceContent.value.trim()) return;
  const response = await fetch(`/api/tasks/${selectedTask.value.id}/evidence/${item.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: editingEvidenceType.value, content: editingEvidenceContent.value }),
  });
  const result = await response.json();
  if (!response.ok) taskError.value = result.message ?? "Could not update the record.";
  else {
    editingEvidenceId.value = "";
    await selectTask(selectedTask.value.id);
  }
}

async function questionAction(questionId: string, path: string, body?: Record<string, unknown>, method: "POST" | "DELETE" = "POST") {
  if (!selectedTask.value) return;
  questionActionError.value = "";
  const response = await fetch(`/api/tasks/${selectedTask.value.id}/questions/${questionId}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    questionActionError.value = result.message ?? "Could not update this question.";
    return false;
  }
  await selectTask(selectedTask.value.id);
  return true;
}

function startAnswering(item: EvidenceItem) {
  answeringQuestionId.value = item.id;
  answerDraft.value = "";
  confirmingDuplicateQuestionId.value = "";
  // Suggested answers, when present, are offered as one-click multiple-choice options first; the
  // free-text box only opens by default when there's nothing to choose from.
  usingCustomAnswer.value = !questionDetailFor(item)?.suggestedAnswers?.length;
}

function useCustomAnswer() {
  usingCustomAnswer.value = true;
}

function cancelAnswering() {
  answeringQuestionId.value = "";
  answerDraft.value = "";
  usingCustomAnswer.value = false;
}

async function submitAnswer(questionId: string) {
  if (!answerDraft.value.trim()) return;
  if (await questionAction(questionId, "/responses", { answer: answerDraft.value })) cancelAnswering();
}

async function selectSuggestedAnswer(questionId: string, answer: string) {
  if (await questionAction(questionId, "/responses", { answer })) cancelAnswering();
}

async function deferQuestion(questionId: string) {
  await questionAction(questionId, "/defer");
}

async function markQuestionNotApplicable(questionId: string) {
  await questionAction(questionId, "/mark-not-applicable");
}

async function reopenQuestion(questionId: string) {
  await questionAction(questionId, "/reopen");
}

function startConfirmingDuplicate(item: EvidenceItem) {
  confirmingDuplicateQuestionId.value = item.id;
  duplicateTargetId.value = "";
  answeringQuestionId.value = "";
}

function cancelConfirmingDuplicate() {
  confirmingDuplicateQuestionId.value = "";
  duplicateTargetId.value = "";
}

async function confirmDuplicate(questionId: string) {
  if (!duplicateTargetId.value) return;
  if (await questionAction(questionId, "/confirm-duplicate", { duplicateOfQuestionId: duplicateTargetId.value })) cancelConfirmingDuplicate();
}

/** Confirming an AI-suggested duplicate directly, bypassing the manual target picker above. */
async function confirmSuggestedDuplicate(questionId: string, targetId: string) {
  await questionAction(questionId, "/confirm-duplicate", { duplicateOfQuestionId: targetId });
}

async function removeDuplicateLink(questionId: string) {
  await questionAction(questionId, "/duplicate-link", undefined, "DELETE");
}

function analysisFor(provider: AgentProvider) {
  return selectedTask.value?.artifacts?.find((item) => item.kind === "ANALYSIS" && item.provider === provider)?.structuredData as BrainstormAnalysis | null | undefined;
}

function reviewFor(provider: AgentProvider) {
  return selectedTask.value?.artifacts?.find((item) => item.kind === "CROSS_REVIEW" && item.provider === provider)?.structuredData as CrossReview | null | undefined;
}

function runStatus(provider: AgentProvider, role: "INDEPENDENT_ANALYSIS" | "CROSS_REVIEW") {
  return selectedTask.value?.runs?.find((run) => run.provider === provider && run.role === role)?.status ?? "WAITING";
}

async function loadAgentHealth() {
  try {
    const response = await fetch("/api/agents/health");
    if (response.ok) agentHealth.value = await response.json();
  } catch {
    agentHealth.value = {};
  }
}

async function recheckTools() {
  await Promise.all([loadHealth(), loadAgentHealth()]);
}

async function refreshRun(runId: string) {
  const response = await fetch(`/api/agent-runs/${runId}`);
  if (response.ok) currentRun.value = await response.json();
}

function streamRun(runId: string) {
  eventSource?.close();
  eventSource = new EventSource(`/api/agent-runs/${runId}/events`);
  for (const type of ["started", "stdout", "stderr", "completed", "failed", "cancelled"]) {
    eventSource.addEventListener(type, async (message) => {
      const event = JSON.parse((message as MessageEvent).data);
      const payload = event.payload ?? {};
      if (type === "started" && currentRun.value) currentRun.value.status = "RUNNING";
      if (type === "stdout" && currentRun.value) currentRun.value.output += payload.chunk ?? "";
      if (type === "stderr" && currentRun.value) currentRun.value.errorOutput += payload.chunk ?? "";
      if (["completed", "failed", "cancelled"].includes(type)) {
        await refreshRun(runId);
        eventSource?.close();
        eventSource = null;
      }
    });
  }
  eventSource.onerror = () => {
    if (currentRun.value && ["QUEUED", "RUNNING"].includes(currentRun.value.status)) void refreshRun(runId);
  };
}

async function startAgentRun() {
  startingRun.value = true;
  runError.value = "";
  currentRun.value = null;
  try {
    const response = await fetch("/api/agent-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: selectedProjectId.value,
        provider: selectedProvider.value,
        prompt: agentPrompt.value,
        model: agentModel.value,
        effort: agentEffort.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not start the agent run.");
    currentRun.value = result;
    streamRun(result.id);
  } catch (error) {
    runError.value = error instanceof Error ? error.message : "Could not start the agent run.";
  } finally {
    startingRun.value = false;
  }
}

async function cancelAgentRun() {
  if (!currentRun.value) return;
  const response = await fetch(`/api/agent-runs/${currentRun.value.id}/cancel`, { method: "POST" });
  if (!response.ok) {
    const result = await response.json();
    runError.value = result.message ?? "Could not cancel the run.";
  }
}

async function registerProject() {
  submitting.value = true;
  submitError.value = "";
  successMessage.value = "";
  const validationCommands = [
    { label: "Tests", command: form.tests.trim() },
    { label: "Lint", command: form.lint.trim() },
    { label: "Build", command: form.build.trim() },
  ].filter((item) => item.command);

  try {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        repositoryPath: form.repositoryPath,
        defaultBranch: form.defaultBranch,
        worktreeRoot: form.worktreeRoot,
        projectContext: form.projectContext,
        validationCommands,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Project registration failed.");
    projects.value.unshift(result);
    successMessage.value = `${result.name} was registered without modifying the repository.`;
    Object.assign(form, {
      name: "",
      repositoryPath: "",
      defaultBranch: "",
      worktreeRoot: "",
      projectContext: "",
      tests: "",
      lint: "",
      build: "",
    });
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : "Project registration failed.";
  } finally {
    submitting.value = false;
  }
}

async function recheckProject(project: Project) {
  projectActionError.value = "";
  projectActionMessage.value = "";
  const response = await fetch(`/api/projects/${project.id}/recheck`, { method: "POST" });
  const result = await response.json();
  if (response.ok) {
    Object.assign(project, result);
    projectActionMessage.value = `${project.name} Git status was refreshed.`;
  } else {
    projectActionError.value = result.message ?? "Repository check failed.";
  }
}

function editProject(project: Project) {
  editingProjectId.value = project.id;
  projectActionError.value = "";
  projectActionMessage.value = "";
  Object.assign(editProjectForm, {
    name: project.name,
    repositoryPath: project.repositoryPath,
    defaultBranch: project.defaultBranch,
    worktreeRoot: project.worktreeRoot,
    projectContext: project.projectContext ?? "",
    validationCommands: project.validationCommands.map((command) => ({ ...command })),
  });
}

function cancelProjectEdit() {
  editingProjectId.value = "";
  projectActionError.value = "";
}

function addValidationCommand() {
  editProjectForm.validationCommands.push({ id: crypto.randomUUID(), label: "", command: "" });
}

async function saveProject(project: Project) {
  savingProjectId.value = project.id;
  projectActionError.value = "";
  projectActionMessage.value = "";
  try {
    const response = await fetch(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...editProjectForm,
        validationCommands: editProjectForm.validationCommands.filter((item) => item.label.trim() || item.command.trim()),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Project update failed.");
    Object.assign(project, result);
    editingProjectId.value = "";
    projectActionMessage.value = `${result.name} was updated without modifying the repository.`;
  } catch (error) {
    projectActionError.value = error instanceof Error ? error.message : "Project update failed.";
  } finally {
    savingProjectId.value = "";
  }
}

async function deregisterProject(project: Project) {
  const confirmed = window.confirm(
    `Deregister ${project.name}? This removes its local tasks, run history, and evidence from AI Engineering Workspace. The Git repository and files will not be deleted.`,
  );
  if (!confirmed) return;

  deletingProjectId.value = project.id;
  projectActionError.value = "";
  projectActionMessage.value = "";
  try {
    const response = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.message ?? "Could not deregister the project.");
    }
    projects.value = projects.value.filter((item) => item.id !== project.id);
    tasks.value = tasks.value.filter((task) => task.projectId !== project.id);
    if (selectedTask.value?.projectId === project.id) selectedTask.value = null;
    if (currentRun.value?.projectId === project.id) currentRun.value = null;
    if (selectedProjectId.value === project.id) selectedProjectId.value = projects.value[0]?.id ?? "";
    if (taskForm.projectId === project.id) taskForm.projectId = projects.value[0]?.id ?? "";
    if (editingProjectId.value === project.id) editingProjectId.value = "";
    projectActionMessage.value = `${project.name} was deregistered. Its Git repository was not changed.`;
  } catch (error) {
    projectActionError.value = error instanceof Error ? error.message : "Could not deregister the project.";
  } finally {
    deletingProjectId.value = "";
  }
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

async function loadMaintenance() {
  maintenanceLoading.value = true;
  maintenanceError.value = "";
  try {
    const response = await fetch("/api/maintenance");
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not load maintenance status.");
    maintenance.value = result;
  } catch (error) {
    maintenanceError.value = error instanceof Error ? error.message : "Could not load maintenance status.";
  } finally {
    maintenanceLoading.value = false;
  }
}

async function createDatabaseBackup() {
  maintenanceLoading.value = true;
  maintenanceError.value = "";
  maintenanceMessage.value = "";
  try {
    const response = await fetch("/api/maintenance/backups", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? "Could not create the backup.");
    maintenanceMessage.value = `Backup ${result.name} created and checked for database integrity.`;
    await loadMaintenance();
  } catch (error) {
    maintenanceError.value = error instanceof Error ? error.message : "Could not create the backup.";
  } finally {
    maintenanceLoading.value = false;
  }
}

async function stageDatabaseRestore(backup: MaintenanceBackup) {
  const confirmed = window.confirm(
    `Restore ${backup.name} on the next application restart? The current database is kept as a pre-restore backup.`,
  );
  if (!confirmed) return;
  maintenanceError.value = "";
  maintenanceMessage.value = "";
  const response = await fetch("/api/maintenance/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ backupName: backup.name, confirm: true }),
  });
  const result = await response.json();
  if (!response.ok) maintenanceError.value = result.message ?? "Could not stage the restore.";
  else {
    maintenanceMessage.value = "Restore staged. Restart the application to apply it; the live database has not changed yet.";
    await loadMaintenance();
  }
}

async function cancelPendingRestore() {
  if (!window.confirm("Cancel the staged database restore? The original backup file will be kept.")) return;
  const response = await fetch("/api/maintenance/restore", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  const result = await response.json();
  if (!response.ok) maintenanceError.value = result.message ?? "Could not cancel the staged restore.";
  else {
    maintenanceMessage.value = "Staged restore cancelled. Backup files were kept.";
    await loadMaintenance();
  }
}

async function releaseMaintenanceLease(lease: MaintenanceLease) {
  if (!window.confirm("Release this stale usage lease? Confirm the owning process is no longer running.")) return;
  const response = await fetch(`/api/worktrees/${lease.worktreeId}/usages/${lease.id}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) maintenanceError.value = result.message ?? "Could not release the stale lease.";
  else {
    maintenanceMessage.value = "Stale usage lease released.";
    await loadMaintenance();
  }
}

const NAV_SECTIONS = ["projects", "agent-runs", "brainstorm", "worktrees", "usage-safety", "build", "reviews", "decisions", "maintenance", "usage-dashboard"];
const activeSection = ref(NAV_SECTIONS.includes(window.location.hash.slice(1)) ? window.location.hash.slice(1) : "projects");
function updateActiveSection() {
  const hash = window.location.hash.slice(1);
  if (NAV_SECTIONS.includes(hash)) activeSection.value = hash;
}

let sectionObserver: IntersectionObserver | null = null;
const intersectingSections = new Set<string>();
function pickActiveSectionFromScroll() {
  if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
    activeSection.value = NAV_SECTIONS[NAV_SECTIONS.length - 1]!;
    return;
  }
  for (const id of NAV_SECTIONS) {
    if (intersectingSections.has(id)) {
      activeSection.value = id;
      return;
    }
  }
}

onMounted(() => {
  window.addEventListener("hashchange", updateActiveSection);

  sectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) intersectingSections.add(entry.target.id);
        else intersectingSections.delete(entry.target.id);
      }
      pickActiveSectionFromScroll();
    },
    { rootMargin: "-96px 0px -70% 0px", threshold: 0 },
  );
  for (const id of NAV_SECTIONS) {
    const element = document.getElementById(id);
    if (element) sectionObserver.observe(element);
  }

  return Promise.all([loadHealth(), loadProjects(), loadAgentHealth(), loadTasks(), loadUsage(), loadMaintenance(), loadUsageDashboard(), loadUsageSettings()]);
});
onUnmounted(() => {
  eventSource?.close();
  if (taskPollTimer !== null) window.clearTimeout(taskPollTimer);
  if (buildPollTimer !== null) window.clearTimeout(buildPollTimer);
  if (experimentPollTimer !== null) window.clearTimeout(experimentPollTimer);
  window.removeEventListener("hashchange", updateActiveSection);
  sectionObserver?.disconnect();
});
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">AE</div>
        <div>
          <strong>AI Engineering</strong>
          <span>Workspace</span>
        </div>
      </div>

      <nav aria-label="Main navigation">
        <p class="nav-label">Workspace</p>
        <a :class="['nav-item', { active: activeSection === 'projects' }]" href="#projects" title="Step 1: tell the app which folder on your computer holds your code. It just looks, it doesn't change anything."><span>01</span>Projects</a>
        <a :class="['nav-item', { active: activeSection === 'agent-runs' }]" href="#agent-runs" title="Step 2: ask one AI (Claude or Codex) a single question about your project, just to try it out. It can only read and explain — it cannot change files."><span>02</span>Agent runs</a>
        <a :class="['nav-item', { active: activeSection === 'brainstorm' }]" href="#brainstorm" title="Step 3: give both Claude and Codex the same problem. Each thinks about it on its own, then they check each other's ideas, so you get two independent opinions instead of one."><span>03</span>Brainstorm</a>
        <a :class="['nav-item', { active: activeSection === 'worktrees' }]" href="#worktrees" title="Step 4: give each AI its own private copy of your code folder to work in, so they never bump into each other or mess up your main copy."><span>04</span>Worktrees</a>
        <a :class="['nav-item', { active: activeSection === 'usage-safety' }]" href="#usage-safety" title="Keeps track of how much of your Claude/Codex plan you've used, so a long task can't quietly burn through your whole monthly allowance without warning you."><span>05</span>Usage safety</a>
        <a :class="['nav-item', { active: activeSection === 'build' }]" href="#build" title="Step 5: let one AI actually write code in its own private folder, then have the other AI review that work before anything is merged."><span>06</span>Build</a>
        <a class="nav-item disabled" aria-disabled="true" title="Not built yet — this will be a dedicated place to browse past reviews. For now, reviews show up inside the Build tab."><span>07</span>Reviews</a>
        <a :class="['nav-item', { active: activeSection === 'decisions' }]" href="#decisions" title="Write down important decisions (like 'why did we choose X over Y') so you can look back and remember the reasoning later."><span>08</span>Decisions</a>
        <a :class="['nav-item', { active: activeSection === 'maintenance' }]" href="#maintenance" title="Back up or recover this app's local database, inspect cleanup warnings, and download an audit history."><span>09</span>Maintenance</a>
        <a :class="['nav-item', { active: activeSection === 'usage-dashboard' }]" href="#usage-dashboard" title="See how many tokens each provider, model, workflow, task, and run used, with clearly labeled API-equivalent cost estimates."><span>10</span>Usage &amp; cost</a>
      </nav>

      <div class="sidebar-foot" title="Everything you see runs on this computer only. Nothing is uploaded to a server or shared with anyone else.">
        <span class="local-dot" aria-hidden="true"></span>
        Local only
        <small>Nothing is deployed</small>
      </div>
    </aside>

    <main>
      <header class="topbar">
        <div>
          <p class="eyebrow">SYSTEM / PROJECTS</p>
          <h1>Engineering control room</h1>
        </div>
        <button class="ghost-button" type="button" @click="recheckTools" title="Ask the computer again whether Git, Claude, and Codex are installed and ready to use. Nothing is changed — this just refreshes the status lights below.">Recheck tools</button>
      </header>

      <section class="intro-grid" aria-labelledby="workspace-heading">
        <div class="intro-copy">
          <p class="section-index">01 — PROJECT REGISTRATION</p>
          <h2 id="workspace-heading">Bring a repository into a safer AI workflow.</h2>
          <p>
            Register a local Git project without changing it. This workspace will keep agent runs,
            evidence, and future worktrees isolated and auditable.
          </p>
        </div>
        <div class="readiness-card" title="A quick summary of whether Git, Claude, and Codex are all installed and working on this computer.">
          <span>Local readiness</span>
          <strong>{{ loading ? "Checking…" : `${connectedCount}/3 tools found` }}</strong>
          <p v-if="healthError" class="error-text">{{ healthError }}</p>
          <p v-else>Database {{ health?.database ?? "checking" }} · Web access asks first</p>
        </div>
      </section>

      <section class="tool-grid" aria-label="Local tool status">
        <article v-for="(tool, name) in health?.tools" :key="name" class="tool-card" :title="tool.available ? 'This tool is installed and the app can use it.' : 'This tool was not found on your computer, so features that need it will be disabled.'">
          <div>
            <span :class="['status-light', tool.available ? 'ok' : 'missing']" :title="tool.available ? 'Green = found and working' : 'Red = not found'"></span>
            <strong>{{ name === "claude" ? "Claude Code" : name === "codex" ? "Codex" : "Git" }}</strong>
          </div>
          <p>{{ tool.available ? tool.version : "Not available" }}</p>
          <small v-if="(name === 'codex' || name === 'claude') && tool.authenticated === true">Authenticated locally</small>
          <small v-else-if="(name === 'codex' || name === 'claude') && tool.available && tool.authenticated === false">Authentication required</small>
          <small v-else-if="name === 'claude' && !tool.available">Install before agent integration</small>
        </article>
        <article v-if="loading" v-for="index in 3" :key="`loading-${index}`" class="tool-card skeleton"></article>
      </section>

      <section id="projects" class="project-panel">
        <div class="panel-heading">
          <div>
            <p class="section-index">PROJECTS / LOCAL REPOSITORIES</p>
            <h2>Register a project</h2>
            <p>The repository is inspected read-only. No branch, worktree, or command is created or run.</p>
          </div>
          <span class="safety-badge" title="This step only looks at your files to gather information. It cannot edit, delete, or run anything in your project.">READ ONLY</span>
        </div>

        <form class="project-form" @submit.prevent="registerProject">
          <label title="The full folder path on your computer where your project's code already lives, e.g. /Users/you/Projects/example. This must be a folder that is already a Git repository.">
            <span>Repository path <strong>Required</strong></span>
            <input v-model="form.repositoryPath" required placeholder="/Users/you/Projects/example" autocomplete="off" />
          </label>
          <label title="A friendly name to show in this app's list of projects. If you leave it blank, the app just uses the folder's own name.">
            <span>Project name <small>Uses folder name when blank</small></span>
            <input v-model="form.name" placeholder="Example Web" autocomplete="off" />
          </label>
          <div class="field-row">
            <label title="The main branch of your project, like 'main' or 'master' — the branch everything else is usually compared against. Leave blank and the app will figure it out for you.">
              <span>Default branch <small>Auto-detect</small></span>
              <input v-model="form.defaultBranch" placeholder="main" autocomplete="off" />
            </label>
            <label title="A separate folder where the AI's private working copies (worktrees) will be created later, so they never touch your real project folder. Leave blank and the app will suggest one next to your project.">
              <span>Worktree root <small>Suggested when blank</small></span>
              <input v-model="form.worktreeRoot" placeholder="/Users/you/Projects/.ai-worktrees/example" autocomplete="off" />
            </label>
          </div>
          <label title="Optional notes to help the AI understand your project better next time — things like how it's structured, rules to follow, or areas it should be careful around.">
            <span>Project context <small>Optional guidance for future agent runs</small></span>
            <textarea v-model="form.projectContext" rows="3" placeholder="Architecture notes, conventions, important boundaries…"></textarea>
          </label>

          <fieldset title="Commands you normally run to check your code, like running tests or building the project. The app just remembers them here for later — it does not run them now.">
            <legend>Validation commands <small>Stored only; not run during registration</small></legend>
            <div class="command-grid">
              <label title="The command that runs your test suite, e.g. npm test."><span>Tests</span><input v-model="form.tests" placeholder="npm test" autocomplete="off" /></label>
              <label title="The command that checks your code style, e.g. npm run lint."><span>Lint</span><input v-model="form.lint" placeholder="npm run lint" autocomplete="off" /></label>
              <label title="The command that builds your project, e.g. npm run build."><span>Build</span><input v-model="form.build" placeholder="npm run build" autocomplete="off" /></label>
            </div>
          </fieldset>

          <p v-if="submitError" class="form-message error-text" role="alert">{{ submitError }}</p>
          <p v-if="successMessage" class="form-message success-text" role="status">{{ successMessage }}</p>
          <div class="form-actions">
            <span>Web access defaults to <b>Ask before use</b> for future tasks.</span>
            <button class="primary-button" type="submit" :disabled="submitting" title="Look at the folder you entered, check it's a valid Git project, and add it to your list below. This does not change any of your files.">
              {{ submitting ? "Inspecting…" : "Inspect & register" }}
            </button>
          </div>
        </form>
      </section>

      <section class="registered-section" aria-labelledby="registered-heading">
        <div class="registered-heading">
          <div>
            <p class="section-index">REGISTERED</p>
            <h2 id="registered-heading">Local projects</h2>
          </div>
          <span>{{ projects.length }} total</span>
        </div>

        <p v-if="projectActionMessage" class="form-message success-text project-list-message" role="status">{{ projectActionMessage }}</p>
        <p v-if="projectActionError && !editingProjectId" class="form-message error-text project-list-message" role="alert">{{ projectActionError }}</p>

        <div v-if="projectsLoading" class="empty-state">Loading registered projects…</div>
        <div v-else-if="projects.length === 0" class="empty-state">
          <strong>No projects registered yet.</strong>
          <span>Add a Git repository above. The source directory will remain untouched.</span>
        </div>
        <div v-else class="project-list">
          <article v-for="project in projects" :key="project.id" class="project-row">
            <div class="project-main">
              <div class="project-title-line">
                <strong>{{ project.name }}</strong>
                <span :class="['repo-state', project.gitStatus.toLowerCase()]" :title="project.gitStatus === 'CLEAN' ? 'CLEAN means there are no unsaved (uncommitted) changes in this project right now.' : 'DIRTY just means this project has some unsaved changes sitting in it — nothing is wrong, it is just a heads-up.'">{{ project.gitStatus }}</span>
              </div>
              <code>{{ project.repositoryPath }}</code>
              <p v-if="project.projectContext">{{ project.projectContext }}</p>
            </div>
            <dl>
              <div><dt title="The branch this project is sitting on right now.">Current branch</dt><dd>{{ project.currentBranch }}</dd></div>
              <div><dt title="The main branch other work is usually compared or merged against.">Default branch</dt><dd>{{ project.defaultBranch }}</dd></div>
              <div><dt title="How many test/lint/build commands you've saved for this project.">Checks saved</dt><dd>{{ project.validationCommands.length }}</dd></div>
            </dl>
            <div class="project-actions">
              <button class="ghost-button" type="button" @click="recheckProject(project)" title="Look at this project's Git status again and refresh the CLEAN/DIRTY label above.">Recheck Git</button>
              <button class="ghost-button" type="button" @click="editProject(project)" title="Change this project's saved details, like its name, branch, or test commands.">{{ editingProjectId === project.id ? "Editing" : "Edit" }}</button>
              <button class="text-button danger-button" type="button" :disabled="deletingProjectId === project.id" @click="deregisterProject(project)" title="Remove this project from the app's list. Your actual code folder on disk is not touched or deleted.">
                {{ deletingProjectId === project.id ? "Removing…" : "Deregister" }}
              </button>
            </div>

            <form v-if="editingProjectId === project.id" class="project-edit-form" @submit.prevent="saveProject(project)">
              <div class="field-row">
                <label><span>Project name</span><input v-model="editProjectForm.name" required /></label>
                <label><span>Repository path</span><input v-model="editProjectForm.repositoryPath" required autocomplete="off" /></label>
              </div>
              <div class="field-row">
                <label><span>Default branch</span><input v-model="editProjectForm.defaultBranch" required autocomplete="off" /></label>
                <label><span>Worktree root</span><input v-model="editProjectForm.worktreeRoot" required autocomplete="off" /></label>
              </div>
              <label><span>Project context</span><textarea v-model="editProjectForm.projectContext" rows="3"></textarea></label>
              <fieldset>
                <legend>Validation commands</legend>
                <div class="validation-command-list">
                  <div v-for="(command, index) in editProjectForm.validationCommands" :key="command.id" class="validation-command-row">
                    <label><span>Label</span><input v-model="command.label" required placeholder="Tests" /></label>
                    <label><span>Command</span><input v-model="command.command" required placeholder="npm test" /></label>
                    <button class="text-button danger-button" type="button" @click="editProjectForm.validationCommands.splice(index, 1)">Remove</button>
                  </div>
                </div>
                <button class="text-button" type="button" @click="addValidationCommand">+ Add command</button>
              </fieldset>
              <p v-if="projectActionError" class="form-message error-text" role="alert">{{ projectActionError }}</p>
              <div class="form-actions">
                <span>Saving re-inspects the repository but does not modify its files or Git state.</span>
                <div class="project-edit-actions">
                  <button class="ghost-button" type="button" @click="cancelProjectEdit">Cancel</button>
                  <button class="primary-button" type="submit" :disabled="savingProjectId === project.id">
                    {{ savingProjectId === project.id ? "Saving…" : "Save changes" }}
                  </button>
                </div>
              </div>
            </form>
          </article>
        </div>
      </section>

      <section id="agent-runs" class="project-panel agent-panel" aria-labelledby="agent-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">02 — READ-ONLY AGENT RUN</p>
            <h2 id="agent-heading">Ask an agent to explain a repository.</h2>
            <p>The run cannot edit files and web access is disabled. Starting it may use provider credits.</p>
          </div>
          <span class="safety-badge" title="This run can only read your files and explain them back to you. It cannot edit code, and it is not allowed to browse the internet.">READ ONLY · NO WEB</span>
        </div>

        <form class="project-form" @submit.prevent="startAgentRun">
          <div class="field-row">
            <label title="Pick which of your registered projects you want the AI to look at.">
              <span>Registered project</span>
              <select v-model="selectedProjectId" required>
                <option disabled value="">Select a project</option>
                <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
            </label>
            <label title="Choose which AI assistant answers this one: Codex (from OpenAI) or Claude Code (from Anthropic).">
              <span>Provider</span>
              <select v-model="selectedProvider">
                <option value="CODEX">Codex</option>
                <option value="CLAUDE">Claude Code</option>
              </select>
            </label>
          </div>
          <div class="provider-readiness" title="Shows whether this AI is installed and logged in on your computer. If it says not ready, you'll need to install or sign in to it first.">
            <span :class="['status-light', agentHealth[selectedProvider]?.authenticated ? 'ok' : 'missing']"></span>
            <strong>{{ selectedProvider === "CODEX" ? "Codex" : "Claude Code" }}</strong>
            <span v-if="agentHealth[selectedProvider]?.authenticated">Ready · {{ agentHealth[selectedProvider]?.cliVersion }}</span>
            <span v-else>{{ agentHealth[selectedProvider]?.message ?? "Provider is not ready." }}</span>
          </div>
          <label title="Type the question or task you want the AI to do. For example: 'Explain how login works in this app.'">
            <span>Prompt</span>
            <textarea v-model="agentPrompt" rows="4" required maxlength="20000"></textarea>
          </label>
          <div class="field-row">
            <label title="Which exact AI model to use, e.g. a specific Claude or GPT version. Most people should leave this blank — the AI tool's own default is used, and this app never forces a particular model.">
              <span>Model <small>Blank uses provider default</small></span>
              <input v-model="agentModel" placeholder="Provider default" autocomplete="off" />
            </label>
            <label title="How hard the AI should 'think' before answering — higher effort can give better answers but takes longer and may cost more usage. Only shown when the selected provider's CLI supports it.">
              <span>Effort <small>Optional</small></span>
              <select v-model="agentEffort">
                <option value="">Provider default</option>
                <option v-for="effort in agentHealth[selectedProvider]?.capabilities.availableEffortLevels ?? []" :key="effort" :value="effort">{{ effort }}</option>
              </select>
            </label>
          </div>
          <p v-if="runError" class="form-message error-text" role="alert">{{ runError }}</p>
          <div class="form-actions">
            <span>Nothing runs until you select this button. Output and run metadata are stored locally.</span>
            <button class="primary-button" type="submit" :disabled="startingRun || !selectedProjectId || !agentHealth[selectedProvider]?.authenticated" title="Send your prompt to the AI now. This uses a small amount of your Claude/Codex usage allowance.">
              {{ startingRun ? "Starting…" : "Run explanation" }}
            </button>
          </div>
        </form>

        <article v-if="currentRun" class="run-console" aria-live="polite">
          <div class="run-console-heading">
            <div><span title="QUEUED = waiting to start. RUNNING = the AI is working on it. COMPLETED = it finished. FAILED = something went wrong. CANCELLED = you stopped it.">RUN STATUS</span><strong>{{ currentRun.status }}</strong></div>
            <button v-if="['QUEUED', 'RUNNING'].includes(currentRun.status)" class="ghost-button" type="button" @click="cancelAgentRun" title="Stop this run early. Whatever the AI has already written stays as it is.">Cancel</button>
          </div>
          <pre v-if="currentRun.output">{{ currentRun.output }}</pre>
          <p v-else-if="['QUEUED', 'RUNNING'].includes(currentRun.status)">Waiting for agent output…</p>
          <p v-if="currentRun.errorMessage" class="error-text">{{ currentRun.errorMessage }}</p>
          <details v-if="currentRun.errorOutput"><summary>Process messages</summary><pre>{{ currentRun.errorOutput }}</pre></details>
          <small v-if="currentRun.durationMs !== null">Completed in {{ (currentRun.durationMs / 1000).toFixed(1) }}s</small>
          <small v-if="['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentRun.status)" title="Token counts this specific run actually reported, straight from the provider — never estimated. Unavailable means the CLI didn't report them for this run.">{{ usageLine(currentRun.usage) }}</small>
          <small
            v-if="['COMPLETED', 'FAILED', 'CANCELLED'].includes(currentRun.status)"
            title="API-equivalent cost applies published per-token API prices to this run's exact token counts. It is not what a subscription run charged you."
          >
            API-equivalent cost: {{ usageCostSettings?.showApiEquivalentCost === false ? 'hidden by settings' : currentRun.usage?.costSource === 'calculated' && currentRun.usage.apiEquivalentCostUsd !== null
              ? `${formatUsd(currentRun.usage.apiEquivalentCostUsd)} · CALCULATED`
              : 'unavailable' }}
          </small>
          <details v-if="usageCostSettings?.showApiEquivalentCost !== false && currentRun.usage?.costBreakdown" class="usage-cost-breakdown">
            <summary title="Show the token counts, price rates, and subtotals used to calculate this API-equivalent amount.">API-equivalent cost breakdown</summary>
            <p><strong>Model:</strong> {{ currentRun.usage.costBreakdown.model }}</p>
            <ul>
              <li v-for="item in currentRun.usage.costBreakdown.categories" :key="item.category">
                {{ costCategoryLabel(item.category) }}: {{ item.tokens.toLocaleString() }} tokens ×
                {{ formatUsd(item.pricePerMillion) }}/million = {{ formatUsd(item.subtotalUsd) }}
              </li>
            </ul>
            <p><strong>Total:</strong> {{ formatUsd(currentRun.usage.costBreakdown.totalUsd) }}</p>
            <p><strong>Pricing version:</strong> effective {{ new Date(currentRun.usage.costBreakdown.pricingEffectiveFrom).toLocaleString() }}</p>
            <p><strong>Source:</strong> {{ currentRun.usage.costBreakdown.pricingSource }}</p>
          </details>
          <div
            v-if="currentRun.status === 'FAILED' && worstUsageStatus(currentRun.provider) !== 'EXHAUSTED'"
            :class="['exhausted-hint', { likely: currentRunUsageHint }]"
          >
            <span v-if="currentRunUsageHint" class="hint-badge">LOOKS LIKE A USAGE LIMIT</span>
            <p>
              {{ currentRunUsageHint
                ? `This failure's wording suggests ${providerLabel(currentRun.provider)} may have hit its usage limit — the workspace could not confirm that automatically.`
                : `Did this fail because ${providerLabel(currentRun.provider)} hit its usage limit? The workspace could not tell automatically.` }}
            </p>
            <button class="ghost-button" type="button" @click="markProviderExhausted(currentRun.provider)" title="Tell the app 'yes, this AI really is out of usage for now.' This helps the Usage safety page warn you correctly, since the app can't always detect this on its own.">Mark as exhausted</button>
          </div>
        </article>
      </section>

      <section id="brainstorm" class="project-panel brainstorm-panel" aria-labelledby="brainstorm-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">03 — INDEPENDENT BRAINSTORMING</p>
            <h2 id="brainstorm-heading">Turn disagreement into an engineering artifact.</h2>
            <p>Claude and Codex analyze independently, review each other only afterward, and remain read-only throughout.</p>
          </div>
          <span class="safety-badge" title="Starting this uses 4 separate AI runs (2 analyses + 2 reviews), and every one of them can only read your code, never edit it.">4 RUNS · READ ONLY</span>
        </div>

        <form class="project-form" @submit.prevent="createTask">
          <div class="field-row task-first-row">
            <label title="Which project this question or problem belongs to.">
              <span>Registered project</span>
              <select v-model="taskForm.projectId" required>
                <option disabled value="">Select a project</option>
                <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
            </label>
            <label title="A short name for this brainstorming task, so you can find it again in the list on the left.">
              <span>Task title</span>
              <input v-model="taskForm.title" maxlength="160" required autocomplete="off" />
            </label>
          </div>
          <div class="field-row">
            <label title="Brainstorm = a general 'what should we do?' discussion. Architecture = a bigger structural/design decision, like changing how the database works.">
              <span>Task type</span>
              <select v-model="taskForm.type">
                <option value="BRAINSTORM">Brainstorm</option>
                <option value="ARCHITECTURE">Architecture</option>
              </select>
            </label>
            <label title="How big a deal is this if it goes wrong? Low = minor, Critical = could seriously break things. This is just a label for you — it doesn't change what the AI does.">
              <span>Risk level</span>
              <select v-model="taskForm.riskLevel">
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </label>
          </div>
          <label title="Describe, in your own words, the question or problem you want Claude and Codex to think about.">
            <span>Problem statement</span>
            <textarea v-model="taskForm.problemStatement" rows="5" maxlength="20000" required></textarea>
          </label>

          <label title="Choose how many model runs and review rounds this task should be allowed before the app pauses for your decision. You can fine-tune it after creating the draft.">
            <span>Usage budget</span>
            <select v-model="taskForm.budgetPreset" title="Balanced is the workspace default. No budget still keeps the provider-plan safety checks active.">
              <option value="NONE">No task budget</option>
              <option value="ECONOMY">Economy</option>
              <option value="BALANCED">Balanced</option>
              <option value="DEEP">Deep</option>
            </select>
          </label>

          <fieldset class="web-decision" title="Decide once, before you start, whether the AIs are allowed to search the internet for this task. You must pick one — it can't be changed after you start.">
            <legend>Web access <small>Required decision · recorded with this task</small></legend>
            <div class="choice-grid">
              <label :class="['choice-card', { selected: !taskForm.webAccessPermitted }]" title="The AIs will only use your project's own code and whatever you typed above — no internet searches.">
                <input v-model="taskForm.webAccessPermitted" class="radio-input" type="radio" :value="false" />
                <span><strong>No web access</strong><small>Use only the registered repository and supplied context.</small></span>
              </label>
              <label :class="['choice-card', { selected: taskForm.webAccessPermitted }]" title="The AIs are allowed to search the web for this task only — for example, to look up documentation or best practices.">
                <input v-model="taskForm.webAccessPermitted" class="radio-input" type="radio" :value="true" />
                <span><strong>Allow for this task</strong><small>Both agents may use their built-in web tools for this task only.</small></span>
              </label>
            </div>
          </fieldset>

          <p v-if="taskError" class="form-message error-text" role="alert">{{ taskError }}</p>
          <p v-if="taskMessage" class="form-message success-text" role="status">{{ taskMessage }}</p>
          <div class="form-actions">
            <span>Creating a draft is free. Provider usage begins only when you start the analysis.</span>
            <button class="primary-button" type="submit" :disabled="creatingTask || !taskForm.projectId" title="Save this task as a Draft. This is free and doesn't use any AI usage yet — the AI only starts working once you press 'Start independent analyses' later.">
              {{ creatingTask ? "Creating…" : "Create draft" }}
            </button>
          </div>
        </form>

        <div class="task-workspace">
          <aside class="task-list" aria-label="Brainstorm tasks">
            <div class="task-list-heading"><strong>Tasks</strong><span>{{ tasks.length }}</span></div>
            <p v-if="tasksLoading">Loading tasks…</p>
            <p v-else-if="tasks.length === 0">No brainstorming tasks yet.</p>
            <button
              v-for="task in tasks"
              v-else
              :key="task.id"
              :class="['task-list-item', { selected: selectedTask?.id === task.id }]"
              type="button"
              @click="selectTask(task.id)"
            >
              <span>{{ task.type }}</span>
              <strong>{{ task.title }}</strong>
              <small title="Where this task currently is: DRAFT (not started), ANALYZING (AIs are thinking), CROSS_REVIEW (AIs are checking each other), READY (done), CHECKPOINTED (paused, waiting on you), FAILED/CANCELLED.">{{ task.status }}</small>
              <small v-if="task.openQuestionCount" class="open-question-badge" title="Questions the AIs raised that nobody has answered yet — worth a look before you make a final decision.">
                {{ task.openQuestionCount }} open question{{ task.openQuestionCount === 1 ? "" : "s" }}
              </small>
            </button>
          </aside>

          <div v-if="selectedTask" class="task-detail">
            <div class="task-detail-heading">
              <div>
                <span>{{ selectedTask.type }} · {{ selectedTask.riskLevel }} RISK</span>
                <h3>{{ selectedTask.title }}</h3>
                <p>{{ selectedTask.problemStatement }}</p>
              </div>
              <div class="task-detail-actions">
                <span :class="['task-status', selectedTask.status.toLowerCase()]" title="Where this task currently is in its workflow — see the four steps below for what each stage means.">{{ selectedTask.status }}</span>
                <button class="text-button danger-button" type="button" :disabled="deletingTaskId === selectedTask.id" @click="deleteTask" title="Permanently remove this task and its local history. Active AI runs and managed worktrees must be stopped or cleaned up first; your Git repository is never deleted.">
                  {{ deletingTaskId === selectedTask.id ? "Deleting…" : "Delete task" }}
                </button>
              </div>
            </div>

            <p v-if="taskRefreshError" class="form-message error-text" role="status">{{ taskRefreshError }}</p>

            <div class="stage-track" aria-label="Workflow stages">
              <div :class="{ current: selectedTask.status === 'DRAFT', complete: selectedTask.status !== 'DRAFT' }" title="You've written the problem down, but the AIs haven't started thinking about it yet."><span>01</span><strong>Draft</strong></div>
              <div :class="{ current: selectedTask.status === 'ANALYZING', complete: ['CROSS_REVIEW', 'READY'].includes(selectedTask.status) }" title="Claude and Codex are each thinking about the problem separately, without seeing each other's answers yet."><span>02</span><strong>Independent</strong></div>
              <div :class="{ current: selectedTask.status === 'CROSS_REVIEW', complete: selectedTask.status === 'READY' }" title="Now each AI reads the other's answer and points out anything it disagrees with or thinks is missing."><span>03</span><strong>Cross-review</strong></div>
              <div :class="{ current: selectedTask.status === 'READY', complete: selectedTask.status === 'READY' }" title="Everything is done. You can see both answers side by side and decide for yourself — the app never picks a winner for you."><span>04</span><strong>Compare</strong></div>
            </div>

            <div class="task-usage-card" title="All recorded provider usage for this task, including its independent analysis, cross-review, experiments, implementation, and review runs.">
              <div class="subsection-heading"><span>TASK USAGE</span><strong>ALL TIME</strong></div>
              <p v-if="selectedTaskUsageLoading" class="form-hint">Loading this task's usage…</p>
              <template v-else-if="selectedTaskUsage">
                <div class="task-usage-summary">
                  <div><span>Runs</span><strong>{{ selectedTaskUsage.summary.runs.toLocaleString() }}</strong></div>
                  <div><span>Tokens</span><strong>{{ selectedTaskUsage.summary.totalTokens.toLocaleString() }}</strong></div>
                  <div><span>API-equivalent cost</span><strong>{{ formatAggregateCost(selectedTaskUsage.summary.apiEquivalentCostUsd, selectedTaskUsage.summary.calculatedCostRuns) }}</strong></div>
                  <div><span>Review rounds</span><strong>{{ selectedTaskUsage.taskReviewRounds ? `${selectedTaskUsage.taskReviewRounds.current}/${selectedTaskUsage.taskReviewRounds.maximum}` : "None" }}</strong></div>
                </div>
                <div v-if="selectedTaskUsage.byWorkflow.length" class="task-usage-workflows">
                  <span v-for="row in selectedTaskUsage.byWorkflow" :key="row.key">{{ row.label }} · {{ row.tokens.toLocaleString() }} tokens · {{ formatAggregateCost(row.apiEquivalentCostUsd, row.calculatedCostRuns) }}<template v-if="row.unavailableCostRuns"> · {{ row.unavailableCostRuns }} cost unavailable</template></span>
                </div>
                <small>Cost is a calculated API-equivalent estimate. Subscription charges are not inferred. {{ selectedTaskUsage.summary.unavailableCostRuns }} run(s) have no matching price.</small>
              </template>
            </div>

            <div v-if="selectedTaskBudget" class="task-budget-card">
              <div class="subsection-heading"><span>TASK BUDGET</span><strong>{{ selectedTaskBudget.budget.state }} · {{ selectedTaskBudget.budget.preset }}</strong></div>
              <div class="task-usage-summary">
                <div><span>Agent runs</span><strong>{{ selectedTaskBudget.progress.agentRuns }}<template v-if="selectedTaskBudget.budget.maxAgentRuns !== null">/{{ selectedTaskBudget.budget.maxAgentRuns }}</template></strong></div>
                <div><span>Tokens</span><strong>{{ selectedTaskBudget.progress.totalTokens.toLocaleString() }}<template v-if="selectedTaskBudget.budget.maxTokens !== null">/{{ selectedTaskBudget.budget.maxTokens.toLocaleString() }}</template></strong></div>
                <div><span>API-equivalent cost</span><strong>{{ usageCostSettings?.showApiEquivalentCost === false ? "Hidden" : formatUsd(selectedTaskBudget.progress.apiEquivalentCostUsd) }}<template v-if="usageCostSettings?.showApiEquivalentCost !== false && selectedTaskBudget.budget.apiEquivalentCostWarningUsd !== null"> / {{ formatUsd(selectedTaskBudget.budget.apiEquivalentCostWarningUsd) }}</template></strong></div>
                <div><span>Utilization</span><strong>{{ selectedTaskBudget.progress.utilizationPercent.toFixed(0) }}%</strong></div>
              </div>
              <p v-if="selectedTaskBudget.budget.checkpointReason" class="form-message error-text" role="alert">{{ selectedTaskBudget.budget.checkpointReason }}</p>
              <form class="budget-form" @submit.prevent="saveTaskBudget">
                <label title="Use a named preset, remove the task budget, or enter exact custom limits."><span>Preset</span><select v-model="taskBudgetForm.preset" title="Changing a budget never erases usage already recorded for this task."><option value="NONE">No budget</option><option value="ECONOMY">Economy</option><option value="BALANCED">Balanced</option><option value="DEEP">Deep</option><option value="CUSTOM">Custom</option></select></label>
                <template v-if="taskBudgetForm.preset === 'CUSTOM'">
                  <label title="Pause before the next model run once the task has recorded this many tokens. Leave blank for no token limit."><span>Maximum tokens</span><input v-model="taskBudgetForm.maxTokens" type="number" min="1" max="10000000000" title="Enter a positive whole-number token limit, or leave it blank." /></label>
                  <label title="Pause before the next model run once calculated API-equivalent cost reaches this amount. Missing pricing also causes an honest checkpoint."><span>Cost warning (USD)</span><input v-model="taskBudgetForm.apiEquivalentCostWarningUsd" type="number" min="0.000001" step="0.000001" title="Enter an API-equivalent cost limit, or leave it blank." /></label>
                  <label title="Pause before starting a model run once this many task-linked runs already exist."><span>Maximum agent runs</span><input v-model="taskBudgetForm.maxAgentRuns" type="number" min="1" max="1000" title="Enter a positive whole-number model-run limit, or leave it blank." /></label>
                  <label title="Cap build/review loops for this task. This does not interrupt a round already in progress."><span>Maximum review rounds</span><input v-model="taskBudgetForm.maxReviewRounds" type="number" min="1" max="10" title="Enter a review-round cap from 1 to 10, or leave it blank." /></label>
                  <label title="Show a warning once the most-used configured limit reaches this percentage."><span>Warning at %</span><input v-model="taskBudgetForm.warningPercent" type="number" min="1" max="99" title="Choose a warning percentage from 1 to 99." /></label>
                </template>
                <button class="text-button" type="submit" :disabled="taskBudgetSaving" title="Save this task's resolved budget. Existing usage continues to count.">{{ taskBudgetSaving ? "Saving…" : "Save task budget" }}</button>
              </form>
              <div v-if="selectedTaskBudget.budget.state === 'CHECKPOINTED'" class="provider-pair">
                <button class="ghost-button" type="button" :disabled="taskBudgetSaving" @click="decideTaskBudget('STOP_AND_SUMMARIZE')" title="Stop all further model calls for this task. Existing results and the usage summary are kept.">Stop &amp; Summarize</button>
                <button class="danger-outline-button" type="button" :disabled="taskBudgetSaving" @click="decideTaskBudget('CONTINUE_ONE_RUN')" title="Allow exactly one more model call, then evaluate the budget again before anything else runs.">Continue One Run</button>
              </div>
              <p v-if="taskBudgetError" class="form-message error-text" role="alert">{{ taskBudgetError }}</p>
              <p v-if="taskBudgetMessage" class="form-message success-text" role="status">{{ taskBudgetMessage }}</p>
              <small>Budgets never interrupt a model mid-run. Provider-plan safety remains separate and can still pause a task sooner.</small>
            </div>

            <div v-if="usageBlockedDecision" class="usage-checkpoint-block" role="alert" title="The app paused here to make sure you don't accidentally run out of your Claude/Codex plan without knowing.">
              <span>USAGE SAFETY CHECKPOINT</span>
              <strong>{{ usageBlockedDecision.provider === 'CLAUDE' ? 'Claude Code' : 'Codex' }} · {{ usageStatusLabel(usageBlockedDecision.status) }}</strong>
              <p>{{ usageBlockedDecision.reason }}</p>
              <button
                v-if="usageBlockedDecision.requiresAcknowledgement"
                class="danger-outline-button" type="button"
                :disabled="acknowledging"
                @click="acknowledgeUsageAndRetryStart"
                title="Confirm 'yes, I understand the usage situation, please continue anyway.' This is a human decision the app will never make for you automatically."
              >{{ acknowledging ? "Acknowledging…" : "Acknowledge and continue" }}</button>
              <p v-else class="form-hint">A reliably exhausted provider cannot be overridden. Wait for reset, or record a fresh reading once capacity is confirmed.</p>
            </div>

            <div class="web-audit" title="A permanent record of the web-access choice you made when you created this task. It cannot be changed afterward, so you always know whether the AI was allowed online.">
              <span>WEB DECISION</span>
              <strong>{{ selectedTask.webAccessPermitted ? "Allowed for this task" : "Disabled" }}</strong>
              <small>Recorded {{ new Date(selectedTask.webAccessDecidedAt).toLocaleString() }}</small>
            </div>

            <div v-if="selectedTask.status === 'DRAFT'" class="launch-box">
              <div class="field-row">
                <label title="Leave blank to use the Claude Code CLI's own default model — this app never hardcodes a specific model string."><span>Claude model <small>Blank uses default</small></span><input v-model="taskForm.claudeModel" placeholder="Provider default" /></label>
                <label title="Leave blank to use the Codex CLI's own default model — this app never hardcodes a specific model string."><span>Codex model <small>Blank uses default</small></span><input v-model="taskForm.codexModel" placeholder="Provider default" /></label>
              </div>
              <label title="Reasoning effort level, passed to the Claude Code CLI's --effort flag. Codex has no equivalent option in its CLI, so there is no effort control for it.">
                <span>Claude effort <small>Optional</small></span>
                <select v-model="taskForm.claudeEffort">
                  <option value="">Provider default</option>
                  <option v-for="effort in agentHealth.CLAUDE?.capabilities.availableEffortLevels ?? []" :key="effort" :value="effort">{{ effort }}</option>
                </select>
              </label>
              <div class="provider-pair" title="Both Claude and Codex must be installed and signed in before you can start — this row shows whether each one is ready.">
                <span><i :class="['status-light', agentHealth.CLAUDE?.authenticated ? 'ok' : 'missing']"></i>Claude {{ agentHealth.CLAUDE?.authenticated ? "ready" : "not ready" }}</span>
                <span><i :class="['status-light', agentHealth.CODEX?.authenticated ? 'ok' : 'missing']"></i>Codex {{ agentHealth.CODEX?.authenticated ? "ready" : "not ready" }}</span>
              </div>
              <p class="usage-preflight-note" title="A last check of how much of your Claude/Codex allowance is left, shown before you commit to spending any of it.">
                <strong>Before you spend usage:</strong>
                Claude is <em>{{ usageStatusLabel(worstUsageStatus('CLAUDE')) }}</em>,
                Codex is <em>{{ usageStatusLabel(worstUsageStatus('CODEX')) }}</em>.
                Starting spends usage for both providers across up to four runs.
              </p>
              <button
                class="primary-button"
                type="button"
                :disabled="startingTask || !agentHealth.CLAUDE?.authenticated || !agentHealth.CODEX?.authenticated"
                @click="startBrainstorm"
                title="Kick off the whole brainstorm: both AIs think independently, then review each other. This will use real Claude/Codex usage — up to 4 separate runs."
              >{{ startingTask ? "Starting…" : "Start independent analyses" }}</button>
              <small>This deliberately starts up to four paid/provider runs: two analyses followed by two reviews.</small>
            </div>

            <div v-if="['ANALYZING', 'CROSS_REVIEW'].includes(selectedTask.status)" class="live-stages">
              <div title="Claude is writing its own independent answer to the problem."><span>Claude analysis</span><strong>{{ runStatus('CLAUDE', 'INDEPENDENT_ANALYSIS') }}</strong></div>
              <div title="Codex is writing its own independent answer to the problem."><span>Codex analysis</span><strong>{{ runStatus('CODEX', 'INDEPENDENT_ANALYSIS') }}</strong></div>
              <div title="Claude is reading Codex's answer and pointing out anything it disagrees with or thinks is missing."><span>Claude review</span><strong>{{ runStatus('CLAUDE', 'CROSS_REVIEW') }}</strong></div>
              <div title="Codex is reading Claude's answer and pointing out anything it disagrees with or thinks is missing."><span>Codex review</span><strong>{{ runStatus('CODEX', 'CROSS_REVIEW') }}</strong></div>
              <button class="ghost-button" type="button" @click="cancelBrainstorm" title="Stop this brainstorm now. Any analysis already finished is kept; anything still running is stopped.">Cancel workflow</button>
            </div>

            <div v-if="selectedTask.status === 'CHECKPOINTED'" class="live-stages checkpointed" title="The workflow paused itself so it wouldn't spend more usage without your say-so. Nothing already finished is lost.">
              <p>
                This workflow paused at a provider-safety or task-budget checkpoint rather than continuing blind. Everything
                completed so far is saved. Resolve the checkpoint above, then resume — nothing already completed is re-run.
              </p>
              <div class="provider-pair">
                <button class="primary-button" type="button" :disabled="startingTask" @click="resumeBrainstorm" title="Pick up right where the brainstorm paused — steps already completed are not repeated.">
                  {{ startingTask ? "Resuming…" : "Resume workflow" }}
                </button>
                <button class="ghost-button" type="button" @click="cancelBrainstorm" title="Give up on this brainstorm instead of resuming it.">Cancel workflow</button>
              </div>
            </div>
            <p v-if="selectedTask.errorMessage" class="form-message error-text">{{ selectedTask.errorMessage }}</p>
            <div
              v-for="entry in failedProviders(selectedTask)" :key="entry.provider"
              :class="['exhausted-hint', { likely: entry.hint }]"
              title="The app noticed one of the AI runs failed, and it's guessing (from the error wording) whether that's because the provider ran out of usage."
            >
              <span v-if="entry.hint" class="hint-badge">LOOKS LIKE A USAGE LIMIT</span>
              <p>
                {{ entry.hint
                  ? `This failure's wording suggests ${providerLabel(entry.provider)} may have hit its usage limit — the workspace could not confirm that automatically.`
                  : `Did ${providerLabel(entry.provider)} fail because it hit its usage limit? The workspace could not tell automatically.` }}
              </p>
              <button class="ghost-button" type="button" @click="markProviderExhausted(entry.provider)" title="Confirm that yes, this really was a usage limit, so the Usage safety page reflects it correctly.">Mark as exhausted</button>
            </div>

            <details v-if="analysisFor('CLAUDE') || analysisFor('CODEX')" class="analysis-section result-section" :open="selectedTask.status !== 'READY'">
              <summary class="subsection-heading" title="Open or close each AI's independent answer. These start collapsed when analysis is complete so the finished task stays easy to navigate."><span>INDEPENDENT OUTPUTS</span><strong>Kept separate until both completed</strong></summary>
              <div class="analysis-grid">
                <article v-for="provider in (['CLAUDE', 'CODEX'] as AgentProvider[])" :key="provider" class="analysis-card">
                  <header><span>{{ provider === 'CLAUDE' ? 'Claude' : 'Codex' }}</span><small>{{ runStatus(provider, 'INDEPENDENT_ANALYSIS') }}</small></header>
                  <template v-if="analysisFor(provider)">
                    <p>{{ analysisFor(provider)?.summary }}</p>
                    <h4>Options</h4>
                    <div v-for="option in analysisFor(provider)?.options" :key="option.name" class="option-block">
                      <strong>{{ option.name }}</strong><p>{{ option.description }}</p>
                      <small>{{ option.advantages.length }} advantages · {{ option.disadvantages.length }} disadvantages · {{ option.risks.length }} risks</small>
                    </div>
                    <h4>Recommendation</h4><p>{{ analysisFor(provider)?.recommendation ?? "No recommendation yet." }}</p>
                  </template>
                  <details v-if="selectedTask.artifacts?.find((item) => item.kind === 'ANALYSIS' && item.provider === provider)">
                    <summary>Raw response</summary>
                    <pre>{{ selectedTask.artifacts?.find((item) => item.kind === 'ANALYSIS' && item.provider === provider)?.rawOutput }}</pre>
                  </details>
                </article>
              </div>
            </details>

            <details v-if="reviewFor('CLAUDE') || reviewFor('CODEX')" class="review-section result-section" :open="selectedTask.status !== 'READY'">
              <summary class="subsection-heading" title="Open or close the reviews where each AI checks the other's answer. These start collapsed when analysis is complete."><span>RECIPROCAL REVIEWS</span><strong>Each reviews the other</strong></summary>
              <div class="analysis-grid">
                <article v-for="provider in (['CLAUDE', 'CODEX'] as AgentProvider[])" :key="provider" class="review-card">
                  <header><span>{{ provider === 'CLAUDE' ? 'Claude critiques Codex' : 'Codex critiques Claude' }}</span></header>
                  <p>{{ reviewFor(provider)?.summary }}</p>
                  <h4>Disagreements</h4>
                  <ul><li v-for="item in reviewFor(provider)?.disagreements" :key="item">{{ item }}</li></ul>
                  <h4>Missing evidence</h4>
                  <ul><li v-for="item in reviewFor(provider)?.missingEvidence" :key="item">{{ item }}</li></ul>
                </article>
              </div>
            </details>

            <details v-if="selectedTask.comparison" class="comparison-section result-section" :open="selectedTask.status !== 'READY'">
              <summary class="subsection-heading" title="Open or close the side-by-side summary of agreements, disagreements, and open questions. The app does not pick a winner for you."><span>TRANSPARENT COMPARISON</span><strong>{{ (selectedTask.comparisonHistory?.length ?? 1) > 1 ? `Version ${selectedTask.comparisonHistory!.length} of ${selectedTask.comparisonHistory!.length} · No automatic winner` : "No automatic winner" }}</strong></summary>
              <div class="comparison-grid">
                <article v-for="(items, label) in selectedTask.comparison" :key="label">
                  <h4>{{ String(label).replace(/([A-Z])/g, ' $1') }}</h4>
                  <ul v-if="items.length"><li v-for="item in items" :key="item">{{ item }}</li></ul>
                  <p v-else>No item was asserted by the structured reviews.</p>
                </article>
              </div>
              <div class="question-actions">
                <button
                  v-if="canReviseWithAnswers"
                  type="button"
                  class="ghost-button"
                  :disabled="startingTask"
                  @click="reviseBrainstormPlan"
                  title="Ask both AIs to redo their analysis and cross-review with the answers you've saved so far folded in. This starts two new provider runs and keeps this version of the plan on record — it never overwrites it."
                >Revise plan with answers</button>
                <small v-else-if="selectedTask.status === 'READY'" class="form-hint" title="Answer at least one open question above before the plan can be revised.">Answer a question to enable revising this plan.</small>
              </div>
              <details v-if="(selectedTask.comparisonHistory?.length ?? 0) > 1" class="question-history">
                <summary title="Every earlier version of this plan, kept on record rather than overwritten.">{{ selectedTask.comparisonHistory!.length - 1 }} earlier version(s)</summary>
                <div class="comparison-grid" v-for="version in [...selectedTask.comparisonHistory!].reverse().slice(1)" :key="version.id">
                  <p class="form-hint comparison-version-label">Version {{ version.version }} · generated {{ new Date(version.generatedAt).toLocaleString() }}</p>
                  <article v-for="(items, label) in version.content" :key="label">
                    <h4>{{ String(label).replace(/([A-Z])/g, ' $1') }}</h4>
                    <ul v-if="items.length"><li v-for="item in items" :key="item">{{ item }}</li></ul>
                    <p v-else>No item was asserted by the structured reviews.</p>
                  </article>
                </div>
              </details>
            </details>

            <div class="evidence-board">
              <div class="subsection-heading" title="A running list of facts, guesses, open questions, and decisions about this task — written by you or pulled from what the AIs found."><span>ASSUMPTION / EVIDENCE BOARD</span><strong>{{ selectedTask.evidence?.length ?? 0 }} records</strong></div>
              <form class="evidence-form" @submit.prevent="addEvidence">
                <select v-model="evidenceType" title="What kind of note this is: a known Fact, a Guess/Assumption you're making, an open Question, a Decision you've made, or a result from an Experiment.">
                  <option value="FACT">Fact</option><option value="ASSUMPTION">Assumption</option>
                  <option value="QUESTION">Question</option><option value="DECISION">Decision</option>
                  <option value="EXPERIMENT_RESULT">Experiment result</option>
                </select>
                <input v-model="evidenceContent" maxlength="5000" placeholder="Add a human correction, fact, question, decision, or experiment result…" />
                <button class="ghost-button" type="submit" title="Save this note to the board so it's kept alongside the task for later.">Add record</button>
              </form>

              <div v-if="allQuestions.length" class="question-board">
                <div class="subsection-heading" title="Every question an AI raised (or a human added), each with its own status so you can track what still needs an answer."><span>QUESTIONS</span><strong>{{ allQuestions.length }} total</strong></div>
                <p v-if="questionActionError" class="error-text" role="alert">{{ questionActionError }}</p>
                <div class="question-filters" role="tablist" aria-label="Filter questions by status">
                  <button type="button" class="text-button" :class="{ active: questionFilter === 'OPEN' }" @click="questionFilter = 'OPEN'" title="Show only questions nobody has resolved yet.">Open</button>
                  <button type="button" class="text-button" :class="{ active: questionFilter === 'ANSWERED' }" @click="questionFilter = 'ANSWERED'" title="Show only questions that already have a saved answer.">Answered</button>
                  <button type="button" class="text-button" :class="{ active: questionFilter === 'DEFERRED' }" @click="questionFilter = 'DEFERRED'" title="Show only questions put off for later.">Deferred</button>
                  <button type="button" class="text-button" :class="{ active: questionFilter === 'DUPLICATE' }" @click="questionFilter = 'DUPLICATE'" title="Show only questions confirmed as a duplicate of another one.">Duplicates</button>
                  <button type="button" class="text-button" :class="{ active: questionFilter === 'ALL' }" @click="questionFilter = 'ALL'" title="Show every question regardless of status, including ones marked not applicable.">All records</button>
                </div>

                <div class="question-duplicate-controls">
                  <button type="button" class="text-button" :disabled="groupingExactDuplicates" @click="groupExactDuplicates" title="Free and instant: automatically merges any open questions that are worded almost identically (case, spacing, and punctuation aside). Does not use any AI provider.">
                    {{ groupingExactDuplicates ? "Grouping…" : "Group exact duplicates" }}
                  </button>
                  <select v-model="duplicateDetectionProvider" title="Which AI should look for questions asking the same thing in different words.">
                    <option value="CLAUDE">Claude</option>
                    <option value="CODEX">Codex</option>
                  </select>
                  <button type="button" class="text-button" :disabled="detectingDuplicates" @click="detectPossibleDuplicates" title="Ask the selected AI to find open questions that ask substantively the same thing even when worded differently. This spends a small amount of that provider's usage; nothing is grouped until you confirm each suggestion.">
                    {{ detectingDuplicates ? "Scanning…" : "Find possible duplicates (AI)" }}
                  </button>
                </div>
                <p v-if="duplicateDetectionError" class="error-text" role="alert">{{ duplicateDetectionError }}</p>

                <div v-if="questionsMissingSuggestions.length" class="question-suggestion-controls">
                  <select v-model="suggestionProvider" title="Which AI should write the missing why-it-matters / suggested-action content for older questions.">
                    <option value="CLAUDE">Claude</option>
                    <option value="CODEX">Codex</option>
                  </select>
                  <button type="button" class="text-button" :disabled="generatingSuggestions" @click="generateQuestionSuggestions" title="Ask the selected AI to write why-it-matters, a suggested next step, and candidate answers for open questions that don't have them yet — usually older questions raised before this feature existed. This spends a small amount of that provider's usage and only produces a preview; nothing is saved until you accept it.">
                    {{ generatingSuggestions ? "Generating…" : `Generate missing suggestions (${questionsMissingSuggestions.length})` }}
                  </button>
                </div>
                <p v-if="suggestionError" class="error-text" role="alert">{{ suggestionError }}</p>

                <div v-if="suggestionPreview.length" class="question-suggestion-preview">
                  <div class="question-actions">
                    <strong>{{ suggestionPreview.length }} suggestion(s) awaiting review</strong>
                    <button type="button" class="ghost-button" :disabled="acceptingSuggestions" @click="acceptSuggestions(suggestionPreview)" title="Save every suggestion below into its question exactly as shown, including any edits you've made.">Accept all</button>
                  </div>
                  <article v-for="draft in suggestionPreview" :key="draft.questionId" class="question-card">
                    <p class="question-text">{{ questionContentById(draft.questionId) }}</p>
                    <label title="How urgently this needs an answer before the plan can safely proceed.">
                      <span>Priority</span>
                      <select v-model="draft.priority">
                        <option value="BLOCKING">Blocking</option>
                        <option value="HIGH">High</option>
                        <option value="MEDIUM">Medium</option>
                        <option value="LOW">Low</option>
                      </select>
                    </label>
                    <label title="Why answering this question actually matters for the plan."><span>Why it matters</span><textarea v-model="draft.whyItMatters" rows="2" maxlength="5000"></textarea></label>
                    <label title="A concrete next step a human could take to find the answer."><span>Suggested action</span><textarea v-model="draft.suggestedAction" rows="2" maxlength="5000"></textarea></label>
                    <label title="What evidence would actually answer this — one per line."><span>Evidence needed (one per line)</span><textarea v-model="draft.expectedEvidenceText" rows="2"></textarea></label>
                    <label title="Candidate answers a human could pick from as a starting point — one per line, or leave blank."><span>Suggested answers (one per line)</span><textarea v-model="draft.suggestedAnswersText" rows="2"></textarea></label>
                    <div class="question-actions">
                      <button type="button" class="ghost-button" :disabled="acceptingSuggestions" @click="acceptSuggestions([draft])" title="Save this suggestion into this question exactly as shown above, including any edits you've made.">Accept</button>
                      <button type="button" class="text-button" @click="discardSuggestion(draft.questionId)" title="Don't save this suggestion — it's only removed from this preview, nothing about the question changes.">Discard</button>
                    </div>
                  </article>
                </div>

                <div class="question-list">
                  <article v-for="item in filteredQuestions" :key="item.id" class="question-card">
                    <div class="question-card-heading">
                      <span :class="['question-status', (questionDetailFor(item)?.status ?? 'OPEN').toLowerCase()]" title="OPEN = still needs a human decision. ANSWERED = resolved with a saved answer. DEFERRED = put off for later. NOT_APPLICABLE = no longer relevant. DUPLICATE = merged into another question.">{{ questionDetailFor(item)?.status ?? "OPEN" }}</span>
                      <small :title="item.sourceProvider ? 'This question came from one of the AI runs, not typed by a person.' : 'This question was typed in by a human, not the AI.'">{{ item.sourceProvider ? `From ${item.sourceProvider}` : "Human record" }}</small>
                    </div>
                    <p class="question-text">{{ item.content }}</p>

                    <div v-if="duplicateSuggestionFor(item.id)" class="question-duplicate-suggestion">
                      <p>Possible duplicate of: <em>{{ questionContentById(duplicateSuggestionFor(item.id)!.canonicalQuestionId) }}</em></p>
                      <div class="question-actions">
                        <button type="button" class="ghost-button" @click="confirmSuggestedDuplicate(item.id, duplicateSuggestionFor(item.id)!.canonicalQuestionId)" title="Confirm this AI suggestion — merges this question into the one shown above.">Confirm</button>
                        <button type="button" class="text-button" @click="dismissDuplicateSuggestion(item.id)" title="This is not actually a duplicate — hide this suggestion (it doesn't change anything saved).">Dismiss</button>
                      </div>
                    </div>

                    <p v-if="questionDetailFor(item)?.whyItMatters" class="question-suggestion"><strong>Why it matters</strong><br />{{ questionDetailFor(item)?.whyItMatters }}</p>
                    <p v-if="questionDetailFor(item)?.suggestedAction" class="question-suggestion"><strong>Suggested next step</strong><br />{{ questionDetailFor(item)?.suggestedAction }}</p>
                    <div v-if="questionDetailFor(item)?.expectedEvidence?.length" class="question-suggestion">
                      <strong>Evidence needed</strong>
                      <ul><li v-for="(evidenceHint, index) in questionDetailFor(item)?.expectedEvidence" :key="index">{{ evidenceHint }}</li></ul>
                    </div>

                    <p v-if="questionDetailFor(item)?.status === 'DUPLICATE'" class="question-duplicate-note">
                      Duplicate of: <em>{{ questionContentById(questionDetailFor(item)?.duplicateOfQuestionId ?? "") }}</em>
                    </p>

                    <template v-if="(questionDetailFor(item)?.status ?? 'OPEN') === 'OPEN'">
                      <template v-if="answeringQuestionId === item.id && !usingCustomAnswer">
                        <div class="question-suggested-answers">
                          <button
                            v-for="(suggestion, index) in questionDetailFor(item)?.suggestedAnswers"
                            :key="index"
                            type="button"
                            class="ghost-button question-suggested-answer"
                            @click="selectSuggestedAnswer(item.id, suggestion)"
                            title="Use this AI-suggested answer as-is and mark the question answered."
                          >{{ suggestion }}</button>
                        </div>
                        <div class="question-actions">
                          <button type="button" class="text-button" @click="useCustomAnswer" title="None of these fit — write your own answer instead.">Write my own answer</button>
                          <button type="button" class="text-button" @click="cancelAnswering" title="Close this box without saving an answer.">Cancel</button>
                        </div>
                      </template>
                      <template v-else-if="answeringQuestionId === item.id">
                        <p v-if="questionDetailFor(item)?.suggestedAnswers?.length" class="form-hint">None of the suggested answers fit? Write your own below.</p>
                        <textarea v-model="answerDraft" maxlength="5000" placeholder="Write the answer to this question…" title="The answer that resolves this question. It's saved permanently, even if you edit it again later."></textarea>
                        <div class="question-actions">
                          <button type="button" class="ghost-button" @click="submitAnswer(item.id)" title="Save this answer and mark the question answered.">Save as answered</button>
                          <button v-if="questionDetailFor(item)?.suggestedAnswers?.length" type="button" class="text-button" @click="usingCustomAnswer = false" title="Go back to the suggested-answer choices.">Back to suggestions</button>
                          <button type="button" class="text-button" @click="cancelAnswering" title="Close this box without saving an answer.">Cancel</button>
                        </div>
                      </template>
                      <template v-else-if="confirmingDuplicateQuestionId === item.id">
                        <select v-model="duplicateTargetId" title="Pick the other open question this one repeats. That other question stays open and counted; this one becomes a linked duplicate.">
                          <option value="" disabled>Choose the question this duplicates…</option>
                          <option v-for="candidate in otherOpenQuestions(item.id)" :key="candidate.id" :value="candidate.id">{{ candidate.content }}</option>
                        </select>
                        <div class="question-actions">
                          <button type="button" class="ghost-button" @click="confirmDuplicate(item.id)" title="Confirm this question is the same as the one you picked.">Confirm duplicate</button>
                          <button type="button" class="text-button" @click="cancelConfirmingDuplicate" title="Close this box without linking a duplicate.">Cancel</button>
                        </div>
                      </template>
                      <div v-else class="question-actions">
                        <button type="button" class="ghost-button" @click="startAnswering(item)" title="Write and save an answer to this question.">Write answer</button>
                        <button type="button" class="text-button" @click="deferQuestion(item.id)" title="Put this question off for later without answering it now.">Defer</button>
                        <button type="button" class="text-button" @click="markQuestionNotApplicable(item.id)" title="Mark this question as no longer relevant to this task.">Not applicable</button>
                        <button v-if="otherOpenQuestions(item.id).length" type="button" class="text-button" @click="startConfirmingDuplicate(item)" title="Mark this as the same question as another open one.">Mark as duplicate</button>
                      </div>
                    </template>
                    <div v-else class="question-actions">
                      <button v-if="questionDetailFor(item)?.status === 'DUPLICATE'" type="button" class="text-button" @click="removeDuplicateLink(item.id)" title="Undo the duplicate link and treat this as its own open question again.">Remove duplicate link</button>
                      <button v-else type="button" class="text-button" @click="reopenQuestion(item.id)" title="Reopen this question so it counts as unresolved again.">Reopen</button>
                    </div>

                    <details v-if="questionDetailFor(item)?.responses.length" class="question-history">
                      <summary title="See every past answer, deferral, or status change for this question, in order.">History ({{ questionDetailFor(item)?.responses.length }})</summary>
                      <ul>
                        <li v-for="response in questionDetailFor(item)?.responses" :key="response.id">
                          <strong>{{ response.resultingStatus }}</strong> — {{ response.answer }}
                          <small>{{ new Date(response.createdAt).toLocaleString() }}</small>
                        </li>
                      </ul>
                    </details>
                  </article>
                  <p v-if="!filteredQuestions.length" class="form-hint">No questions match this filter.</p>
                </div>
              </div>

              <details v-if="nonQuestionEvidence.length" class="evidence-records" :open="selectedTask.status !== 'READY'">
                <summary title="Open or close the saved evidence records. The form for adding a new record stays available above.">{{ nonQuestionEvidence.length }} saved records</summary>
                <div class="evidence-list">
                  <article v-for="item in nonQuestionEvidence" :key="item.id" class="evidence-item">
                    <span>{{ item.type }}</span>
                    <template v-if="editingEvidenceId === item.id">
                      <div class="evidence-edit">
                        <select v-model="editingEvidenceType">
                          <option value="FACT">Fact</option><option value="ASSUMPTION">Assumption</option>
                          <option value="QUESTION">Question</option><option value="DECISION">Decision</option>
                          <option value="EXPERIMENT_RESULT">Experiment result</option>
                        </select>
                        <input v-model="editingEvidenceContent" />
                      </div>
                      <button class="ghost-button" type="button" @click="saveEvidence(item)" title="Save your changes to this note.">Save</button>
                    </template>
                    <template v-else>
                      <p>{{ item.content }}</p>
                      <small :title="item.sourceProvider ? 'This note came from one of the AI runs, not typed by a person.' : 'This note was typed in by a human, not the AI.'">{{ item.sourceProvider ? `From ${item.sourceProvider}` : "Human record" }}</small>
                      <button class="text-button" type="button" @click="editEvidence(item)" title="Change the wording or type of this note.">Edit</button>
                    </template>
                  </article>
                </div>
              </details>
            </div>

            <div class="worktree-usages">
              <div class="subsection-heading" title="A single readable document that pulls together the problem, both analyses, both reviews, the comparison, questions, decisions, and experiments — handy to save or share before you decide anything."><span>BRAINSTORM PLAN REPORT</span></div>
              <p v-if="brainstormReportError" class="error-text" role="alert">{{ brainstormReportError }}</p>
              <div class="report-actions">
                <button class="ghost-button" type="button" :disabled="loadingBrainstormReport" @click="loadBrainstormReport" title="Build the report now from everything gathered so far for this task.">
                  {{ loadingBrainstormReport ? "Generating…" : "Generate report" }}
                </button>
                <button v-if="brainstormReport" class="text-button" type="button" @click="copyReportAsMarkdown" title="Copy this whole report as a Markdown document you can paste into Slack, a PR description, or a doc.">Copy as Markdown</button>
                <button v-if="brainstormReport" class="text-button" type="button" @click="downloadReportAsMarkdown" title="Save this report as a .md file to your computer.">Download .md</button>
              </div>

              <div v-if="brainstormReport" class="plan-report">
                <p class="form-hint">Generated {{ new Date(brainstormReport.generatedAt).toLocaleString() }} · {{ brainstormReport.taskType }} · risk {{ brainstormReport.riskLevel }} · status {{ brainstormReport.status }}{{ brainstormReport.comparisonVersion ? ` · plan version ${brainstormReport.comparisonVersion}` : "" }}</p>

                <div class="plan-report-summary">
                  <h3 class="plan-report-summary-heading">Executive summary</h3>
                  <p v-if="brainstormReport.blockingQuestionsRemain" class="plan-report-warning" role="alert" title="One or more questions marked BLOCKING priority are still unresolved. This is a warning, not a hard stop — you can still act on this plan.">
                    Blocking questions remain unresolved — review the OPEN questions below before promoting this plan.
                  </p>
                  <p><strong>Problem</strong><br />{{ brainstormReport.problemStatement }}</p>
                  <ul v-if="reportSummary" class="plan-report-list">
                    <li>{{ reportSummary.openCount }} open question(s) ({{ reportSummary.blockingOpenCount }} blocking) · {{ reportSummary.answeredCount }} answered · {{ reportSummary.deferredCount }} deferred · {{ reportSummary.notApplicableCount }} not applicable · {{ reportSummary.duplicateGroupCount }} duplicate group(s)</li>
                    <li>Comparison: {{ reportSummary.consensusCount }} consensus point(s) · {{ reportSummary.disagreementCount }} disagreement(s) · {{ reportSummary.missingEvidenceCount }} missing-evidence item(s)</li>
                  </ul>

                  <div class="report-synthesis-controls">
                    <select v-model="synthesisProvider" title="Which AI should write the synthesis below.">
                      <option value="CLAUDE">Claude</option>
                      <option value="CODEX">Codex</option>
                    </select>
                    <button class="ghost-button" type="button" :disabled="generatingSynthesis" @click="generateReportSynthesis" title="Ask the selected AI to write a short synthesized summary, key risks, and recommendation for this plan — beyond just reformatting what's already here. This spends a small amount of that provider's usage.">
                      {{ generatingSynthesis ? "Generating…" : "Generate AI summary" }}
                    </button>
                  </div>
                  <p v-if="synthesisError" class="error-text" role="alert">{{ synthesisError }}</p>
                  <div v-if="reportSynthesis" class="plan-report-synthesis">
                    <p>{{ reportSynthesis.executiveSummary }}</p>
                    <p><strong>Key risks</strong></p>
                    <ul class="plan-report-list"><li v-for="risk in reportSynthesis.keyRisks" :key="risk">{{ risk }}</li></ul>
                    <p><strong>Recommendation:</strong> {{ reportSynthesis.recommendation }}</p>
                  </div>

                  <p><strong>Recommended next action</strong><br />{{ brainstormReport.recommendedNextAction }}</p>
                </div>

                <details class="result-section">
                  <summary class="subsection-heading"><span>INDEPENDENT ANALYSES</span><strong>{{ brainstormReport.analyses.length }} analysis/analyses</strong></summary>
                  <div class="analysis-grid">
                    <article v-for="entry in brainstormReport.analyses" :key="'analysis-' + entry.provider" class="analysis-card">
                      <header><span>{{ providerLabel(entry.provider) }}</span></header>
                      <template v-if="entry.data">
                        <p>{{ entry.data.summary }}</p>
                        <h4>Facts</h4>
                        <ul v-if="entry.data.facts.length"><li v-for="item in entry.data.facts" :key="item">{{ item }}</li></ul>
                        <p v-else>None recorded.</p>
                        <h4>Assumptions</h4>
                        <ul v-if="entry.data.assumptions.length"><li v-for="item in entry.data.assumptions" :key="item">{{ item }}</li></ul>
                        <p v-else>None recorded.</p>
                        <h4>Options</h4>
                        <div v-for="option in entry.data.options" :key="option.name" class="option-block">
                          <strong>{{ option.name }}</strong><p>{{ option.description }}</p>
                          <small>{{ option.advantages.length }} advantages · {{ option.disadvantages.length }} disadvantages · {{ option.risks.length }} risks</small>
                        </div>
                        <h4>Recommendation</h4><p>{{ entry.data.recommendation ?? "None given." }}</p>
                      </template>
                      <p v-else>Could not be parsed{{ entry.parseError ? `: ${entry.parseError}` : "." }}</p>
                    </article>
                  </div>
                </details>

                <details class="result-section">
                  <summary class="subsection-heading"><span>CROSS-REVIEWS</span><strong>Each reviews the other</strong></summary>
                  <div class="analysis-grid">
                    <article v-for="entry in brainstormReport.crossReviews" :key="'review-' + entry.provider" class="review-card">
                      <header><span>{{ providerLabel(entry.provider) }} reviewing {{ entry.targetProvider ? providerLabel(entry.targetProvider) : "unknown" }}</span></header>
                      <p v-if="entry.data">{{ entry.data.summary }}</p>
                      <p v-else>Could not be parsed{{ entry.parseError ? `: ${entry.parseError}` : "." }}</p>
                    </article>
                  </div>
                </details>

                <details class="result-section">
                  <summary class="subsection-heading"><span>COMPARISON</span><strong>No automatic winner</strong></summary>
                  <div v-if="brainstormReport.comparison" class="comparison-grid">
                    <article v-for="(items, label) in brainstormReport.comparison" :key="String(label)">
                      <h4>{{ String(label).replace(/([A-Z])/g, ' $1') }}</h4>
                      <ul v-if="items.length"><li v-for="item in items" :key="item">{{ item }}</li></ul>
                      <p v-else>None asserted.</p>
                    </article>
                  </div>
                  <p v-else class="form-hint">Not available yet.</p>
                </details>

                <details class="result-section">
                  <summary class="subsection-heading"><span>QUESTIONS</span><strong>{{ reportSummary?.openCount }} open · {{ reportSummary?.answeredCount }} answered</strong></summary>
                  <div class="question-list">
                    <article v-for="entry in brainstormReport.evidence.questions.open" :key="entry.id" class="question-card">
                      <div class="question-card-heading"><span class="question-status open">OPEN</span><small v-if="entry.priority">{{ entry.priority }}</small></div>
                      <p class="question-text">{{ entry.content }}</p>
                      <p v-if="entry.whyItMatters" class="question-suggestion"><strong>Why it matters</strong><br />{{ entry.whyItMatters }}</p>
                      <p v-if="entry.suggestedAction" class="question-suggestion"><strong>Suggested next step</strong><br />{{ entry.suggestedAction }}</p>
                    </article>
                    <article v-for="entry in brainstormReport.evidence.questions.answered" :key="entry.id" class="question-card">
                      <div class="question-card-heading"><span class="question-status answered">ANSWERED</span></div>
                      <p class="question-text">{{ entry.content }}</p>
                      <p class="question-suggestion"><strong>Answer</strong><br />{{ entry.responses.at(-1)?.answer }}</p>
                    </article>
                    <article v-for="entry in brainstormReport.evidence.questions.deferred" :key="entry.id" class="question-card">
                      <div class="question-card-heading"><span class="question-status deferred">DEFERRED</span></div>
                      <p class="question-text">{{ entry.content }}</p>
                    </article>
                    <article v-for="entry in brainstormReport.evidence.questions.notApplicable" :key="entry.id" class="question-card">
                      <div class="question-card-heading"><span class="question-status not_applicable">NOT APPLICABLE</span></div>
                      <p class="question-text">{{ entry.content }}</p>
                    </article>
                    <article v-for="group in brainstormReport.evidence.questions.duplicateGroups" :key="group.canonical.id" class="question-card">
                      <div class="question-card-heading"><span class="question-status duplicate">DUPLICATE GROUP</span></div>
                      <p class="question-text">{{ group.canonical.content }}</p>
                      <p class="question-suggestion"><strong>Also asked as</strong></p>
                      <ul><li v-for="duplicate in group.duplicates" :key="duplicate.id">{{ duplicate.content }}</li></ul>
                    </article>
                  </div>
                </details>

                <p class="form-hint plan-report-other-evidence">Other evidence: {{ brainstormReport.evidence.facts.length }} fact(s) · {{ brainstormReport.evidence.assumptions.length }} assumption(s) · {{ brainstormReport.evidence.decisions.length }} decision(s) · {{ brainstormReport.evidence.experimentResults.length }} experiment result(s)</p>

                <details v-if="brainstormReport.architectureDecisions.length" class="result-section">
                  <summary class="subsection-heading"><span>ARCHITECTURE DECISIONS</span><strong>{{ brainstormReport.architectureDecisions.length }}</strong></summary>
                  <ul class="plan-report-list">
                    <li v-for="adr in brainstormReport.architectureDecisions" :key="adr.id">ADR-{{ String(adr.number).padStart(4, '0') }} — {{ adr.title }} ({{ adr.status }})</li>
                  </ul>
                </details>

                <details v-if="brainstormReport.experiments.length" class="result-section">
                  <summary class="subsection-heading"><span>EXPERIMENTS</span><strong>{{ brainstormReport.experiments.length }}</strong></summary>
                  <ul class="plan-report-list">
                    <li v-for="experiment in brainstormReport.experiments" :key="experiment.id">{{ experiment.hypothesis }} — {{ experiment.verdict ?? experiment.status }}</li>
                  </ul>
                </details>

                <p class="form-hint"><strong>Human decision required:</strong> YES — this is a plan to review, not an approved decision.</p>
              </div>
            </div>

            <div class="worktree-usages">
              <div class="subsection-heading" title="A small, quick 'let's just try it and see' test — one AI builds a tiny proof of concept and the other checks whether it actually worked, before you commit to the real thing."><span>EXPERIMENTS / PROOFS OF CONCEPT</span><strong>{{ experimentsForTask.length }} run(s)</strong></div>
              <p v-if="experimentError" class="error-text" role="alert">{{ experimentError }}</p>
              <form class="evidence-form adr-form" @submit.prevent="startExperiment">
                <label title="Write the guess you want to test — a specific claim that can turn out true or false, e.g. 'a simple modulo router can handle tenant routing.'"><span>Hypothesis</span><textarea v-model="experimentHypothesis" maxlength="5000" placeholder="e.g. Explicit tenant-to-shard routing can be implemented with a simple modulo router." required></textarea></label>
                <label title="Which AI writes the small test/prototype to try out the hypothesis.">
                  <span>Builder</span>
                  <select v-model="experimentBuilderProvider">
                    <option value="CLAUDE" :disabled="experimentReviewerProvider === 'CLAUDE'">Claude Code</option>
                    <option value="CODEX" :disabled="experimentReviewerProvider === 'CODEX'">Codex</option>
                  </select>
                </label>
                <label title="Which AI checks the builder's work and judges whether the hypothesis was proven or disproven. Must be the other AI, so no one grades its own homework.">
                  <span>Reviewer</span>
                  <select v-model="experimentReviewerProvider">
                    <option value="CLAUDE" :disabled="experimentBuilderProvider === 'CLAUDE'">Claude Code</option>
                    <option value="CODEX" :disabled="experimentBuilderProvider === 'CODEX'">Codex</option>
                  </select>
                </label>
                <button class="ghost-button" type="submit" :disabled="startingExperiment" title="Start this small test now. It uses a bit of AI usage, but far less than a full build.">{{ startingExperiment ? "Starting…" : "Start experiment" }}</button>
              </form>

              <p v-if="!experimentsForTask.length" class="form-hint">No experiments yet for this task.</p>
              <div v-for="experiment in experimentsForTask" :key="experiment.id" class="evidence-item adr-item">
                <header>
                  <strong>{{ experiment.hypothesis }}</strong>
                  <span title="PROVEN = the test supported the hypothesis. DISPROVEN = it didn't hold up. INCONCLUSIVE = the test couldn't tell for sure.">{{ experiment.status }}<template v-if="experiment.verdict"> · {{ experiment.verdict }}</template></span>
                </header>
                <p v-if="experiment.errorMessage" class="error-text" role="alert">{{ experiment.errorMessage }}</p>
                <p><strong>Builder / Reviewer</strong> {{ providerLabel(experiment.builderProvider) }} builds, {{ providerLabel(experiment.reviewerProvider) }} reviews</p>
                <p v-if="experiment.result"><strong>Result</strong> {{ experiment.result }}</p>
                <p v-if="experiment.conclusion"><strong>Conclusion</strong> {{ experiment.conclusion }}</p>
                <button
                  v-if="experiment.status === 'CHECKPOINTED'"
                  class="ghost-button" type="button" @click="resumeExperiment(experiment)"
                  title="Resume this experiment after resolving its provider-safety or task-budget checkpoint. Completed work is reused."
                >Resume</button>
                <button
                  v-if="['RUNNING', 'REVIEWING', 'CHECKPOINTED'].includes(experiment.status)"
                  class="danger-outline-button" type="button" @click="cancelExperiment(experiment)"
                  title="Stop this experiment before it finishes."
                >Cancel</button>
              </div>
            </div>
          </div>
          <div v-else class="task-detail empty-task">Create or select a task to inspect its workflow.</div>
        </div>
      </section>

      <section id="worktrees" class="project-panel worktree-panel" aria-labelledby="worktree-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">04 — ISOLATED GIT WORKTREES</p>
            <h2 id="worktree-heading">Give each agent its own checkout.</h2>
            <p>Preview and edit both names first. Creation never switches or modifies the active project checkout.</p>
          </div>
          <span class="safety-badge" title="A worktree is only created when you press a Create button below — nothing happens automatically. And removing one later is checked carefully so you can't accidentally delete unsaved work.">EXPLICIT CREATE · SAFE CLEANUP</span>
        </div>

        <div class="worktree-task-picker">
          <label title="Pick which brainstorm/architecture task these private working copies (worktrees) are for.">
            <span>Task</span>
            <select v-model="selectedWorktreeTaskId" :disabled="worktreeLoading" @change="loadWorktreesForTask">
              <option disabled value="">Select a task</option>
              <option v-for="task in tasks" :key="task.id" :value="task.id">{{ task.title }}</option>
            </select>
          </label>
          <div class="worktree-safety-note" title="A worktree is like giving each AI its own separate copy of your project folder to work in, so they can't accidentally overwrite your main copy or each other's changes.">
            <strong>Preview only until Create</strong>
            <span>Paths and branches are validated for collisions before Git is changed.</span>
          </div>
        </div>

        <p v-if="worktreeError" class="form-message error-text" role="alert">{{ worktreeError }}</p>
        <p v-if="worktreeMessage" class="form-message success-text" role="status">{{ worktreeMessage }}</p>
        <p v-if="worktreeLoading" class="worktree-loading">Inspecting repository worktrees…</p>

        <div v-else-if="selectedWorktreeTaskId" class="worktree-proposals">
          <article v-for="provider in (['CLAUDE', 'CODEX'] as AgentProvider[])" :key="provider" class="worktree-proposal-card">
            <header>
              <div>
                <span>{{ provider === 'CLAUDE' ? 'CLAUDE CODE' : 'CODEX' }}</span>
                <strong>{{ managedFor(provider) ? 'Managed worktree' : 'Proposed worktree' }}</strong>
              </div>
              <span :class="['worktree-state', managedFor(provider)?.status.toLowerCase() ?? (proposalFor(provider)?.available ? 'available' : 'blocked')]" title="CREATING = being set up. ACTIVE = ready to use. ERROR = something went wrong. AVAILABLE = ready to be created. BLOCKED = can't be created yet (see the message below).">
                {{ managedFor(provider)?.status ?? (proposalFor(provider)?.available ? 'AVAILABLE' : 'BLOCKED') }}
              </span>
            </header>

            <label title="Where on your computer this AI's private copy of the project will live. You can change it before creating, but not afterward.">
              <span>Directory path <small>Editable before creation</small></span>
              <input v-model="worktreeDrafts[provider].path" :readonly="Boolean(managedFor(provider))" autocomplete="off" />
            </label>
            <label title="The Git branch this worktree will use. Moving the folder later never renames this branch, and renaming the branch never moves the folder — they're tracked separately.">
              <span>Branch name <small>Independent from the path</small></span>
              <input v-model="worktreeDrafts[provider].branchName" :readonly="Boolean(managedFor(provider))" autocomplete="off" />
            </label>
            <label title="The existing branch this new one will start from — usually your project's main/default branch.">
              <span>Base ref</span>
              <input v-model="worktreeDrafts[provider].baseRef" :readonly="Boolean(managedFor(provider))" autocomplete="off" />
            </label>

            <p v-if="proposalFor(provider)?.message" class="proposal-message">{{ proposalFor(provider)?.message }}</p>
            <button
              v-if="!managedFor(provider)"
              class="primary-button"
              type="button"
              :disabled="creatingWorktree !== null || !proposalFor(provider)?.available"
              @click="createWorktree(provider)"
              title="Actually create this private folder and branch now. Your main project folder is never touched."
            >{{ creatingWorktree === provider ? 'Creating…' : `Create ${provider === 'CLAUDE' ? 'Claude' : 'Codex'} worktree` }}</button>
            <button v-else class="ghost-button" type="button" @click="selectManagedWorktree(managedFor(provider)!)" title="Open this worktree below to see its file changes, move/rename it, or clean it up.">Inspect and manage</button>
          </article>
        </div>

        <div v-if="selectedWorktree" class="worktree-inspector">
          <div class="worktree-inspector-heading">
            <div>
              <span>{{ selectedWorktree.provider }} WORKTREE</span>
              <h3>{{ selectedWorktree.branchName }}</h3>
              <code>{{ selectedWorktree.path }}</code>
            </div>
            <div class="inspection-flags">
              <span :class="selectedWorktree.inspection?.gitStatus === 'CLEAN' ? 'clean' : 'dirty'" title="CLEAN = no unsaved changes in this worktree. DIRTY = there are unsaved changes sitting in it.">
                {{ selectedWorktree.inspection?.gitStatus ?? selectedWorktree.status }}
              </span>
              <span :class="selectedWorktree.inUse ? 'busy' : 'idle'" title="IN USE means something (a running task or check) currently has this worktree locked, so moving/renaming/removing it is blocked until it's free. IDLE means it's free to manage.">{{ selectedWorktree.inUse ? 'IN USE' : 'IDLE' }}</span>
            </div>
          </div>
          <p v-if="selectedWorktree.inspectionError" class="error-text" role="alert">{{ selectedWorktree.inspectionError }}</p>
          <p v-if="selectedWorktree.lastError" class="error-text" role="alert">Last error: {{ selectedWorktree.lastError }}</p>
          <p v-if="!selectedWorktree.inspection" class="form-hint">
            Git no longer reports a live worktree at this path. Directory move and branch rename are disabled; use removal below to clear the stale record.
          </p>

          <div v-if="selectedWorktree.activeUsages.length" class="worktree-usages">
            <div class="subsection-heading" title="A list of who or what is currently 'holding' this worktree (a running task, a validation check, etc.), so you know why it might be locked."><span>ACTIVE USAGE LEASES</span></div>
            <ul>
              <li v-for="lease in selectedWorktree.activeUsages" :key="lease.id" :class="{ stale: lease.stale }">
                <span>{{ lease.ownerType }} · {{ lease.ownerId }} · started {{ new Date(lease.startedAt).toLocaleString() }}</span>
                <span v-if="lease.stale" class="usage-stale-label" title="This lease hasn't been updated in over 6 hours, so it's probably left over from something that crashed or stalled rather than a real, still-running process.">STALE — no update in over 6 hours</span>
                <button class="text-button" type="button" @click="releaseUsage(lease.id)" title="Manually let go of this lease. Only do this if you're sure whatever was using the worktree is no longer actually running.">Release lease</button>
              </li>
            </ul>
          </div>

          <div class="worktree-management-grid">
            <form @submit.prevent="renameWorktreePath">
              <label title="Type a new folder location to move this worktree to. Its Git branch name stays exactly the same."><span>Move directory <small>Branch stays unchanged</small></span><input v-model="renamePath" required /></label>
              <button
                class="ghost-button" type="submit"
                :disabled="selectedWorktree.inUse || !selectedWorktree.inspection || selectedWorktree.inspection.gitStatus === 'DIRTY'"
                title="Move this worktree's folder to the new path above. Disabled while it's in use or has unsaved changes, to avoid losing anything."
              >Move directory</button>
              <p v-if="selectedWorktree.inUse" class="form-hint">Disabled: an active process is using this worktree.</p>
              <p v-else-if="selectedWorktree.inspection?.gitStatus === 'DIRTY'" class="form-hint">Disabled: the worktree has uncommitted changes.</p>
            </form>
            <form @submit.prevent="renameWorktreeBranch">
              <label title="Type a new name for this worktree's Git branch. Its folder location on disk stays exactly the same."><span>Rename branch <small>Directory stays unchanged</small></span><input v-model="renameBranch" required /></label>
              <button
                class="ghost-button" type="submit"
                :disabled="selectedWorktree.inUse || !selectedWorktree.inspection || selectedWorktree.inspection.gitStatus === 'DIRTY'"
                title="Rename this worktree's branch to the new name above. Disabled while it's in use or has unsaved changes, to avoid losing anything."
              >Rename branch</button>
              <p v-if="selectedWorktree.inUse" class="form-hint">Disabled: an active process is using this worktree.</p>
              <p v-else-if="selectedWorktree.inspection?.gitStatus === 'DIRTY'" class="form-hint">Disabled: the worktree has uncommitted changes.</p>
            </form>
          </div>

          <div class="worktree-diff">
            <div class="subsection-heading" title="Shows exactly which lines of code have changed in this worktree but haven't been merged anywhere yet."><span>LOCAL DIFF</span><button class="text-button" type="button" @click="loadWorktreeDiff(selectedWorktree.id)" title="Fetch the latest changes again — useful if the AI has made more edits since you last looked.">Refresh</button></div>
            <div class="diff-grid">
              <article><strong>Unstaged</strong><pre>{{ worktreeDiff?.unstaged || 'No unstaged changes.' }}</pre></article>
              <article><strong>Staged</strong><pre>{{ worktreeDiff?.staged || 'No staged changes.' }}</pre></article>
            </div>
          </div>

          <div class="worktree-cleanup">
            <div>
              <span>RECOVERABLE CLEANUP</span>
              <strong>Clean and idle worktrees only</strong>
              <p>The branch is retained unless you separately request deletion and Git confirms it is merged.</p>
            </div>
            <button v-if="removalArmedId !== selectedWorktree.id" class="danger-outline-button" type="button" @click="armWorktreeRemoval(selectedWorktree)" title="Start the removal process for this worktree. Nothing is deleted yet — you'll be asked to confirm next.">Prepare removal</button>
            <div v-else class="cleanup-confirmation">
              <label class="check-row" title="You must tick this box yourself before anything is deleted — the app never removes a worktree without you explicitly confirming."><input v-model="removalConfirmed" type="checkbox" />I confirm this worktree should be removed.</label>
              <label class="check-row" title="If checked, the branch is only deleted when Git can prove it's already been fully merged elsewhere — an unmerged branch is never deleted, even with this box checked."><input v-model="deleteMergedBranch" type="checkbox" />Also delete the branch, but only if Git reports it merged.</label>
              <div>
                <button class="text-button" type="button" @click="removalArmedId = ''" title="Back out — don't remove this worktree after all.">Cancel</button>
                <button class="danger-outline-button" type="button" :disabled="!removalConfirmed" @click="removeWorktree" title="Actually delete this worktree's folder now. Blocked if it's dirty, locked, or in use, so you can't accidentally lose unsaved work.">Remove clean worktree</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="usage-safety" class="project-panel usage-panel" aria-labelledby="usage-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">05 — CLAUDE &amp; CODEX USAGE SAFETY</p>
            <h2 id="usage-heading">Never spend provider usage blind.</h2>
            <p>
              A provider subscription allowance (what this page tracks) is not the same thing as an API token rate
              limit: this is about the Claude Code / ChatGPT plan allowance a run can exhaust, not per-request
              tokens-per-minute limits. Claude reports this automatically in its own run output (CLI_REPORTED · EXACT),
              while Codex can be read on demand, for free, through its local App Server (APP_SERVER · EXACT) — the app
              refreshes Codex's reading automatically before every provider call and after each run. Claude has no
              free equivalent, so its automatic pre-flight check never spends usage on your behalf; use the manual
              Refresh button when you want an up-to-date Claude reading sooner than its next real run, which will use
              a small amount of Claude usage to get it. If a supported reader is unavailable, use a manual snapshot;
              it remains clearly labeled as an estimate.
            </p>
          </div>
          <span class="safety-badge" title="Before the app spends any of your Claude/Codex usage, it checks how much is left — every single time, not just once.">CHECK BEFORE EVERY CALL</span>
        </div>

        <p v-if="usageError" class="form-message error-text" role="alert">{{ usageError }}</p>
        <p v-if="usageMessage" class="form-message success-text" role="status">{{ usageMessage }}</p>
        <p v-if="usageLoading" class="worktree-loading">Loading provider usage…</p>

        <div class="usage-grid">
          <article v-for="provider in (['CLAUDE', 'CODEX'] as AgentProvider[])" :key="provider" class="usage-card">
            <header>
              <strong>{{ providerLabel(provider) }}</strong>
              <button class="text-button" type="button" :disabled="refreshingProvider !== null" @click="refreshUsage(provider)" :title="provider === 'CLAUDE' ? 'Unlike Codex, Claude has no free on-demand usage check. Clicking this sends one minimal request to the cheapest Claude model just to read current usage; it will use a small amount of your Claude usage, so use it sparingly.' : 'Ask Codex App Server for the current ChatGPT plan-usage windows without starting a model run.'">
                {{ refreshingProvider === provider ? "Refreshing…" : "Refresh" }}
              </button>
            </header>

            <div v-for="window in usage[provider]" :key="window.windowId" class="usage-window">
              <div class="usage-window-heading">
                <span>{{ window.windowLabel }}</span>
                <span :class="['usage-state', window.status.toLowerCase()]" title="SAFE = plenty left. WARNING = getting low, worth watching. CHECKPOINT REQUIRED = the app will pause and ask you before continuing. EXHAUSTED = none left, blocked until reset. UNAVAILABLE/STALE = no recent trustworthy reading — treated as not-safe rather than guessed.">{{ usageStatusLabel(window.status) }}</span>
              </div>
              <div class="usage-bar" role="progressbar" :aria-valuenow="window.usedPercent ?? 0" aria-valuemin="0" aria-valuemax="100"
                :aria-valuetext="window.usedPercent === null ? 'No data' : `${window.usedPercent}% used`"
                title="A simple bar showing how much of this usage window has been used up so far.">
                <div class="usage-bar-fill" :class="window.status.toLowerCase()" :style="{ width: `${window.usedPercent ?? 0}%` }"></div>
              </div>
              <dl class="usage-detail-grid">
                <div><dt title="How much of this time window's allowance has been spent.">Used</dt><dd>{{ window.usedPercent === null ? "Unknown" : `${window.usedPercent}%` }}</dd></div>
                <div><dt title="How much of this time window's allowance is still left to spend.">Remaining</dt><dd>{{ window.remainingPercent === null ? "Unknown" : `${window.remainingPercent}%` }}</dd></div>
                <div><dt title="How long until this usage window refills back to 100%.">Resets</dt><dd>{{ window.timeUntilReset ? `in ${window.timeUntilReset}` : "Unknown" }}</dd></div>
                <div><dt title="Where this reading came from: provider run output, Codex's supported local App Server, a manual entry, or a rate-limit error message.">Source</dt><dd>{{ window.source ?? "None yet" }}<template v-if="window.sourceConfidence"> · {{ window.sourceConfidence }}</template></dd></div>
                <div><dt title="When this reading was last refreshed.">Last updated</dt><dd>{{ window.lastRefreshedAt ? new Date(window.lastRefreshedAt).toLocaleString() : "Never" }}</dd></div>
                <div><dt title="Whether this reading is recent enough to trust (FRESH) or too old to rely on (STALE).">Freshness</dt><dd>{{ window.freshness }}</dd></div>
              </dl>
            </div>

            <form class="usage-manual-form" @submit.prevent="submitManualSnapshot(provider)">
              <div class="field-row">
                <label title="A short code for this time window, e.g. '5H' for a 5-hour window — matches how the provider's own dashboard labels it."><span>Window</span><input v-model="manualSnapshotForm[provider].windowId" placeholder="5H" maxlength="40" required /></label>
                <label title="A human-friendly name for this window, e.g. '5-hour window'."><span>Label</span><input v-model="manualSnapshotForm[provider].windowLabel" placeholder="5-hour window" maxlength="120" required /></label>
              </div>
              <div class="field-row">
                <label title="Type in the used-percentage number from the provider's own website or app when an automatic reading is unavailable."><span>Used % <small>From the provider's own display</small></span><input v-model="manualSnapshotForm[provider].usedPercent" type="number" min="0" max="100" step="1" required /></label>
                <label title="When this usage window refreshes back to 100%, if the provider tells you."><span>Resets at <small>Optional</small></span><input v-model="manualSnapshotForm[provider].resetAt" type="datetime-local" /></label>
              </div>
              <button class="ghost-button" type="submit" title="Save this hand-typed reading so the app can use it to decide whether it's safe to keep spending usage.">Submit manual snapshot</button>
              <p class="form-hint">Manual readings are estimates you enter yourself; they are labeled MANUAL and never confused with an automatic reading.</p>
            </form>
          </article>
        </div>

        <form class="usage-policy-form" @submit.prevent="updateUsagePolicy">
          <div class="subsection-heading" title="Set the percentages that decide when you get a gentle warning versus when the app stops and makes you confirm before continuing."><span>SAFETY THRESHOLDS</span><strong>Applies to both providers</strong></div>
          <div class="field-row">
            <label title="Once usage crosses this percentage, the app shows a warning but still lets you continue."><span>Warning threshold %</span><input v-model="policyForm.warningThresholdPercent" type="number" min="0" max="100" required /></label>
            <label title="Once usage crosses this percentage, the app pauses and requires you to explicitly confirm before it will spend any more."><span>Checkpoint threshold %</span><input v-model="policyForm.checkpointThresholdPercent" type="number" min="0" max="100" required /></label>
          </div>
          <button class="ghost-button" type="submit" title="Save these two percentages as the new thresholds.">Update thresholds</button>
        </form>
      </section>

      <section id="build" class="project-panel worktree-panel" aria-labelledby="build-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">06 — BUILD AND REVIEW</p>
            <h2 id="build-heading">Let Claude build, and Codex review, without editing each other's work.</h2>
            <p>Choose independent builder and reviewer roles. The reviewer never touches the builder's worktree.</p>
          </div>
          <span class="safety-badge" title="The builder AI can only edit files inside its own private worktree copy — never your real project folder — and you decide up front how many rounds of review-and-fix can happen.">WORKTREE-SCOPED WRITE · CONFIGURABLE REVIEW ROUNDS</span>
        </div>

        <div class="worktree-task-picker">
          <label title="Which brainstorm/architecture task this build is implementing.">
            <span>Task</span>
            <select v-model="selectedBuildTaskId" :disabled="buildsLoading" @change="loadBuildsForTask">
              <option disabled value="">Select a task</option>
              <option v-for="task in tasks" :key="task.id" :value="task.id">{{ task.title }}</option>
            </select>
          </label>
          <div class="worktree-safety-note" title="One AI (the builder) writes the code in its own private copy of the project. The other AI (the reviewer) only reads and critiques — it never edits the builder's files.">
            <strong>Builder edits, reviewer only reads</strong>
            <span>Validation commands run inside the builder's own worktree, never the registered repository.</span>
          </div>
        </div>

        <p v-if="buildError" class="form-message error-text" role="alert">{{ buildError }}</p>
        <p v-if="buildMessage" class="form-message success-text" role="status">{{ buildMessage }}</p>

        <div v-if="selectedBuildTaskId" class="worktree-proposals">
          <article class="worktree-proposal-card">
            <header>
              <div><span>ROLES</span><strong>Independent by provider</strong></div>
            </header>
            <label title="Which AI actually writes the code for this build.">
              <span>Builder</span>
              <select v-model="buildBuilderProvider" :disabled="buildHasNonTerminalRun">
                <option value="CLAUDE" :disabled="buildReviewerProvider === 'CLAUDE'">Claude Code</option>
                <option value="CODEX" :disabled="buildReviewerProvider === 'CODEX'">Codex</option>
              </select>
            </label>
            <label title="Which AI checks the builder's code and raises findings. Must be the other AI — the builder can never review its own work.">
              <span>Reviewer</span>
              <select v-model="buildReviewerProvider" :disabled="buildHasNonTerminalRun">
                <option value="CLAUDE" :disabled="buildBuilderProvider === 'CLAUDE'">Claude Code</option>
                <option value="CODEX" :disabled="buildBuilderProvider === 'CODEX'">Codex</option>
              </select>
            </label>
            <label title="How many times the reviewer and builder can go back and forth (review, fix, review again) before the build stops asking for more rounds.">
              <span>Maximum review rounds</span>
              <input v-model.number="buildMaxReviewRounds" type="number" min="1" max="10" :disabled="buildHasNonTerminalRun" />
            </label>
            <div v-if="(projectForTask(selectedBuildTaskId)?.validationCommands.length ?? 0) > 0" class="check-row-group" title="Tick which of your saved test/lint/build commands should be run automatically against the builder's changes.">
              <span>Validation commands</span>
              <label v-for="command in projectForTask(selectedBuildTaskId)?.validationCommands" :key="command.id" class="check-row">
                <input v-model="buildValidationSelection[command.id]" type="checkbox" />{{ command.label }}
              </label>
            </div>
            <p v-else class="form-hint">This project has no saved validation commands; the build will skip straight to review.</p>
            <button class="primary-button" type="button" :disabled="startingBuild || buildHasNonTerminalRun" @click="startBuild" title="Start the builder AI writing code now, inside its own private worktree. This uses real AI usage.">
              {{ startingBuild ? "Starting…" : buildHasNonTerminalRun ? "A build is already running" : "Start build" }}
            </button>
          </article>
        </div>

        <p v-if="buildsLoading" class="worktree-loading">Loading builds…</p>

        <div v-if="builds.length" class="worktree-task-picker">
          <label title="Pick a past or current build to look at its details below.">
            <span>Build run</span>
            <select :value="selectedBuild?.id" @change="selectBuild(($event.target as HTMLSelectElement).value)">
              <option v-for="build in builds" :key="build.id" :value="build.id">
                {{ new Date(build.createdAt).toLocaleString() }} — {{ build.status }}
              </option>
            </select>
          </label>
        </div>

        <div v-if="selectedBuild" class="worktree-inspector">
          <div class="worktree-inspector-heading">
            <div>
              <span title="Which AI is writing the code, which AI is reviewing it, and which round of review this is out of the maximum you set.">{{ selectedBuild.builderProvider }} BUILDS · {{ selectedBuild.reviewerProvider }} REVIEWS · ROUND {{ selectedBuild.reviewRound }} / {{ selectedBuild.maxReviewRounds }}</span>
              <h3 title="BUILDING = writing code. VALIDATING = running your test/lint/build commands. REVIEWING = the reviewer AI is checking the work. RESPONDING = the builder is fixing flagged issues. COMPLETED = done. CHECKPOINTED = paused for a usage-safety check.">{{ selectedBuild.status }}</h3>
            </div>
            <button
              v-if="['BUILDING', 'VALIDATING', 'REVIEWING', 'RESPONDING', 'CHECKPOINTED'].includes(selectedBuild.status)"
              class="danger-outline-button" type="button" @click="cancelBuild"
              title="Stop this build now. Code already written in the worktree is kept as-is."
            >Cancel</button>
          </div>
          <p v-if="selectedBuild.errorMessage" class="error-text" role="alert">{{ selectedBuild.errorMessage }}</p>

          <div class="worktree-usages">
            <div class="subsection-heading" title="The results of running your saved test/lint/build commands against the builder's changes."><span>VALIDATION RESULTS</span></div>
            <p v-if="!selectedBuild.validationRuns.length" class="form-hint">No validation commands ran for this build.</p>
            <ul v-else>
              <li v-for="run in selectedBuild.validationRuns" :key="run.id">
                <span>{{ run.status === 'PASSED' ? '✓' : '✗' }} {{ run.commandLabel }} · exit {{ run.exitCode ?? 'n/a' }} · {{ run.durationMs }}ms</span>
              </li>
            </ul>
          </div>

          <div class="worktree-diff">
            <div class="subsection-heading" title="The exact code changes the reviewer AI looked at when it checked this build."><span>DIFF REVIEWED</span></div>
            <div class="diff-grid">
              <article><strong>Unstaged</strong><pre>{{ selectedBuild.diffUnstaged || 'None.' }}</pre></article>
              <article><strong>Staged</strong><pre>{{ selectedBuild.diffStaged || 'None.' }}</pre></article>
            </div>
          </div>

          <div class="worktree-usages">
            <div class="subsection-heading" title="Specific issues the reviewer AI flagged in the builder's code, sorted by how serious they are.">
              <span>STRUCTURED FINDINGS</span>
              <strong>
                <template v-for="(count, severity) in findingSeverityCounts(selectedBuild)" :key="severity">
                  <span v-if="count > 0">{{ severity }} {{ count }} </span>
                </template>
              </strong>
            </div>
            <p v-if="selectedBuild.reviewArtifact?.parseError" class="error-text" role="alert">
              The reviewer's response could not be parsed: {{ selectedBuild.reviewArtifact.parseError }}
            </p>
            <p v-else-if="!selectedBuild.findings.length && selectedBuild.status === 'COMPLETED'" class="form-hint">The reviewer found nothing to flag.</p>
            <ul v-else class="finding-list">
              <li v-for="finding in selectedBuild.findings" :key="finding.id" :class="['finding-item', finding.severity.toLowerCase()]">
                <header>
                  <span title="CRITICAL/HIGH = serious, fix before merging. MEDIUM/LOW = worth a look. INFO = just a note. The category says what kind of issue it is (correctness, security, performance, etc.), and the round is which review pass found it.">{{ finding.severity }} · {{ finding.category }} · round {{ finding.round }}</span>
                  <strong>{{ finding.title }}</strong>
                  <span v-if="finding.file">{{ finding.file }}<template v-if="finding.startLine">:{{ finding.startLine }}</template></span>
                  <span :class="['finding-status', finding.status.toLowerCase()]" title="OPEN = not addressed yet. RESPONDED = the builder has replied or made a fix. RESOLVED = considered handled.">{{ finding.status }}</span>
                </header>
                <p>{{ finding.description }}</p>
                <p class="form-hint">Evidence: {{ finding.evidence }}</p>
                <p class="form-hint">Impact: {{ finding.impact }}</p>
                <p v-if="finding.suggestedFix" class="form-hint">Suggested fix: {{ finding.suggestedFix }}</p>
                <template v-if="finding.builderVerdict">
                  <p class="form-hint">Builder verdict: {{ finding.builderVerdict }} — {{ finding.builderEvidence }}</p>
                  <p class="form-hint">Builder action: {{ finding.builderAction }}</p>
                </template>
                <p v-if="finding.reviewerRecheckNote" class="form-hint">Reviewer recheck: {{ finding.reviewerRecheckNote }}</p>
              </li>
            </ul>
            <button
              v-if="canRespondToFindings(selectedBuild)"
              class="primary-button" type="button" :disabled="respondingToFindings" @click="respondToFindings"
              title="Send the still-open findings back to the builder AI so it can accept them, fix the code, or explain why it disagrees."
            >{{ respondingToFindings ? "Sending…" : `Send ${openFindingsCount(selectedBuild)} open finding(s) to builder` }}</button>
            <p
              v-else-if="selectedBuild.status === 'COMPLETED' && openFindingsCount(selectedBuild) > 0 && selectedBuild.reviewRound >= selectedBuild.maxReviewRounds"
              class="form-hint"
            >This build has reached its maximum of {{ selectedBuild.maxReviewRounds }} review round(s); resolve the remaining findings directly.</p>
          </div>

          <div class="worktree-usages">
            <div class="subsection-heading" title="Whether this build's code has been combined (merged) into a real branch yet."><span>MERGE</span><strong>{{ selectedBuild.mergeStatus }}</strong></div>
            <p v-if="selectedBuild.mergeError" class="error-text" role="alert">{{ selectedBuild.mergeError }}</p>
            <template v-if="selectedBuild.mergeStatus === 'MERGED'">
              <p class="form-hint">Merged into <strong>{{ selectedBuild.mergeTargetBranch }}</strong> as {{ selectedBuild.mergeCommitSha?.slice(0, 12) }} at {{ new Date(selectedBuild.mergedAt!).toLocaleString() }}.</p>
              <p v-if="selectedBuild.mergeTargetCheckedOutAt" class="form-hint">
                Note: {{ selectedBuild.mergeTargetBranch }} was checked out at {{ selectedBuild.mergeTargetCheckedOutAt }} — that working copy is now stale and needs a refresh (e.g. <code>git status</code> then <code>git reset --hard</code>).
              </p>
              <p class="form-hint">
                Worktree: {{ selectedBuild.worktreeRemovedAfterMerge ? "removed" : "kept" }}<template v-if="selectedBuild.worktreeCleanupSkippedReason"> — {{ selectedBuild.worktreeCleanupSkippedReason }}</template>.
                Branch: {{ selectedBuild.branchDeletedAfterMerge ? "deleted" : "kept" }}.
              </p>
            </template>
            <template v-if="canMergeBuild(selectedBuild)">
              <label title="Which branch to merge this build's code into. Leave blank to use the worktree's own base branch.">
                <span>Target branch (optional)</span>
                <input v-model="mergeTargetBranch" type="text" placeholder="Defaults to the worktree's base branch" />
              </label>
              <label title="The Git commit message for this merge. Leave blank and a sensible default is written for you.">
                <span>Commit message (optional)</span>
                <input v-model="mergeCommitMessage" type="text" placeholder="A default message is generated" />
              </label>
              <label class="check-row" title="If checked, the builder's private worktree folder is kept around after merging instead of being cleaned up automatically."><input v-model="keepWorktreeAfterMerge" type="checkbox" />Keep worktree after merge</label>
              <label class="check-row" title="If checked, this task's branch is deleted after a successful merge (only once Git confirms it's safely merged in)."><input v-model="deleteBranchAfterMerge" type="checkbox" />Delete task branch after merge</label>
              <button class="primary-button" type="button" :disabled="merging" @click="mergeBuild" title="This is the final, real step: it actually merges the builder's code into your chosen branch. Nothing before this button touches your real project.">
                {{ merging || selectedBuild.mergeStatus === 'MERGING' ? "Merging…" : "Approve & merge" }}
              </button>
            </template>
          </div>

          <div class="worktree-usages">
            <div class="subsection-heading" title="A single readable summary of this build — what changed, what was tested, what was found, and whether it merged — meant to help a human review it before opening a real pull request."><span>PRE-PR REPORT</span></div>
            <p v-if="reportError" class="error-text" role="alert">{{ reportError }}</p>
            <button class="ghost-button" type="button" :disabled="loadingReport" @click="loadPrePrReport" title="Build this summary report now from everything gathered so far for this build.">
              {{ loadingReport ? "Generating…" : "Generate report" }}
            </button>
            <div v-if="prePrReport" class="pre-pr-report">
              <p class="form-hint">Generated {{ new Date(prePrReport.generatedAt).toLocaleString() }} · risk {{ prePrReport.riskLevel }} · round {{ prePrReport.reviewRound }}</p>
              <p><strong>Problem</strong><br />{{ prePrReport.problemStatement }}</p>
              <p><strong>Implementation summary</strong><br />{{ prePrReport.implementationSummary || "Unavailable." }}</p>
              <p><strong>Files changed</strong><br /><template v-if="prePrReport.filesChanged.length">{{ prePrReport.filesChanged.join(", ") }}</template><template v-else>None.</template></p>
              <p><strong>Findings</strong> — {{ prePrReport.findings.total }} total, {{ prePrReport.findings.accepted.length }} accepted, {{ prePrReport.findings.rejected.length }} rejected, {{ prePrReport.findings.unresolved.length }} unresolved</p>
              <p><strong>Tests</strong><br />
                <template v-for="run in prePrReport.tests" :key="run.commandLabel + run.phase">
                  {{ run.status === 'PASSED' ? '✓' : '✗' }} {{ run.commandLabel }} ({{ run.phase }})<br />
                </template>
                <template v-if="!prePrReport.tests.length">No validation commands ran.</template>
              </p>
              <p><strong>Merge</strong><br />{{ prePrReport.merge.status }}<template v-if="prePrReport.merge.targetBranch"> into {{ prePrReport.merge.targetBranch }}</template></p>
              <p><strong>Architecture decisions</strong><br />
                <template v-if="prePrReport.architectureDecisions.length">
                  <template v-for="adr in prePrReport.architectureDecisions" :key="adr.id">ADR-{{ String(adr.number).padStart(4, '0') }} {{ adr.title }} ({{ adr.status }})<br /></template>
                </template>
                <template v-else>None linked to this task.</template>
              </p>
              <p><strong>Human review required</strong><br />YES — AI approval is never equivalent to human approval.</p>
              <p><strong>Recommended next action</strong><br />{{ prePrReport.recommendedNextAction }}</p>
            </div>
          </div>
        </div>
      </section>

      <section id="decisions" class="project-panel worktree-panel" aria-labelledby="decisions-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">08 — ARCHITECTURE DECISIONS</p>
            <h2 id="decisions-heading">Turn a discussion into a record you can point back to.</h2>
            <p>Create and edit ADRs for a task. Stored locally; never exported into the repository automatically.</p>
          </div>
          <span class="safety-badge" title="ADRs (Architecture Decision Records) are saved only in this app's local database — they are never automatically written into your project's files or repository.">SQLITE ONLY · NO AUTO-EXPORT</span>
        </div>

        <div class="worktree-task-picker">
          <label title="Which task this decision record is associated with.">
            <span>Task</span>
            <select v-model="selectedAdrTaskId" @change="loadAdrsForTask">
              <option disabled value="">Select a task</option>
              <option v-for="task in tasks" :key="task.id" :value="task.id">{{ task.title }}</option>
            </select>
          </label>
        </div>

        <p v-if="adrError" class="form-message error-text" role="alert">{{ adrError }}</p>

        <form v-if="selectedAdrTaskId" class="evidence-form adr-form" @submit.prevent="createAdr">
          <label title="A short name for the decision being made, e.g. 'Use modulo-based shard routing.'"><span>Title</span><input v-model="adrForm.title" maxlength="300" required /></label>
          <label title="The background: what situation or problem led to needing this decision at all."><span>Context</span><textarea v-model="adrForm.context" maxlength="10000" required></textarea></label>
          <label title="The different choices that were on the table before this one was picked."><span>Options considered</span><textarea v-model="adrForm.optionsConsidered" maxlength="10000" required></textarea></label>
          <label title="The choice that was actually made, stated plainly."><span>Decision</span><textarea v-model="adrForm.decision" maxlength="10000" required></textarea></label>
          <label title="Why this option was chosen over the others."><span>Reasons</span><textarea v-model="adrForm.reasons" maxlength="10000" required></textarea></label>
          <label title="What this decision means going forward — the effects, trade-offs, or things that now need to happen because of it."><span>Consequences</span><textarea v-model="adrForm.consequences" maxlength="10000" required></textarea></label>
          <label title="Anything that could go wrong because of this decision, if you want to note it."><span>Risks (optional)</span><textarea v-model="adrForm.risks" maxlength="10000"></textarea></label>
          <label title="Options that were considered but turned down, and why, if worth recording."><span>Rejected alternatives (optional)</span><textarea v-model="adrForm.rejectedAlternatives" maxlength="10000"></textarea></label>
          <label title="Anything that still needs to be done later because of this decision, if there is any."><span>Required follow-up (optional)</span><textarea v-model="adrForm.requiredFollowUp" maxlength="10000"></textarea></label>
          <button class="ghost-button" type="submit" :disabled="creatingAdr" title="Save this decision record permanently so you can look back on why this choice was made.">{{ creatingAdr ? "Creating…" : "Create ADR" }}</button>
        </form>

        <p v-if="selectedAdrTaskId && !adrsForTask.length" class="form-hint">No ADRs yet for this task.</p>
        <div v-for="adr in adrsForTask" :key="adr.id" class="evidence-item adr-item">
          <header>
            <strong>ADR-{{ String(adr.number).padStart(4, '0') }} {{ adr.title }}</strong>
            <select :value="adr.status" @change="updateAdrStatus(adr, ($event.target as HTMLSelectElement).value as AdrStatus)" title="PROPOSED = suggested but not yet decided. ACCEPTED = this is the decision we're going with. REJECTED = considered and turned down. SUPERSEDED = replaced by a newer decision.">
              <option value="PROPOSED">Proposed</option>
              <option value="ACCEPTED">Accepted</option>
              <option value="REJECTED">Rejected</option>
              <option value="SUPERSEDED">Superseded</option>
            </select>
          </header>
          <p><strong>Context</strong> {{ adr.context }}</p>
          <p><strong>Options considered</strong> {{ adr.optionsConsidered }}</p>
          <p><strong>Decision</strong> {{ adr.decision }}</p>
          <p><strong>Reasons</strong> {{ adr.reasons }}</p>
          <p><strong>Consequences</strong> {{ adr.consequences }}</p>
          <p v-if="adr.risks"><strong>Risks</strong> {{ adr.risks }}</p>
          <p v-if="adr.rejectedAlternatives"><strong>Rejected alternatives</strong> {{ adr.rejectedAlternatives }}</p>
          <p v-if="adr.requiredFollowUp"><strong>Required follow-up</strong> {{ adr.requiredFollowUp }}</p>
          <small>Related tasks: {{ adr.relatedTaskIds.length || "none" }}</small>

          <div class="promoted-tasks">
            <p class="form-hint" v-if="promotedTasksByAdr[adr.id]?.length"><strong>Promoted to:</strong></p>
            <ul v-if="promotedTasksByAdr[adr.id]?.length">
              <li v-for="promoted in promotedTasksByAdr[adr.id]" :key="promoted.id">
                {{ promoted.title }} — {{ promoted.status }}<template v-if="promoted.planPhase"> ({{ promoted.planPhase }})</template>
              </li>
            </ul>
            <p v-if="promoteForms[adr.id] && adr.openBlockingQuestionCount > 0" class="plan-report-warning" role="alert" title="One or more questions marked BLOCKING priority are still unresolved on the task this decision came from. This is a warning, not a hard stop — you can still promote this decision to a task.">
              {{ adr.openBlockingQuestionCount }} blocking question{{ adr.openBlockingQuestionCount === 1 ? "" : "s" }} remain unresolved on the originating task — review before promoting.
            </p>
            <form v-if="promoteForms[adr.id]" class="promote-form" @submit.prevent="promoteAdr(adr)" title="Turn this decision into a real, actionable task in your task list — so deciding on something and actually doing it stay clearly separate steps.">
              <input v-model="promoteForms[adr.id]!.title" placeholder="New task title (e.g. Create shard registry schema)" maxlength="300" required />
              <input v-model="promoteForms[adr.id]!.problemStatement" placeholder="Problem statement for the new task" required />
              <input v-model="promoteForms[adr.id]!.planPhase" placeholder="Plan phase (optional, e.g. Phase 1 — Shard Registry)" maxlength="300" />
              <select v-model="promoteForms[adr.id]!.riskLevel" title="How big a deal this new task is if it goes wrong.">
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
              <button class="text-button" type="submit" :disabled="promotingAdrId === adr.id" title="Create a brand-new task from this decision, so it shows up in your task list ready to be worked on.">
                {{ promotingAdrId === adr.id ? "Promoting…" : "+ Promote to implementation task" }}
              </button>
            </form>
          </div>
        </div>
      </section>

      <section id="maintenance" class="project-panel" aria-labelledby="maintenance-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">09 — RECOVERY &amp; AUDIT</p>
            <h2 id="maintenance-heading">Keep the local workspace recoverable.</h2>
            <p>Create verified database backups, stage a safe restart-only restore, and inspect cleanup warnings.</p>
          </div>
          <span class="safety-badge" title="A restore never replaces the database while the app is running. It is checked first, applied only after restart, and the database it replaces is backed up again.">CHECKED BACKUPS · RESTART RESTORE</span>
        </div>

        <p v-if="maintenanceError" class="form-message error-text" role="alert">{{ maintenanceError }}</p>
        <p v-if="maintenanceMessage" class="form-message success-text" role="status">{{ maintenanceMessage }}</p>

        <div class="form-actions">
          <span>{{ maintenanceLoading ? "Checking maintenance state…" : `${maintenance?.backups.length ?? 0} backup(s) available` }}</span>
          <button class="primary-button" type="button" :disabled="maintenanceLoading" @click="createDatabaseBackup" title="Make a complete copy of this app's local SQLite database and run SQLite's integrity check on the copy.">Create verified backup</button>
          <a class="ghost-button" href="/api/maintenance/audit/export" download title="Download a JSON history of task, run, model, permission, merge, usage-safety, ADR, experiment, backup, restore, and recovery metadata. Prompts and model output are excluded.">Download audit history</a>
        </div>

        <div v-if="maintenance?.pendingRestore" class="worktree-safety-note" role="status">
          <div><strong>Restore staged</strong><span>The live database is unchanged. Restart the application to apply the staged backup.</span></div>
          <button class="ghost-button" type="button" @click="cancelPendingRestore" title="Remove the staged restore request. The source backup remains available.">Cancel staged restore</button>
        </div>

        <div class="tool-grid maintenance-grid">
          <article class="tool-card">
            <strong>Database backups</strong>
            <small v-if="!maintenance?.backups.length">No backups yet.</small>
            <div v-for="backup in maintenance?.backups ?? []" :key="backup.name" class="maintenance-row">
              <span>{{ backup.name }} · {{ formatBytes(backup.sizeBytes) }} · {{ new Date(backup.createdAt).toLocaleString() }}</span>
              <button class="text-button" type="button" :disabled="maintenance?.pendingRestore" @click="stageDatabaseRestore(backup)" title="After confirmation, check this backup and stage it for the next application restart. The current live database is not overwritten now.">Stage restore</button>
            </div>
          </article>

          <article class="tool-card">
            <strong>Interrupted work</strong>
            <small>Startup automatically marks records abandoned by the previous server process as failed, preserves their output, and releases their process leases.</small>
            <span class="maintenance-state">Checked at this server start</span>
          </article>

          <article class="tool-card">
            <strong>Cleanup warnings</strong>
            <small>{{ maintenance?.errorWorktrees.length ?? 0 }} worktree error(s) · {{ maintenance?.staleUsageLeases.length ?? 0 }} stale lease(s)</small>
            <p v-for="worktree in maintenance?.errorWorktrees ?? []" :key="worktree.id" class="error-text">{{ worktree.path }} — {{ worktree.lastError ?? "Needs inspection" }}</p>
            <div v-for="lease in maintenance?.staleUsageLeases ?? []" :key="lease.id" class="maintenance-row">
              <span>{{ lease.ownerType }} {{ lease.ownerId }} · since {{ new Date(lease.startedAt).toLocaleString() }}</span>
              <button class="text-button" type="button" @click="releaseMaintenanceLease(lease)" title="Release this lease only after confirming its old process is no longer running. No worktree files are deleted.">Release stale lease</button>
            </div>
          </article>
        </div>
      </section>

      <section id="usage-dashboard" class="project-panel usage-dashboard-panel" aria-labelledby="usage-dashboard-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">10 — USAGE &amp; COST</p>
            <h2 id="usage-dashboard-heading">See where provider usage went.</h2>
            <p>Filter recorded runs, compare providers and workflows, and inspect exact or calculated token totals. Costs are API-equivalent estimates, never guessed subscription charges.</p>
          </div>
          <span class="safety-badge" title="Token totals identify whether they came directly from a provider, were calculated from exact counters, or were unavailable. Costs appear only when a matching versioned price exists.">LABELED SOURCES · NO GUESSING</span>
        </div>

        <details class="usage-settings-card">
          <summary title="Open local collection, display, budget-preset, and pricing controls.">Usage &amp; Cost settings</summary>
          <form class="usage-settings-form" @submit.prevent="saveUsageSettings">
            <label class="setting-toggle" title="When off, new runs keep an unavailable audit row but token counters and calculated cost are not collected."><input v-model="usageSettingsForm.trackUsage" type="checkbox" title="Turn token and cost collection for new runs on or off." /><span><strong>Track usage</strong><small>Collect provider-reported counters for new runs.</small></span></label>
            <label class="setting-toggle" title="Hide or show API-equivalent estimates in the interface. Previously calculated values stay stored."><input v-model="usageSettingsForm.showApiEquivalentCost" type="checkbox" title="Show API-equivalent cost estimates in dashboards and task cards." /><span><strong>Show API-equivalent cost</strong><small>Display estimates only when a matching price exists.</small></span></label>
            <label class="setting-toggle" title="Store the normalized provider token payload on new usage records for troubleshooting. Turning it off does not delete history."><input v-model="usageSettingsForm.storeRawTelemetry" type="checkbox" title="Keep or omit raw normalized usage metadata on new records." /><span><strong>Store raw usage telemetry</strong><small>Useful for auditing provider counter changes.</small></span></label>
            <label title="Budget preset automatically selected when a new task is created."><span>Default task budget</span><select v-model="usageSettingsForm.defaultBudgetPreset" title="Choose the starting budget for future tasks only."><option value="NONE">No budget</option><option value="ECONOMY">Economy</option><option value="BALANCED">Balanced</option><option value="DEEP">Deep</option></select></label>
            <label title="Warn when provider-plan usage reaches this percentage. The separate checkpoint threshold still controls blocking."><span>Default usage warning %</span><input v-model="policyForm.warningThresholdPercent" type="number" min="0" max="100" title="Choose the provider-plan warning threshold from 0 to 100 percent." /></label>
            <div v-for="preset in (['ECONOMY', 'BALANCED', 'DEEP'] as const)" :key="preset" class="preset-editor">
              <strong>{{ preset }}</strong>
              <label :title="`Maximum model calls in the ${preset.toLowerCase()} preset.`"><span>Runs</span><input v-model.number="usageSettingsForm.budgetPresets[preset].maxAgentRuns" type="number" min="1" max="1000" :title="`Set ${preset.toLowerCase()} maximum model runs.`" /></label>
              <label :title="`Maximum build/review rounds in the ${preset.toLowerCase()} preset.`"><span>Review rounds</span><input v-model.number="usageSettingsForm.budgetPresets[preset].maxReviewRounds" type="number" min="1" max="10" :title="`Set ${preset.toLowerCase()} maximum review rounds.`" /></label>
              <label :title="`Warning percentage for the ${preset.toLowerCase()} preset.`"><span>Warn at %</span><input v-model.number="usageSettingsForm.budgetPresets[preset].warningPercent" type="number" min="1" max="99" :title="`Set ${preset.toLowerCase()} warning percentage.`" /></label>
            </div>
            <button class="primary-button" type="submit" :disabled="usageSettingsSaving" title="Save these local settings and preset definitions. Existing task budget snapshots do not change.">{{ usageSettingsSaving ? "Saving…" : "Save settings" }}</button>
          </form>
          <p v-if="usageSettingsMessage" class="form-message success-text" role="status">{{ usageSettingsMessage }}</p>

          <details class="pricing-editor">
            <summary title="Add immutable per-model price versions and inspect the saved registry.">Pricing registry · {{ pricingEntries.length }} version(s)</summary>
            <form class="pricing-form" @submit.prevent="createPricingVersion">
              <label title="The provider whose model price is being recorded."><span>Provider</span><select v-model="pricingForm.provider" title="Choose Claude Code or Codex."><option value="CLAUDE">Claude Code</option><option value="CODEX">Codex</option></select></label>
              <label title="Exact model identifier reported by the provider."><span>Model ID</span><input v-model="pricingForm.model" required maxlength="200" title="Enter the exact provider model ID." /></label>
              <label title="USD price per one million ordinary input tokens."><span>Input / 1M</span><input v-model="pricingForm.inputPricePerMillion" type="number" min="0" step="0.000001" required title="Enter the input-token price per million." /></label>
              <label title="USD price per one million output tokens."><span>Output / 1M</span><input v-model="pricingForm.outputPricePerMillion" type="number" min="0" step="0.000001" required title="Enter the output-token price per million." /></label>
              <label title="Optional USD price per one million cached input tokens."><span>Cached input / 1M</span><input v-model="pricingForm.cachedInputPricePerMillion" type="number" min="0" step="0.000001" title="Enter a cached-input price or leave it blank." /></label>
              <label title="Optional USD price per one million cache-creation input tokens."><span>Cache creation / 1M</span><input v-model="pricingForm.cacheCreationInputPricePerMillion" type="number" min="0" step="0.000001" title="Enter a cache-creation price or leave it blank." /></label>
              <label title="Optional USD price per one million reasoning-output tokens."><span>Reasoning / 1M</span><input v-model="pricingForm.reasoningPricePerMillion" type="number" min="0" step="0.000001" title="Enter a reasoning-output price or leave it blank." /></label>
              <label title="When this price became valid. Leave blank to use the current time."><span>Effective from</span><input v-model="pricingForm.effectiveFrom" type="datetime-local" title="Choose the price's effective date and time, or leave it blank for now." /></label>
              <label title="Where this price came from, such as a provider pricing page and retrieval date."><span>Source</span><input v-model="pricingForm.source" required maxlength="1000" title="Record a human-readable source for this price version." /></label>
              <button class="text-button" type="submit" :disabled="pricingSaving" title="Add a new immutable price version. Existing usage snapshots are never silently recalculated.">{{ pricingSaving ? "Adding…" : "Add price version" }}</button>
            </form>
            <div class="pricing-list">
              <span v-for="entry in pricingEntries" :key="entry.id"><strong>{{ entry.provider }} · {{ entry.model }}</strong> · in {{ formatUsd(entry.inputPricePerMillion) }}/1M · out {{ formatUsd(entry.outputPricePerMillion) }}/1M · effective {{ new Date(entry.effectiveFrom).toLocaleString() }} · {{ entry.source }}</span>
            </div>
          </details>
        </details>

        <form class="usage-dashboard-filters" @submit.prevent="loadUsageDashboard">
          <label title="How much history to include in every card and table below.">
            <span>Period</span>
            <select v-model="usageDashboardPeriod" title="Choose a preset time period or select Custom to enter exact dates.">
              <option value="today">Today</option>
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="month">This month</option>
              <option value="all">All time</option>
              <option value="custom">Custom dates</option>
            </select>
          </label>
          <label title="Limit the dashboard to one registered project, or leave it on all projects.">
            <span>Project</span>
            <select v-model="usageDashboardProjectId" title="Choose one project or keep the combined workspace view." @change="onUsageDashboardProjectChange">
              <option value="">All projects</option>
              <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
            </select>
          </label>
          <label title="Limit the dashboard to one task. The list follows the selected project filter.">
            <span>Task</span>
            <select v-model="usageDashboardTaskId" title="Choose one task or keep all matching tasks and standalone runs.">
              <option value="">All tasks and runs</option>
              <option v-for="task in usageDashboardTaskOptions" :key="task.id" :value="task.id">{{ task.title }}</option>
            </select>
          </label>
          <template v-if="usageDashboardPeriod === 'custom'">
            <label title="The first local calendar day to include."><span>From</span><input v-model="usageDashboardFrom" type="date" title="Choose the first day to include." required /></label>
            <label title="The last local calendar day to include."><span>To</span><input v-model="usageDashboardTo" type="date" title="Choose the last day to include." required /></label>
          </template>
          <button class="primary-button" type="submit" :disabled="usageDashboardLoading" title="Refresh every usage card and table using these filters.">{{ usageDashboardLoading ? "Loading…" : "Apply filters" }}</button>
        </form>

        <p v-if="usageDashboardError" class="form-message error-text" role="alert">{{ usageDashboardError }}</p>
        <p v-if="usageDashboardLoading && !usageDashboard" class="empty-state">Loading usage history…</p>

        <template v-if="usageDashboard">
          <div class="usage-summary-grid">
            <article><span>Recorded runs</span><strong>{{ usageDashboard.summary.runs.toLocaleString() }}</strong><small>{{ usageDashboard.summary.exactTokenRuns }} with exact provider counters · {{ usageDashboard.summary.unavailableTokenRuns }} unavailable</small></article>
            <article><span>Total tokens</span><strong>{{ usageDashboard.summary.totalTokens.toLocaleString() }}</strong><small>Unavailable runs contribute no invented tokens.</small></article>
            <article><span>API-equivalent cost</span><strong>{{ formatAggregateCost(usageDashboard.summary.apiEquivalentCostUsd, usageDashboard.summary.calculatedCostRuns) }}</strong><small>{{ usageDashboard.summary.calculatedCostRuns }} priced · {{ usageDashboard.summary.unavailableCostRuns }} unavailable</small></article>
            <article><span>Average per task</span><strong>{{ formatNumber(usageDashboard.summary.averageTokensPerTask) }}</strong><small>Standalone runs are excluded from this average.</small></article>
            <article><span>Browser-enabled runs</span><strong>{{ usageDashboard.summary.browserEnabledRuns.toLocaleString() }}</strong><small>Browser-search counts are unavailable in current provider telemetry.</small></article>
          </div>

          <p v-if="usageDashboard.summary.runs === 0" class="empty-state">No recorded usage matches these filters.</p>

          <div v-else class="usage-dashboard-body">
            <div class="usage-breakdown-grid">
              <article v-for="group in [
                { title: 'BY PROVIDER', rows: usageDashboard.byProvider },
                { title: 'BY WORKFLOW', rows: usageDashboard.byWorkflow },
                { title: 'BY MODEL', rows: usageDashboard.byModel },
                { title: 'BY ROLE', rows: usageDashboard.byRole },
              ]" :key="group.title" class="usage-breakdown-card">
                <div class="subsection-heading"><span>{{ group.title }}</span><strong>{{ group.rows.length }} group(s)</strong></div>
                <div v-for="row in group.rows" :key="row.key" class="usage-breakdown-row">
                  <div><strong>{{ row.label }}</strong><small>{{ row.runs }} run(s)</small></div>
                  <div><strong>{{ row.tokens.toLocaleString() }}</strong><small>{{ formatAggregateCost(row.apiEquivalentCostUsd, row.calculatedCostRuns) }}<template v-if="row.unavailableCostRuns"> · {{ row.unavailableCostRuns }} unavailable</template></small></div>
                </div>
              </article>
            </div>

            <div class="usage-dashboard-grid">
              <article class="usage-dashboard-card">
                <div class="subsection-heading"><span>HIGHEST-USAGE TASKS</span><strong>TOP {{ usageDashboard.highestUsageTasks.length }}</strong></div>
                <p v-if="!usageDashboard.highestUsageTasks.length" class="form-hint">No task-linked usage in this period.</p>
                <div v-for="row in usageDashboard.highestUsageTasks" :key="row.taskId" class="usage-breakdown-row">
                  <div><strong>{{ row.label }}</strong><small>{{ projectName(row.projectId) }} · {{ row.runs }} run(s)</small></div>
                  <div><strong>{{ row.tokens.toLocaleString() }}</strong><small>{{ formatAggregateCost(row.apiEquivalentCostUsd, row.calculatedCostRuns) }}<template v-if="row.unavailableCostRuns"> · {{ row.unavailableCostRuns }} unavailable</template></small></div>
                </div>
              </article>

              <article class="usage-dashboard-card">
                <div class="subsection-heading"><span>EFFICIENCY</span><strong>CALCULATED</strong></div>
                <dl class="usage-efficiency-grid">
                  <div><dt>Tokens / completed task</dt><dd>{{ formatNumber(usageDashboard.efficiency.tokensPerCompletedTask) }}</dd></div>
                  <div><dt>Review tokens / round</dt><dd>{{ formatNumber(usageDashboard.efficiency.tokensPerReviewRound) }}</dd></div>
                  <div><dt>Review tokens / accepted finding</dt><dd>{{ formatNumber(usageDashboard.efficiency.tokensPerAcceptedFinding) }}</dd></div>
                  <div><dt>Tokens / implementation run</dt><dd>{{ formatNumber(usageDashboard.efficiency.tokensPerImplementationRun) }}</dd></div>
                  <div><dt>Cache-hit ratio</dt><dd>{{ formatPercent(usageDashboard.efficiency.cacheHitRatio) }}</dd></div>
                </dl>
              </article>
            </div>

            <article class="usage-timeline-card">
              <div class="subsection-heading"><span>DAILY TIMELINE</span><strong>{{ usageDashboard.timeline.length }} day(s)</strong></div>
              <div v-for="point in usageDashboard.timeline" :key="point.date" class="usage-timeline-row">
                <time :datetime="point.date">{{ point.date }}</time>
                <div class="usage-timeline-track" :title="`${point.tokens.toLocaleString()} tokens across ${point.runs} run(s)`"><span :style="{ width: `${Math.max(2, point.tokens / usageTimelineMaximum * 100)}%` }"></span></div>
                <strong>{{ point.tokens.toLocaleString() }}</strong>
                <small>{{ formatAggregateCost(point.apiEquivalentCostUsd, point.calculatedCostRuns) }}<template v-if="point.unavailableCostRuns"> · {{ point.unavailableCostRuns }} unavailable</template></small>
              </div>
            </article>

            <article class="usage-runs-card">
              <div class="subsection-heading"><span>RUN DETAILS</span><strong>{{ usageDashboard.runs.length }} RUN(S)</strong></div>
              <details v-for="run in usageDashboard.runs" :key="run.runId" class="usage-run-detail">
                <summary :title="`Open the token and cost details for this ${providerLabel(run.provider)} run.`">
                  <span>{{ providerLabel(run.provider) }} · {{ run.workflow.replaceAll('_', ' ') }}</span>
                  <strong>{{ run.tokens === null ? "Tokens unavailable" : `${run.tokens.toLocaleString()} tokens` }}</strong>
                  <small>{{ usageCostSettings?.showApiEquivalentCost === false ? "Cost hidden" : run.apiEquivalentCostUsd === null ? "Cost unavailable" : formatUsd(run.apiEquivalentCostUsd) }}</small>
                </summary>
                <dl class="usage-run-grid">
                  <div><dt>Task</dt><dd>{{ taskName(run.taskId) }}</dd></div>
                  <div><dt>Project</dt><dd>{{ projectName(run.projectId) }}</dd></div>
                  <div><dt>Model</dt><dd>{{ run.model }}</dd></div>
                  <div><dt>Role</dt><dd>{{ run.role }}</dd></div>
                  <div><dt>Status</dt><dd>{{ run.status }}</dd></div>
                  <div><dt>Recorded</dt><dd>{{ new Date(run.createdAt).toLocaleString() }}</dd></div>
                  <div><dt>Input</dt><dd>{{ formatNumber(run.inputTokens) }}</dd></div>
                  <div><dt>Cached input</dt><dd>{{ formatNumber(run.cachedInputTokens) }}</dd></div>
                  <div><dt>Cache creation</dt><dd>{{ formatNumber(run.cacheCreationTokens) }}</dd></div>
                  <div><dt>Output</dt><dd>{{ formatNumber(run.outputTokens) }}</dd></div>
                  <div><dt>Reasoning output</dt><dd>{{ formatNumber(run.reasoningOutputTokens) }}</dd></div>
                  <div><dt>Token source</dt><dd>{{ run.tokenSource }}</dd></div>
                  <div><dt>Cost source</dt><dd>{{ run.costSource }}</dd></div>
                  <div><dt>Duration</dt><dd>{{ run.durationMs === null ? "Unavailable" : `${(run.durationMs / 1000).toFixed(1)}s` }}</dd></div>
                  <div><dt>Browser access</dt><dd>{{ run.browserEnabled ? "Enabled" : "Disabled" }}</dd></div>
                  <div><dt>Browser searches</dt><dd>Unavailable</dd></div>
                </dl>
              </details>
            </article>
          </div>
        </template>
      </section>

    </main>
  </div>
</template>
