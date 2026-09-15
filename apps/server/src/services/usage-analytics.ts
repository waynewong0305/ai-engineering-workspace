import { totalInputTokens, totalProcessedTokens, type AgentProvider, type TokenUsage } from "@aiew/agents";
import type { WorkspaceDatabase } from "../db/database.js";
import { agentRuns, buildRuns, reviewFindings, tasks, usageRecords, type UsageRecordRecord } from "../db/schema.js";

export type UsagePeriod = "today" | "7d" | "30d" | "month" | "all" | "custom";
export type UsageDashboardFilters = {
  period: UsagePeriod;
  projectId?: string;
  taskId?: string;
  from?: string;
  to?: string;
};

export type UsageBreakdownRow = {
  key: string;
  label: string;
  runs: number;
  tokens: number;
  apiEquivalentCostUsd: number;
  calculatedCostRuns: number;
  unavailableCostRuns: number;
};

export type UsageDashboard = {
  range: { period: UsagePeriod; from: string | null; to: string | null };
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
  byProvider: UsageBreakdownRow[];
  byModel: UsageBreakdownRow[];
  byWorkflow: UsageBreakdownRow[];
  byRole: UsageBreakdownRow[];
  highestUsageTasks: Array<UsageBreakdownRow & { taskId: string; projectId: string }>;
  timeline: Array<{ date: string; runs: number; tokens: number; apiEquivalentCostUsd: number; calculatedCostRuns: number; unavailableCostRuns: number }>;
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

function tokensFromRecord(record: UsageRecordRecord): TokenUsage {
  return {
    ...(record.inputTokens === null ? {} : { inputTokens: record.inputTokens }),
    ...(record.cachedInputTokens === null ? {} : { cachedInputTokens: record.cachedInputTokens }),
    ...(record.cacheCreationTokens === null ? {} : { cacheCreationTokens: record.cacheCreationTokens }),
    ...(record.outputTokens === null ? {} : { outputTokens: record.outputTokens }),
    ...(record.reasoningOutputTokens === null ? {} : { reasoningOutputTokens: record.reasoningOutputTokens }),
    ...(record.totalTokens === null ? {} : { totalTokens: record.totalTokens }),
  };
}

export function workflowForPrompt(promptVersion: string): { key: string; label: string } {
  if (promptVersion.startsWith("brainstorm-analysis:")) return { key: "INDEPENDENT_ANALYSIS", label: "Independent analysis" };
  if (promptVersion.startsWith("cross-review:")) return { key: "CROSS_REVIEW", label: "Cross-review" };
  if (promptVersion.startsWith("code-review-recheck:")) return { key: "RE_REVIEW", label: "Re-review" };
  if (promptVersion.startsWith("code-review:")) return { key: "CODE_REVIEW", label: "Code review" };
  if (promptVersion.startsWith("build-response:")) return { key: "IMPLEMENTATION_RESPONSE", label: "Implementation response" };
  if (promptVersion.startsWith("build:")) return { key: "IMPLEMENTATION", label: "Implementation" };
  if (promptVersion.startsWith("experiment-")) return { key: "EXPERIMENT", label: "Experiment" };
  if (promptVersion.startsWith("repository-explanation")) return { key: "REPOSITORY_EXPLANATION", label: "Repository explanation" };
  if (promptVersion.startsWith("report-synthesis:")) return { key: "REPORT_SYNTHESIS", label: "Report synthesis" };
  return { key: "OTHER", label: "Other" };
}

function rangeFor(filters: UsageDashboardFilters, now: Date) {
  const to = filters.period === "custom" && filters.to ? new Date(filters.to) : now;
  let from: Date | null = null;
  if (filters.period === "today") from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (filters.period === "7d") from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000);
  if (filters.period === "30d") from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
  if (filters.period === "month") from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (filters.period === "custom" && filters.from) from = new Date(filters.from);
  return { from: from?.toISOString() ?? null, to: filters.period === "all" ? null : to.toISOString() };
}

type MeasuredRun = UsageDashboard["runs"][number] & { taskTitle: string | null; inputTotal: number | null; cachedTokens: number };

function grouped(rows: MeasuredRun[], keyOf: (row: MeasuredRun) => { key: string; label: string }): UsageBreakdownRow[] {
  const groups = new Map<string, UsageBreakdownRow>();
  for (const row of rows) {
    const { key, label } = keyOf(row);
    const group = groups.get(key) ?? {
      key, label, runs: 0, tokens: 0, apiEquivalentCostUsd: 0, calculatedCostRuns: 0, unavailableCostRuns: 0,
    };
    group.runs += 1;
    group.tokens += row.tokens ?? 0;
    group.apiEquivalentCostUsd += row.apiEquivalentCostUsd ?? 0;
    if (row.costSource === "CALCULATED") group.calculatedCostRuns += 1;
    else group.unavailableCostRuns += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label));
}

export function buildUsageDashboard(
  db: WorkspaceDatabase,
  filters: UsageDashboardFilters,
  now = new Date(),
): UsageDashboard {
  const range = rangeFor(filters, now);
  const runById = new Map(db.select().from(agentRuns).all().map((run) => [run.id, run]));
  const taskById = new Map(db.select().from(tasks).all().map((task) => [task.id, task]));
  const rows: MeasuredRun[] = [];

  for (const usage of db.select().from(usageRecords).all()) {
    const run = runById.get(usage.runId);
    if (!run) continue;
    if (filters.projectId && usage.projectId !== filters.projectId) continue;
    if (filters.taskId && usage.taskId !== filters.taskId) continue;
    if (range.from && usage.createdAt < range.from) continue;
    if (range.to && usage.createdAt > range.to) continue;
    const tokenUsage = tokensFromRecord(usage);
    const tokenTotal = totalProcessedTokens(usage.provider, tokenUsage);
    const inputTotal = totalInputTokens(usage.provider, tokenUsage);
    const workflow = workflowForPrompt(run.promptVersion);
    rows.push({
      runId: run.id,
      taskId: usage.taskId,
      projectId: usage.projectId,
      provider: usage.provider,
      model: usage.modelActual ?? usage.modelRequested ?? "Unknown model",
      role: usage.role,
      workflow: workflow.key,
      status: run.status,
      tokens: tokenTotal,
      tokenSource: usage.usageSource === "unavailable" || tokenTotal === null
        ? "UNAVAILABLE"
        : usage.totalTokens === null ? "CALCULATED" : "EXACT",
      apiEquivalentCostUsd: usage.apiEquivalentCostUsd,
      costSource: usage.costSource === "calculated" ? "CALCULATED" : "UNAVAILABLE",
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      outputTokens: usage.outputTokens,
      reasoningOutputTokens: usage.reasoningOutputTokens,
      durationMs: run.durationMs,
      browserEnabled: run.webAccessPermitted,
      browserSearchCount: null,
      createdAt: usage.createdAt,
      taskTitle: usage.taskId ? taskById.get(usage.taskId)?.title ?? "Unknown task" : null,
      inputTotal,
      cachedTokens: usage.cachedInputTokens ?? 0,
    });
  }

  const totalTokens = rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
  const apiEquivalentCostUsd = rows.reduce((sum, row) => sum + (row.apiEquivalentCostUsd ?? 0), 0);
  const taskIds = new Set(rows.filter((row) => row.taskId && row.tokens !== null).map((row) => row.taskId!));
  const byProvider = grouped(rows, (row) => ({ key: row.provider, label: row.provider === "CLAUDE" ? "Claude Code" : "Codex" }));
  const byModel = grouped(rows, (row) => ({ key: `${row.provider}:${row.model}`, label: `${row.model} (${row.provider === "CLAUDE" ? "Claude" : "Codex"})` }));
  const byWorkflow = grouped(rows, (row) => ({ key: row.workflow, label: workflowForPrompt(runById.get(row.runId)?.promptVersion ?? "").label }));
  const byRole = grouped(rows, (row) => ({ key: row.role, label: row.role.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase()) }));
  const highestUsageTasks = grouped(rows.filter((row) => row.taskId), (row) => ({ key: row.taskId!, label: row.taskTitle! }))
    .map((group) => ({ ...group, taskId: group.key, projectId: rows.find((row) => row.taskId === group.key)!.projectId }))
    .slice(0, 10);
  const timeline = grouped(rows, (row) => ({ key: row.createdAt.slice(0, 10), label: row.createdAt.slice(0, 10) }))
    .map((group) => ({
      date: group.key, runs: group.runs, tokens: group.tokens,
      apiEquivalentCostUsd: group.apiEquivalentCostUsd,
      calculatedCostRuns: group.calculatedCostRuns,
      unavailableCostRuns: group.unavailableCostRuns,
    }))
    .sort((left, right) => left.date.localeCompare(right.date));

  const scopedTaskIds = new Set(rows.map((row) => row.taskId).filter((id): id is string => Boolean(id)));
  const completedTasks = [...scopedTaskIds].filter((id) => taskById.get(id)?.status === "READY").length;
  const scopedBuilds = db.select().from(buildRuns).all().filter((build) => scopedTaskIds.has(build.taskId));
  const reviewRounds = scopedBuilds.reduce((sum, build) => sum + build.reviewRound, 0);
  const acceptedFindings = db.select().from(reviewFindings).all().filter((finding) =>
    scopedBuilds.some((build) => build.id === finding.buildRunId)
      && (finding.builderVerdict === "ACCEPTED" || finding.builderVerdict === "PARTIALLY_ACCEPTED"),
  ).length;
  const reviewTokens = rows.filter((row) => row.workflow === "CODE_REVIEW" || row.workflow === "RE_REVIEW")
    .reduce((sum, row) => sum + (row.tokens ?? 0), 0);
  const implementationRows = rows.filter((row) => row.workflow === "IMPLEMENTATION" || row.workflow === "IMPLEMENTATION_RESPONSE");
  const implementationTokens = implementationRows.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
  const totalInput = rows.reduce((sum, row) => sum + (row.inputTotal ?? 0), 0);
  const cachedInput = rows.reduce((sum, row) => sum + row.cachedTokens, 0);
  const latestTaskBuild = filters.taskId
    ? scopedBuilds.filter((build) => build.taskId === filters.taskId).sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    : null;

  return {
    range: { period: filters.period, ...range },
    summary: {
      runs: rows.length,
      totalTokens,
      exactTokenRuns: rows.filter((row) => row.tokenSource !== "UNAVAILABLE").length,
      unavailableTokenRuns: rows.filter((row) => row.tokenSource === "UNAVAILABLE").length,
      apiEquivalentCostUsd,
      calculatedCostRuns: rows.filter((row) => row.costSource === "CALCULATED").length,
      unavailableCostRuns: rows.filter((row) => row.costSource === "UNAVAILABLE").length,
      browserEnabledRuns: rows.filter((row) => row.browserEnabled).length,
      averageTokensPerTask: taskIds.size ? totalTokens / taskIds.size : null,
    },
    byProvider,
    byModel,
    byWorkflow,
    byRole,
    highestUsageTasks,
    timeline,
    efficiency: {
      tokensPerCompletedTask: completedTasks ? totalTokens / completedTasks : null,
      tokensPerReviewRound: reviewRounds ? reviewTokens / reviewRounds : null,
      tokensPerAcceptedFinding: acceptedFindings ? reviewTokens / acceptedFindings : null,
      tokensPerImplementationRun: implementationRows.length ? implementationTokens / implementationRows.length : null,
      cacheHitRatio: totalInput ? cachedInput / totalInput : null,
    },
    taskReviewRounds: latestTaskBuild ? { current: latestTaskBuild.reviewRound, maximum: latestTaskBuild.maxReviewRounds } : null,
    runs: rows.map(({ taskTitle: _taskTitle, inputTotal: _inputTotal, cachedTokens: _cachedTokens, ...row }) => row),
  };
}
