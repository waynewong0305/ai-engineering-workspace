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
};

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
type TaskArtifact = {
  id: string;
  kind: "ANALYSIS" | "CROSS_REVIEW";
  provider: AgentProvider;
  targetProvider: AgentProvider | null;
  structuredData: BrainstormAnalysis | CrossReview | null;
  rawOutput: string;
  parseError: string | null;
};
type EvidenceItem = {
  id: string;
  type: "FACT" | "ASSUMPTION" | "QUESTION" | "DECISION" | "EXPERIMENT_RESULT";
  content: string;
  sourceProvider: AgentProvider | null;
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
  comparison?: {
    consensus: string[];
    disagreements: string[];
    openQuestions: string[];
    missingEvidence: string[];
    recommendedExperiments: string[];
  } | null;
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
  source: "CLI_REPORTED" | "MANUAL" | "RATE_LIMIT_ERROR" | null;
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
const taskMessage = ref("");
const creatingTask = ref(false);
const startingTask = ref(false);
const evidenceType = ref<EvidenceItem["type"]>("FACT");
const evidenceContent = ref("");
const editingEvidenceId = ref("");
const editingEvidenceContent = ref("");
const editingEvidenceType = ref<EvidenceItem["type"]>("FACT");
const taskForm = reactive({
  projectId: "",
  title: "Database horizontal scaling",
  type: "ARCHITECTURE" as "BRAINSTORM" | "ARCHITECTURE",
  riskLevel: "HIGH" as BrainstormTask["riskLevel"],
  problemStatement: "How should this system support database sharding?",
  webAccessPermitted: false,
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

function providerLabel(provider: AgentProvider) {
  return provider === "CLAUDE" ? "Claude Code" : "Codex";
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

async function refreshUsage(provider: AgentProvider) {
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

async function selectTask(taskId: string) {
  taskError.value = "";
  const response = await fetch(`/api/tasks/${taskId}`);
  if (!response.ok) {
    taskError.value = "Could not load the task.";
    return;
  }
  selectedTask.value = await response.json();
  const index = tasks.value.findIndex((task) => task.id === taskId);
  if (index >= 0) tasks.value[index] = selectedTask.value!;
  scheduleTaskRefresh();
}

function scheduleTaskRefresh() {
  if (taskPollTimer !== null) window.clearTimeout(taskPollTimer);
  if (!selectedTask.value || !["ANALYZING", "CROSS_REVIEW"].includes(selectedTask.value.status)) return;
  taskPollTimer = window.setTimeout(async () => {
    if (selectedTask.value) await selectTask(selectedTask.value.id);
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

async function cancelBrainstorm() {
  if (!selectedTask.value) return;
  const response = await fetch(`/api/tasks/${selectedTask.value.id}/cancel`, { method: "POST" });
  const result = await response.json();
  if (!response.ok) taskError.value = result.message ?? "Could not cancel the task.";
  await selectTask(selectedTask.value.id);
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

onMounted(() => Promise.all([loadHealth(), loadProjects(), loadAgentHealth(), loadTasks(), loadUsage()]));
onUnmounted(() => {
  eventSource?.close();
  if (taskPollTimer !== null) window.clearTimeout(taskPollTimer);
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
        <a class="nav-item active" href="#projects"><span>01</span>Projects</a>
        <a class="nav-item" href="#agent-runs"><span>02</span>Agent runs</a>
        <a class="nav-item" href="#brainstorm"><span>03</span>Brainstorm</a>
        <a class="nav-item" href="#worktrees"><span>04</span>Worktrees</a>
        <a class="nav-item" href="#usage-safety"><span>05</span>Usage safety</a>
        <a class="nav-item disabled" href="#build" aria-disabled="true"><span>06</span>Build</a>
        <a class="nav-item disabled" href="#reviews" aria-disabled="true"><span>07</span>Reviews</a>
        <a class="nav-item disabled" href="#decisions" aria-disabled="true"><span>08</span>Decisions</a>
      </nav>

      <div class="sidebar-foot">
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
        <button class="ghost-button" type="button" @click="recheckTools">Recheck tools</button>
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
        <div class="readiness-card">
          <span>Local readiness</span>
          <strong>{{ loading ? "Checking…" : `${connectedCount}/3 tools found` }}</strong>
          <p v-if="healthError" class="error-text">{{ healthError }}</p>
          <p v-else>Database {{ health?.database ?? "checking" }} · Web access asks first</p>
        </div>
      </section>

      <section class="tool-grid" aria-label="Local tool status">
        <article v-for="(tool, name) in health?.tools" :key="name" class="tool-card">
          <div>
            <span :class="['status-light', tool.available ? 'ok' : 'missing']"></span>
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
          <span class="safety-badge">READ ONLY</span>
        </div>

        <form class="project-form" @submit.prevent="registerProject">
          <label>
            <span>Repository path <strong>Required</strong></span>
            <input v-model="form.repositoryPath" required placeholder="/Users/you/Projects/example" autocomplete="off" />
          </label>
          <label>
            <span>Project name <small>Uses folder name when blank</small></span>
            <input v-model="form.name" placeholder="Example Web" autocomplete="off" />
          </label>
          <div class="field-row">
            <label>
              <span>Default branch <small>Auto-detect</small></span>
              <input v-model="form.defaultBranch" placeholder="main" autocomplete="off" />
            </label>
            <label>
              <span>Worktree root <small>Suggested when blank</small></span>
              <input v-model="form.worktreeRoot" placeholder="/Users/you/Projects/.ai-worktrees/example" autocomplete="off" />
            </label>
          </div>
          <label>
            <span>Project context <small>Optional guidance for future agent runs</small></span>
            <textarea v-model="form.projectContext" rows="3" placeholder="Architecture notes, conventions, important boundaries…"></textarea>
          </label>

          <fieldset>
            <legend>Validation commands <small>Stored only; not run during registration</small></legend>
            <div class="command-grid">
              <label><span>Tests</span><input v-model="form.tests" placeholder="npm test" autocomplete="off" /></label>
              <label><span>Lint</span><input v-model="form.lint" placeholder="npm run lint" autocomplete="off" /></label>
              <label><span>Build</span><input v-model="form.build" placeholder="npm run build" autocomplete="off" /></label>
            </div>
          </fieldset>

          <p v-if="submitError" class="form-message error-text" role="alert">{{ submitError }}</p>
          <p v-if="successMessage" class="form-message success-text" role="status">{{ successMessage }}</p>
          <div class="form-actions">
            <span>Web access defaults to <b>Ask before use</b> for future tasks.</span>
            <button class="primary-button" type="submit" :disabled="submitting">
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
                <span :class="['repo-state', project.gitStatus.toLowerCase()]">{{ project.gitStatus }}</span>
              </div>
              <code>{{ project.repositoryPath }}</code>
              <p v-if="project.projectContext">{{ project.projectContext }}</p>
            </div>
            <dl>
              <div><dt>Current branch</dt><dd>{{ project.currentBranch }}</dd></div>
              <div><dt>Default branch</dt><dd>{{ project.defaultBranch }}</dd></div>
              <div><dt>Checks saved</dt><dd>{{ project.validationCommands.length }}</dd></div>
            </dl>
            <div class="project-actions">
              <button class="ghost-button" type="button" @click="recheckProject(project)">Recheck Git</button>
              <button class="ghost-button" type="button" @click="editProject(project)">{{ editingProjectId === project.id ? "Editing" : "Edit" }}</button>
              <button class="text-button danger-button" type="button" :disabled="deletingProjectId === project.id" @click="deregisterProject(project)">
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
          <span class="safety-badge">READ ONLY · NO WEB</span>
        </div>

        <form class="project-form" @submit.prevent="startAgentRun">
          <div class="field-row">
            <label>
              <span>Registered project</span>
              <select v-model="selectedProjectId" required>
                <option disabled value="">Select a project</option>
                <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
            </label>
            <label>
              <span>Provider</span>
              <select v-model="selectedProvider">
                <option value="CODEX">Codex</option>
                <option value="CLAUDE">Claude Code</option>
              </select>
            </label>
          </div>
          <div class="provider-readiness">
            <span :class="['status-light', agentHealth[selectedProvider]?.authenticated ? 'ok' : 'missing']"></span>
            <strong>{{ selectedProvider === "CODEX" ? "Codex" : "Claude Code" }}</strong>
            <span v-if="agentHealth[selectedProvider]?.authenticated">Ready · {{ agentHealth[selectedProvider]?.cliVersion }}</span>
            <span v-else>{{ agentHealth[selectedProvider]?.message ?? "Provider is not ready." }}</span>
          </div>
          <label>
            <span>Prompt</span>
            <textarea v-model="agentPrompt" rows="4" required maxlength="20000"></textarea>
          </label>
          <div class="field-row">
            <label>
              <span>Model <small>Blank uses provider default</small></span>
              <input v-model="agentModel" placeholder="Provider default" autocomplete="off" />
            </label>
            <label>
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
            <button class="primary-button" type="submit" :disabled="startingRun || !selectedProjectId || !agentHealth[selectedProvider]?.authenticated">
              {{ startingRun ? "Starting…" : "Run explanation" }}
            </button>
          </div>
        </form>

        <article v-if="currentRun" class="run-console" aria-live="polite">
          <div class="run-console-heading">
            <div><span>RUN STATUS</span><strong>{{ currentRun.status }}</strong></div>
            <button v-if="['QUEUED', 'RUNNING'].includes(currentRun.status)" class="ghost-button" type="button" @click="cancelAgentRun">Cancel</button>
          </div>
          <pre v-if="currentRun.output">{{ currentRun.output }}</pre>
          <p v-else-if="['QUEUED', 'RUNNING'].includes(currentRun.status)">Waiting for agent output…</p>
          <p v-if="currentRun.errorMessage" class="error-text">{{ currentRun.errorMessage }}</p>
          <details v-if="currentRun.errorOutput"><summary>Process messages</summary><pre>{{ currentRun.errorOutput }}</pre></details>
          <small v-if="currentRun.durationMs !== null">Completed in {{ (currentRun.durationMs / 1000).toFixed(1) }}s</small>
        </article>
      </section>

      <section id="brainstorm" class="project-panel brainstorm-panel" aria-labelledby="brainstorm-heading">
        <div class="panel-heading">
          <div>
            <p class="section-index">03 — INDEPENDENT BRAINSTORMING</p>
            <h2 id="brainstorm-heading">Turn disagreement into an engineering artifact.</h2>
            <p>Claude and Codex analyze independently, review each other only afterward, and remain read-only throughout.</p>
          </div>
          <span class="safety-badge">4 RUNS · READ ONLY</span>
        </div>

        <form class="project-form" @submit.prevent="createTask">
          <div class="field-row task-first-row">
            <label>
              <span>Registered project</span>
              <select v-model="taskForm.projectId" required>
                <option disabled value="">Select a project</option>
                <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
              </select>
            </label>
            <label>
              <span>Task title</span>
              <input v-model="taskForm.title" maxlength="160" required autocomplete="off" />
            </label>
          </div>
          <div class="field-row">
            <label>
              <span>Task type</span>
              <select v-model="taskForm.type">
                <option value="BRAINSTORM">Brainstorm</option>
                <option value="ARCHITECTURE">Architecture</option>
              </select>
            </label>
            <label>
              <span>Risk level</span>
              <select v-model="taskForm.riskLevel">
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </label>
          </div>
          <label>
            <span>Problem statement</span>
            <textarea v-model="taskForm.problemStatement" rows="5" maxlength="20000" required></textarea>
          </label>

          <fieldset class="web-decision">
            <legend>Web access <small>Required decision · recorded with this task</small></legend>
            <div class="choice-grid">
              <label :class="['choice-card', { selected: !taskForm.webAccessPermitted }]">
                <input v-model="taskForm.webAccessPermitted" class="radio-input" type="radio" :value="false" />
                <span><strong>No web access</strong><small>Use only the registered repository and supplied context.</small></span>
              </label>
              <label :class="['choice-card', { selected: taskForm.webAccessPermitted }]">
                <input v-model="taskForm.webAccessPermitted" class="radio-input" type="radio" :value="true" />
                <span><strong>Allow for this task</strong><small>Both agents may use their built-in web tools for this task only.</small></span>
              </label>
            </div>
          </fieldset>

          <p v-if="taskError" class="form-message error-text" role="alert">{{ taskError }}</p>
          <p v-if="taskMessage" class="form-message success-text" role="status">{{ taskMessage }}</p>
          <div class="form-actions">
            <span>Creating a draft is free. Provider usage begins only when you start the analysis.</span>
            <button class="primary-button" type="submit" :disabled="creatingTask || !taskForm.projectId">
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
              <small>{{ task.status }}</small>
            </button>
          </aside>

          <div v-if="selectedTask" class="task-detail">
            <div class="task-detail-heading">
              <div>
                <span>{{ selectedTask.type }} · {{ selectedTask.riskLevel }} RISK</span>
                <h3>{{ selectedTask.title }}</h3>
                <p>{{ selectedTask.problemStatement }}</p>
              </div>
              <span :class="['task-status', selectedTask.status.toLowerCase()]">{{ selectedTask.status }}</span>
            </div>

            <div class="stage-track" aria-label="Workflow stages">
              <div :class="{ current: selectedTask.status === 'DRAFT', complete: selectedTask.status !== 'DRAFT' }"><span>01</span><strong>Draft</strong></div>
              <div :class="{ current: selectedTask.status === 'ANALYZING', complete: ['CROSS_REVIEW', 'READY'].includes(selectedTask.status) }"><span>02</span><strong>Independent</strong></div>
              <div :class="{ current: selectedTask.status === 'CROSS_REVIEW', complete: selectedTask.status === 'READY' }"><span>03</span><strong>Cross-review</strong></div>
              <div :class="{ current: selectedTask.status === 'READY', complete: selectedTask.status === 'READY' }"><span>04</span><strong>Compare</strong></div>
            </div>

            <div v-if="usageBlockedDecision" class="usage-checkpoint-block" role="alert">
              <span>USAGE SAFETY CHECKPOINT</span>
              <strong>{{ usageBlockedDecision.provider === 'CLAUDE' ? 'Claude Code' : 'Codex' }} · {{ usageStatusLabel(usageBlockedDecision.status) }}</strong>
              <p>{{ usageBlockedDecision.reason }}</p>
              <button
                v-if="usageBlockedDecision.requiresAcknowledgement"
                class="danger-outline-button" type="button"
                :disabled="acknowledging"
                @click="acknowledgeUsageAndRetryStart"
              >{{ acknowledging ? "Acknowledging…" : "Acknowledge and continue" }}</button>
              <p v-else class="form-hint">A reliably exhausted provider cannot be overridden. Wait for reset, or record a fresh reading once capacity is confirmed.</p>
            </div>

            <div class="web-audit">
              <span>WEB DECISION</span>
              <strong>{{ selectedTask.webAccessPermitted ? "Allowed for this task" : "Disabled" }}</strong>
              <small>Recorded {{ new Date(selectedTask.webAccessDecidedAt).toLocaleString() }}</small>
            </div>

            <div v-if="selectedTask.status === 'DRAFT'" class="launch-box">
              <div class="field-row">
                <label><span>Claude model <small>Blank uses default</small></span><input v-model="taskForm.claudeModel" placeholder="Provider default" /></label>
                <label><span>Codex model <small>Blank uses default</small></span><input v-model="taskForm.codexModel" placeholder="Provider default" /></label>
              </div>
              <label>
                <span>Claude effort <small>Optional</small></span>
                <select v-model="taskForm.claudeEffort">
                  <option value="">Provider default</option>
                  <option v-for="effort in agentHealth.CLAUDE?.capabilities.availableEffortLevels ?? []" :key="effort" :value="effort">{{ effort }}</option>
                </select>
              </label>
              <div class="provider-pair">
                <span><i :class="['status-light', agentHealth.CLAUDE?.authenticated ? 'ok' : 'missing']"></i>Claude {{ agentHealth.CLAUDE?.authenticated ? "ready" : "not ready" }}</span>
                <span><i :class="['status-light', agentHealth.CODEX?.authenticated ? 'ok' : 'missing']"></i>Codex {{ agentHealth.CODEX?.authenticated ? "ready" : "not ready" }}</span>
              </div>
              <p class="usage-preflight-note">
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
              >{{ startingTask ? "Starting…" : "Start independent analyses" }}</button>
              <small>This deliberately starts up to four paid/provider runs: two analyses followed by two reviews.</small>
            </div>

            <div v-if="['ANALYZING', 'CROSS_REVIEW'].includes(selectedTask.status)" class="live-stages">
              <div><span>Claude analysis</span><strong>{{ runStatus('CLAUDE', 'INDEPENDENT_ANALYSIS') }}</strong></div>
              <div><span>Codex analysis</span><strong>{{ runStatus('CODEX', 'INDEPENDENT_ANALYSIS') }}</strong></div>
              <div><span>Claude review</span><strong>{{ runStatus('CLAUDE', 'CROSS_REVIEW') }}</strong></div>
              <div><span>Codex review</span><strong>{{ runStatus('CODEX', 'CROSS_REVIEW') }}</strong></div>
              <button class="ghost-button" type="button" @click="cancelBrainstorm">Cancel workflow</button>
            </div>

            <div v-if="selectedTask.status === 'CHECKPOINTED'" class="live-stages checkpointed">
              <p>
                This workflow paused at a usage-safety checkpoint rather than continuing blind. Everything completed so
                far is saved. Resolve the checkpoint above (acknowledge, wait for reset, or record a fresh reading), then
                resume — nothing already completed is re-run.
              </p>
              <div class="provider-pair">
                <button class="primary-button" type="button" :disabled="startingTask" @click="resumeBrainstorm">
                  {{ startingTask ? "Resuming…" : "Resume workflow" }}
                </button>
                <button class="ghost-button" type="button" @click="cancelBrainstorm">Cancel workflow</button>
              </div>
            </div>
            <p v-if="selectedTask.errorMessage" class="form-message error-text">{{ selectedTask.errorMessage }}</p>

            <div v-if="analysisFor('CLAUDE') || analysisFor('CODEX')" class="analysis-section">
              <div class="subsection-heading"><span>INDEPENDENT OUTPUTS</span><strong>Kept separate until both completed</strong></div>
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
            </div>

            <div v-if="reviewFor('CLAUDE') || reviewFor('CODEX')" class="review-section">
              <div class="subsection-heading"><span>RECIPROCAL REVIEWS</span><strong>Each reviews the other</strong></div>
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
            </div>

            <div v-if="selectedTask.comparison" class="comparison-section">
              <div class="subsection-heading"><span>TRANSPARENT COMPARISON</span><strong>No automatic winner</strong></div>
              <div class="comparison-grid">
                <article v-for="(items, label) in selectedTask.comparison" :key="label">
                  <h4>{{ String(label).replace(/([A-Z])/g, ' $1') }}</h4>
                  <ul v-if="items.length"><li v-for="item in items" :key="item">{{ item }}</li></ul>
                  <p v-else>No item was asserted by the structured reviews.</p>
                </article>
              </div>
            </div>

            <div class="evidence-board">
              <div class="subsection-heading"><span>ASSUMPTION / EVIDENCE BOARD</span><strong>{{ selectedTask.evidence?.length ?? 0 }} records</strong></div>
              <form class="evidence-form" @submit.prevent="addEvidence">
                <select v-model="evidenceType">
                  <option value="FACT">Fact</option><option value="ASSUMPTION">Assumption</option>
                  <option value="QUESTION">Question</option><option value="DECISION">Decision</option>
                  <option value="EXPERIMENT_RESULT">Experiment result</option>
                </select>
                <input v-model="evidenceContent" maxlength="5000" placeholder="Add a human correction, fact, question, decision, or experiment result…" />
                <button class="ghost-button" type="submit">Add record</button>
              </form>
              <div class="evidence-list">
                <article v-for="item in selectedTask.evidence" :key="item.id" class="evidence-item">
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
                    <button class="ghost-button" type="button" @click="saveEvidence(item)">Save</button>
                  </template>
                  <template v-else>
                    <p>{{ item.content }}</p>
                    <small>{{ item.sourceProvider ? `From ${item.sourceProvider}` : "Human record" }}</small>
                    <button class="text-button" type="button" @click="editEvidence(item)">Edit</button>
                  </template>
                </article>
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
          <span class="safety-badge">EXPLICIT CREATE · SAFE CLEANUP</span>
        </div>

        <div class="worktree-task-picker">
          <label>
            <span>Task</span>
            <select v-model="selectedWorktreeTaskId" :disabled="worktreeLoading" @change="loadWorktreesForTask">
              <option disabled value="">Select a task</option>
              <option v-for="task in tasks" :key="task.id" :value="task.id">{{ task.title }}</option>
            </select>
          </label>
          <div class="worktree-safety-note">
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
              <span :class="['worktree-state', managedFor(provider)?.status.toLowerCase() ?? (proposalFor(provider)?.available ? 'available' : 'blocked')]">
                {{ managedFor(provider)?.status ?? (proposalFor(provider)?.available ? 'AVAILABLE' : 'BLOCKED') }}
              </span>
            </header>

            <label>
              <span>Directory path <small>Editable before creation</small></span>
              <input v-model="worktreeDrafts[provider].path" :readonly="Boolean(managedFor(provider))" autocomplete="off" />
            </label>
            <label>
              <span>Branch name <small>Independent from the path</small></span>
              <input v-model="worktreeDrafts[provider].branchName" :readonly="Boolean(managedFor(provider))" autocomplete="off" />
            </label>
            <label>
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
            >{{ creatingWorktree === provider ? 'Creating…' : `Create ${provider === 'CLAUDE' ? 'Claude' : 'Codex'} worktree` }}</button>
            <button v-else class="ghost-button" type="button" @click="selectManagedWorktree(managedFor(provider)!)">Inspect and manage</button>
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
              <span :class="selectedWorktree.inspection?.gitStatus === 'CLEAN' ? 'clean' : 'dirty'">
                {{ selectedWorktree.inspection?.gitStatus ?? selectedWorktree.status }}
              </span>
              <span :class="selectedWorktree.inUse ? 'busy' : 'idle'">{{ selectedWorktree.inUse ? 'IN USE' : 'IDLE' }}</span>
            </div>
          </div>
          <p v-if="selectedWorktree.inspectionError" class="error-text" role="alert">{{ selectedWorktree.inspectionError }}</p>
          <p v-if="selectedWorktree.lastError" class="error-text" role="alert">Last error: {{ selectedWorktree.lastError }}</p>
          <p v-if="!selectedWorktree.inspection" class="form-hint">
            Git no longer reports a live worktree at this path. Directory move and branch rename are disabled; use removal below to clear the stale record.
          </p>

          <div v-if="selectedWorktree.activeUsages.length" class="worktree-usages">
            <div class="subsection-heading"><span>ACTIVE USAGE LEASES</span></div>
            <ul>
              <li v-for="lease in selectedWorktree.activeUsages" :key="lease.id" :class="{ stale: lease.stale }">
                <span>{{ lease.ownerType }} · {{ lease.ownerId }} · started {{ new Date(lease.startedAt).toLocaleString() }}</span>
                <span v-if="lease.stale" class="usage-stale-label">STALE — no update in over 6 hours</span>
                <button class="text-button" type="button" @click="releaseUsage(lease.id)">Release lease</button>
              </li>
            </ul>
          </div>

          <div class="worktree-management-grid">
            <form @submit.prevent="renameWorktreePath">
              <label><span>Move directory <small>Branch stays unchanged</small></span><input v-model="renamePath" required /></label>
              <button
                class="ghost-button" type="submit"
                :disabled="selectedWorktree.inUse || !selectedWorktree.inspection || selectedWorktree.inspection.gitStatus === 'DIRTY'"
              >Move directory</button>
              <p v-if="selectedWorktree.inUse" class="form-hint">Disabled: an active process is using this worktree.</p>
              <p v-else-if="selectedWorktree.inspection?.gitStatus === 'DIRTY'" class="form-hint">Disabled: the worktree has uncommitted changes.</p>
            </form>
            <form @submit.prevent="renameWorktreeBranch">
              <label><span>Rename branch <small>Directory stays unchanged</small></span><input v-model="renameBranch" required /></label>
              <button
                class="ghost-button" type="submit"
                :disabled="selectedWorktree.inUse || !selectedWorktree.inspection || selectedWorktree.inspection.gitStatus === 'DIRTY'"
              >Rename branch</button>
              <p v-if="selectedWorktree.inUse" class="form-hint">Disabled: an active process is using this worktree.</p>
              <p v-else-if="selectedWorktree.inspection?.gitStatus === 'DIRTY'" class="form-hint">Disabled: the worktree has uncommitted changes.</p>
            </form>
          </div>

          <div class="worktree-diff">
            <div class="subsection-heading"><span>LOCAL DIFF</span><button class="text-button" type="button" @click="loadWorktreeDiff(selectedWorktree.id)">Refresh</button></div>
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
            <button v-if="removalArmedId !== selectedWorktree.id" class="danger-outline-button" type="button" @click="armWorktreeRemoval(selectedWorktree)">Prepare removal</button>
            <div v-else class="cleanup-confirmation">
              <label class="check-row"><input v-model="removalConfirmed" type="checkbox" />I confirm this worktree should be removed.</label>
              <label class="check-row"><input v-model="deleteMergedBranch" type="checkbox" />Also delete the branch, but only if Git reports it merged.</label>
              <div>
                <button class="text-button" type="button" @click="removalArmedId = ''">Cancel</button>
                <button class="danger-outline-button" type="button" :disabled="!removalConfirmed" @click="removeWorktree">Remove clean worktree</button>
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
              tokens-per-minute limits. No supported local command reports exact usage today, so automatic refresh
              honestly reports unavailable; use a manual snapshot to record what the provider's own interface shows you.
            </p>
          </div>
          <span class="safety-badge">CHECK BEFORE EVERY CALL</span>
        </div>

        <p v-if="usageError" class="form-message error-text" role="alert">{{ usageError }}</p>
        <p v-if="usageMessage" class="form-message success-text" role="status">{{ usageMessage }}</p>
        <p v-if="usageLoading" class="worktree-loading">Loading provider usage…</p>

        <div class="usage-grid">
          <article v-for="provider in (['CLAUDE', 'CODEX'] as AgentProvider[])" :key="provider" class="usage-card">
            <header>
              <strong>{{ providerLabel(provider) }}</strong>
              <button class="text-button" type="button" :disabled="refreshingProvider !== null" @click="refreshUsage(provider)">
                {{ refreshingProvider === provider ? "Refreshing…" : "Refresh" }}
              </button>
            </header>

            <div v-for="window in usage[provider]" :key="window.windowId" class="usage-window">
              <div class="usage-window-heading">
                <span>{{ window.windowLabel }}</span>
                <span :class="['usage-state', window.status.toLowerCase()]">{{ usageStatusLabel(window.status) }}</span>
              </div>
              <div class="usage-bar" role="progressbar" :aria-valuenow="window.usedPercent ?? 0" aria-valuemin="0" aria-valuemax="100"
                :aria-valuetext="window.usedPercent === null ? 'No data' : `${window.usedPercent}% used`">
                <div class="usage-bar-fill" :class="window.status.toLowerCase()" :style="{ width: `${window.usedPercent ?? 0}%` }"></div>
              </div>
              <dl class="usage-detail-grid">
                <div><dt>Used</dt><dd>{{ window.usedPercent === null ? "Unknown" : `${window.usedPercent}%` }}</dd></div>
                <div><dt>Remaining</dt><dd>{{ window.remainingPercent === null ? "Unknown" : `${window.remainingPercent}%` }}</dd></div>
                <div><dt>Resets</dt><dd>{{ window.timeUntilReset ? `in ${window.timeUntilReset}` : "Unknown" }}</dd></div>
                <div><dt>Source</dt><dd>{{ window.source ?? "None yet" }}<template v-if="window.sourceConfidence"> · {{ window.sourceConfidence }}</template></dd></div>
                <div><dt>Last updated</dt><dd>{{ window.lastRefreshedAt ? new Date(window.lastRefreshedAt).toLocaleString() : "Never" }}</dd></div>
                <div><dt>Freshness</dt><dd>{{ window.freshness }}</dd></div>
              </dl>
            </div>

            <form class="usage-manual-form" @submit.prevent="submitManualSnapshot(provider)">
              <div class="field-row">
                <label><span>Window</span><input v-model="manualSnapshotForm[provider].windowId" placeholder="5H" maxlength="40" required /></label>
                <label><span>Label</span><input v-model="manualSnapshotForm[provider].windowLabel" placeholder="5-hour window" maxlength="120" required /></label>
              </div>
              <div class="field-row">
                <label><span>Used % <small>From the provider's own display</small></span><input v-model="manualSnapshotForm[provider].usedPercent" type="number" min="0" max="100" step="1" required /></label>
                <label><span>Resets at <small>Optional</small></span><input v-model="manualSnapshotForm[provider].resetAt" type="datetime-local" /></label>
              </div>
              <button class="ghost-button" type="submit">Submit manual snapshot</button>
              <p class="form-hint">Manual readings are estimates you enter yourself; they are labeled MANUAL and never confused with an automatic reading.</p>
            </form>
          </article>
        </div>

        <form class="usage-policy-form" @submit.prevent="updateUsagePolicy">
          <div class="subsection-heading"><span>SAFETY THRESHOLDS</span><strong>Applies to both providers</strong></div>
          <div class="field-row">
            <label><span>Warning threshold %</span><input v-model="policyForm.warningThresholdPercent" type="number" min="0" max="100" required /></label>
            <label><span>Checkpoint threshold %</span><input v-model="policyForm.checkpointThresholdPercent" type="number" min="0" max="100" required /></label>
          </div>
          <button class="ghost-button" type="submit">Update thresholds</button>
        </form>
      </section>
    </main>
  </div>
</template>
