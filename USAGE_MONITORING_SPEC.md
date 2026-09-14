# Usage, Token, and Cost Monitoring — Phase 8 Spec

Status: **IN PROGRESS**. The human explicitly pulled this phase forward on 2026-09-13; per-run
token capture, historical backfill, automatic Claude plan-usage readings, and the centralized
pricing/API-equivalent-cost slice are complete. The dashboard, cross-review breakdown, budgets,
and Usage & Cost settings remain. This document is the authoritative, self-contained spec for that work;
`IMPLEMENTATION_ROADMAP.md` and `IMPLEMENTATION_STATUS.md` only link here rather than duplicating it
(per this repo's own documentation policy).

This spec is written to be actionable by either a Claude Code agent or a Codex agent — it does not
assume which one executes it. All existing `AGENTS.md`/`CLAUDE.md` policy (provider-neutral
workflow code, worktree isolation rules, usage-safety gating, verification commands, commit/phase
discipline, temporary-repository test requirement) applies unchanged to this phase's own
implementation work.

## Why this phase exists

The user wants to know how much Claude Code and Codex usage this workspace consumes — by
workspace, project, task, agent role, and individual run — across every workflow type it already
supports (brainstorming, architecture discussion, planning, building, review, cross-review,
re-review, experiments/investigation). The system must clearly distinguish actual provider-reported
token usage from subscription-plan allowance, API-billed usage, estimated API-equivalent cost, and
genuinely unavailable metrics — and must never present an estimate as an exact figure.

## Step 0 — Re-investigate before writing any code

CLI capabilities drift between versions. Do not trust this document's or any prior document's
memory of what `claude`/`codex` expose. Before implementing anything:

1. Run `claude --version`, `claude --help`, `codex --version`, `codex --help` against whatever is
   installed at execution time and read the current `ClaudeAdapter`/`CodexAdapter` implementations
   in `packages/agents/src`.
2. Determine what machine-readable usage telemetry the *currently installed* versions expose
   (structured JSON/JSONL execution output, not human-readable console text).
3. Determine what, if anything, either CLI exposes about subscription-plan usage/remaining
   allowance versus API billing. `IMPLEMENTATION_ROADMAP.md`'s "Local CLI capability findings" and
   `usage-safety.ts`'s known limitations record what was true on 2026-09-13 — re-verify, don't
   assume it still holds.
4. If external documentation seems necessary, follow the existing browser-access permission flow
   and ask the human first. Do not browse automatically.
5. Determine whether any historical run records in the local database already contain recoverable
   token/cost/session metadata (raw CLI output, structured result JSON) before designing the schema,
   so the backfill step (Step 11) is grounded in what's actually there.

Only after this investigation, write up findings (what's exposed, what isn't, what's recoverable)
before writing implementation code, and confirm the plan below still fits reality — adjust it where
the installed CLIs behave differently than assumed here.

## Data model

Every agent run should produce a `UsageRecord`, linked back to the run/task/project it belongs to.
Adapt this shape to however `agent_runs`/`task_artifacts` actually look at execution time — do not
blindly copy field names if the schema has since evolved:

```ts
interface UsageRecord {
  id: string;
  runId: string;        // agent_runs.id
  taskId: string | null; // tasks.id, when the run belongs to a task
  projectId: string;

  provider: "CLAUDE" | "CODEX";
  modelRequested?: string;
  modelActual?: string;

  role: "architect" | "skeptic" | "builder" | "reviewer" | "synthesizer" | "investigator" | "other";
  workflowType: string; // e.g. "BRAINSTORM", "BUILD_REVIEW", future workflow kinds

  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;

  actualCostUsd?: number;         // only when the provider/CLI reports real billed cost
  apiEquivalentCostUsd?: number;  // calculated from the pricing registry, always labeled as such

  billingMode: "subscription" | "api" | "credits" | "unknown";
  usageSource: "provider_reported" | "cli_reported" | "app_server" | "calculated" | "estimated" | "unavailable";

  browserSearchCount?: number;
  toolCallCount?: number;
  durationMs?: number;

  rawUsageMetadata?: unknown; // raw provider/CLI usage JSON, verbatim — never hidden reasoning/chain-of-thought

  createdAt: string;
}
```

Only populate fields the provider/CLI actually reported. A missing field is `NULL`, never a guess —
in particular, never compute `reasoning tokens = output tokens − visible text tokens` or any other
unreliable derivation.

## Codex usage capture

Prefer the installed Codex CLI's structured JSON/JSONL execution output over parsing console text.
Capture whatever of `input_tokens` / `cached_input_tokens` / `output_tokens` /
`reasoning_output_tokens` the installed version actually emits. Do not assume reasoning-token
reporting exists — verify per Step 0.

Plan-usage percentages are separate from per-run token capture. `codex exec --json` does not emit
them, but Codex App Server documents `account/rateLimits/read`; use that local, authenticated,
machine-readable method for current plan windows and label persisted readings `APP_SERVER` /
`EXACT`. Do not scrape terminal UI or local session/authentication files and do not call an
undocumented remote endpoint.

## Claude usage capture

Capture whatever the installed Claude Code CLI's non-interactive/structured output reports (for
example: input/output tokens, cache creation/read tokens, cost, duration, turn count — only the
subset the installed version actually emits). Determine the auth/billing mode. If Claude is running
under a subscription, any provider-reported "cost" must never be presented as an actual charge —
label workspace-calculated figures as **API-equivalent cost**, never as "cost" or "you spent". If
Claude is running under API billing and the CLI reports real billed cost, store that separately as
`actualCostUsd`.

## Billing mode and plan usage

Show, where reliably determinable: `Claude: Subscription` / `Claude: API` / `Claude: Unknown`, and
the equivalent for Codex. Never guess.

For subscription plan usage/remaining allowance: if the installed CLI does not expose this through a
documented machine-readable interface, do not scrape interactive terminal UI (e.g. `/status`).
Instead, surface something like:

```text
Claude plan usage

Exact remaining plan allowance: Unavailable programmatically
Open Claude Code's own status view to check current allowance.
```

This mirrors `UsageSafetyService`'s existing stance (`UNAVAILABLE` is honest, never fabricated) —
reuse that service's status vocabulary and thresholds rather than inventing a second one. Usage
*token totals* for tasks must never be presented as if they determine remaining subscription quota
— these are two different systems and must stay visibly separate in the UI.

## Pricing registry and API-equivalent cost

Centralize provider/model pricing in one versioned registry (not scattered constants):
`{ provider, model, inputPricePerMillion, cachedInputPricePerMillion, outputPricePerMillion,
reasoningPricePerMillion?, effectiveFrom, source }`. A historical run's calculated cost must remain
reproducible using the price version active when it was calculated — never silently re-price old
runs when the registry changes. When a model has no known price, show
`API-equivalent cost: unavailable`, never a guess.

Cost = input cost + cached-input cost + output cost + any other separately-priced, documented
category. Expose the breakdown (tokens × rate = subtotal, per category) in the UI so the number is
auditable, and always label it **API-equivalent cost**, never bare "Cost", whenever the underlying
run used subscription allowance rather than real API billing.

## Surfaces to build

- **Workspace-level Usage dashboard** (new top-level nav item): period selector (Today / 7 days /
  30 days / this month / all time / custom), summary totals (runs, tokens, per-provider tokens,
  API-equivalent cost, browser-enabled run count, average tokens/task), provider breakdown, model
  breakdown (using actual captured model IDs, never hardcoded example names), usage-by-workflow
  breakdown, usage-by-agent-role breakdown, a highest-usage-tasks table, and a small set of charts
  (tokens over time, by provider, by workflow, API-equivalent cost over time, highest-usage tasks) —
  keep charts minimal; tables and drill-down are more important than chart count.
- **Task-level Usage tab/card**: per-provider/per-role runs + token breakdown, total processed
  tokens, API-equivalent cost, review-round count against the existing max-round cap (see below),
  browser search count.
- **Run-level usage detail**: provider, model, role, purpose, full token breakdown, duration,
  browser policy for that run, and the `usageSource` reliability label.
- **Cross-review cost breakdown** per task: independent analysis / cross-review / synthesis /
  implementation / code review / re-review, each with its own API-equivalent subtotal and a total —
  derived from each run's `role`/`workflowType`, not hardcoded per task.
- **Usage source indicator** everywhere a number is shown: `EXACT` (provider-reported) /
  `CALCULATED` (derived from exact data) / `ESTIMATED` (approximation) / `UNAVAILABLE`, each with a
  tooltip explaining the difference. This is the single most important UI rule in this phase — an
  estimated number must never look like an exact one.
- **Browser usage panel**: whether browser was used, search/document counts if the provider reports
  them, which agent/role requested it, and the recorded reason/permission decision (this already
  exists as web-access policy/audit data — extend it, don't duplicate it).
- **Settings → Usage & Cost**: track-usage toggle, show-API-equivalent-cost toggle, pricing registry
  editor, default warning threshold, default workflow budget preset, store-raw-telemetry toggle.

## Token efficiency metrics

Where enough data exists: tokens per task, tokens per completed task, tokens per review round,
tokens per accepted finding, tokens per implementation run, and cache hit ratio (`cached input ÷
total input including cached input`, documented explicitly in the UI). Do not invent a composite
"AI efficiency score" — keep every metric individually understandable and its formula visible.

## Task usage budgets

Optional, per-task, chosen before starting a workflow: `No budget / Economy / Balanced / Deep /
Custom`. Presets are configurable and should not assume a specific model if the workspace already
has model-selection configuration; they primarily control maximum review rounds, browser policy,
model tier, reasoning/effort, and usage warning threshold. Custom budgets support: maximum tokens,
API-equivalent cost warning, maximum agent runs, maximum review rounds.

A budget must never silently terminate an agent mid file-write or mid unsafe operation — when a
threshold is reached or approached, stop **before starting the next expensive run**, not
mid-operation, mirroring how `UsageSafetyService` already checkpoints rather than aborting. On
threshold: present the current status (e.g. unresolved review findings, next action that would run)
and require an explicit human choice — `Stop & Summarize` / `Continue One Run` / `Increase Budget` —
the same acknowledgement-and-persist pattern `usage_safety_audit` already uses; do not invent a
second acknowledgement mechanism.

## Review-round integration

Budget/usage monitoring must integrate with, not duplicate, the existing max-review-round
protection (Phase 5's hard cap). Note: **the round cap itself should already be a configurable
setting**, not hardcoded — see the `feedback_review_round_cap_configurable` memory recorded for this
workspace; if that hasn't been made configurable yet by the time this phase starts, do it as part of
this phase's settings work rather than leaving it hardcoded. Show round N/max alongside how much
API-equivalent usage the review rounds have consumed versus implementation, so the human can judge
whether another round is worthwhile.

## Historical backfill

Before adding new tracking, scan existing historical run records for recoverable provider-reported
usage (raw output, structured result JSON, session IDs, model metadata already persisted). Rules:
only backfill provider-reported data; never estimate historical token counts from character counts
without explicit human approval; mark every backfilled record with its actual source; never modify
original run logs; produce a backfill report (`runs scanned / with exact data / partially
recoverable / without data / backfilled / skipped`), with no fabricated historical usage.

## Database migration

Add tables/columns via a proper Drizzle migration (`npm run db:generate`, commit the generated
files) — never destroy existing task/run rows. Usage records link back to project/task/run/workflow
where applicable; existing historical runs with nothing recoverable simply show "Usage unavailable",
never a fabricated number.

## Testing requirements

Cover at minimum: Claude/Codex usage-payload parsing (including missing fields, unknown models,
partial records); cost calculation (each pricing category, unknown pricing, historical pricing
versions, subscription-vs-API labeling); aggregation (per-run/task/project, provider totals,
workflow totals, date-range filtering); budgets (warning threshold, continue-one-run,
budget-increase, interaction with the max-review-round cap); and backfill (exact / partial /
unavailable historical data, and that nothing is fabricated). Every test that touches Git/worktrees
must still use a temporary repository per this repo's existing test convention; every test must use
fake `AgentAdapter` implementations and must never spend real provider usage.

## Real-CLI verification (small, deliberate)

After automated tests pass, run one small real prompt through each provider (e.g. "Reply with
exactly: USAGE_TEST_OK"), browser access disabled, and confirm: a run was created, provider/model
were captured, token usage was captured where the CLI reports it, billing mode was identified where
reliably determinable, the usage-source label is correct, and the dashboard reflects the new run.
Do not run a large/expensive prompt just to exercise analytics.

## Documentation and reporting obligations for whoever implements this

Before calling the phase done: run the full verification command list in `AGENTS.md`/`CLAUDE.md`,
verify migrations and that existing data is intact, run the two small real-CLI tests above, verify
dashboard aggregation and historical backfill, then update `USER_GUIDE.md` (a full "Usage & Cost
Monitoring" section: what a token/cached-input/output/reasoning token is and why reasoning tokens
may be unavailable, subscription vs API usage, API-equivalent vs actual cost, usage credits, browser
usage, task budgets, review-round usage, the dashboard, historical backfill, why provider totals may
differ from estimates, why subscription limits can't be derived from token counts), update
`DEVELOPER_GUIDE.md` for the new architecture, and update `IMPLEMENTATION_STATUS.md`/
`IMPLEMENTATION_ROADMAP.md` marking Phase 8 with a completion record in the same style as every
other phase. Then report, in the same shape this repo's other phase completions use: what changed;
exactly where Claude usage data comes from and where Codex usage data comes from; which values are
exact/calculated/estimated/unavailable; how much historical usage was recoverable and the backfill
report; current workspace usage as now measurable; which tests passed/failed; and known
limitations — especially anything the subscription CLIs still don't expose. Do not start another
major feature automatically afterward.

## Non-negotiable wording rule

Never write "You spent $X" for a subscription-billed run. Always "API-equivalent cost" for
calculated figures, and reserve "cost"/"charge" for provider-reported actual billing. Never write
"Exact billing usage" for anything that isn't truly provider-reported exact billing data.

## Privacy

All usage telemetry stays local — no external analytics/telemetry service of any kind, ever.

## Out of scope for this phase

Anything not enumerated above (e.g. a second usage-safety mechanism, terminal-UI scraping of
`/status`, estimating historical tokens from characters without approval, an "AI efficiency score",
more than the five recommended charts) is explicitly out of scope; raise it as a separate decision
if it seems necessary once implementation is underway.
