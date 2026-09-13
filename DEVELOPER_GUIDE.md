# AI Engineering Workspace Developer Guide

This guide describes implementation internals. Product usage belongs in `USER_GUIDE.md`; planned work and completion evidence belong in `IMPLEMENTATION_ROADMAP.md` and `IMPLEMENTATION_STATUS.md`.

## Architecture

The application is a localhost-only npm workspace:

```text
Vue web client
    │ HTTP + SSE run events
    ▼
Fastify API
    ├── SQLite / Drizzle
    ├── repository inspection through Git CLI
    ├── persistent agent-run manager
    ├── brainstorm workflow orchestration and structured parsing
    └── AgentAdapter implementations + process supervisor
```

The frontend is an untrusted client. Filesystem, Git, process execution, permission enforcement, secret filtering, and audit persistence belong to the server or dedicated packages.

## Monorepo structure

```text
apps/
  web/       Vue 3 + Vite user interface
  server/    Fastify API, database, routes, local service integration
packages/
  agents/    provider-neutral contracts, CLI adapters, environment policy, process supervisor
  git/       WorktreeService, worktree naming/validation, Git subprocess helpers
  shared/    shared types with no platform dependencies
prompts/     versioned analysis and cross-review prompt files
data/        ignored local SQLite database
docs/
  decisions/ lightweight architecture decision records
scripts/     local development process launcher
```

`packages/git` now holds the Phase 4 `WorktreeService` and worktree-naming helpers. `packages/core` should still be introduced when workflow-engine responsibilities (state machines shared across task types) become concrete; the Phase 1 read-only repository inspector remains in the server since it is a small integration that has not needed to move.

## Runtime and commands

Node.js 22+ is required. Use `.nvmrc` when nvm is available.

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
npm run db:generate
npm run db:migrate
```

`npm run dev` starts the server on `127.0.0.1:4310` and Vite on `127.0.0.1:5173`. Vite proxies `/api` to Fastify. The launcher forwards `SIGINT` and `SIGTERM` to both child processes.

## Current HTTP API

### `GET /api/health`

Checks the local database and discovers Git, Claude Code, and Codex with bounded child processes. Codex authentication uses `codex login status`. The endpoint does not run an AI request.

### `GET /api/projects`

Returns registered projects, newest first.

### `POST /api/projects`

Validates and stores a project. The route accepts display name, absolute repository path, optional default branch, optional worktree root, project context, and validation commands.

The route canonicalizes the repository path before enforcing uniqueness. It reads Git metadata but does not write to the repository or execute configured commands.

### `POST /api/projects/:id/recheck`

Refreshes current branch and clean/dirty status. It intentionally does not fetch from a remote.

## Database schema

The SQLite schema contains registered `projects` plus Phase 2/3 workflow records:

- `id`: UUID string primary key;
- `name`;
- unique canonical `repository_path`;
- `default_branch` and `current_branch`;
- `worktree_root`;
- optional `project_context`;
- JSON `validation_commands`;
- `git_status` (`CLEAN` or `DIRTY`); and
- ISO timestamps.

`tasks` stores brainstorm/architecture inputs, state, risk, and the resolved human web-access decision. `agent_runs` and `agent_run_events` retain provider requests and normalized streams. `task_artifacts` stores the visible raw response plus parsed analysis/review JSON, `task_comparisons` stores the deterministic comparison, and `evidence_items` provides the persistent fact/assumption/question/decision/experiment board.

Drizzle schema is in `apps/server/src/db/schema.ts`; generated SQL and migration metadata are in `apps/server/drizzle/`. The runtime applies pending migrations when the server opens the database. WAL and foreign-key enforcement are enabled.

Future normalized tables should add ADRs, plans, worktrees, validation runs, review findings/responses, and broader audit events with the phase that owns their behavior; do not create speculative tables early.

## AgentAdapter

`packages/agents` defines the provider boundary:

```ts
interface AgentAdapter {
  readonly name: AgentProvider;
  healthCheck(): Promise<AgentHealth>;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

The input includes working directory, prompt, explicit permission profile, resolved web-access decision, optional session, output format, timeout, sanitized environment, requested model, and effort/reasoning setting.

Events distinguish start, stdout, stderr, structured output, completion, failure, and cancellation. Completion metadata records provider, requested model, actual model when detectable, effort, CLI version, prompt version, and whether web access was permitted.

Workflow logic must never select behavior with provider-name conditionals. Adapter factories may choose an implementation; everything above that layer uses the interface.

## CLI capability policy

Never invent flags. Each adapter begins with local `--version` and `--help` inspection for the installed executable.

The inspected Codex CLI 0.153.4 supports:

- non-interactive `codex exec`;
- JSONL events with `--json`;
- final-response schemas with `--output-schema`;
- explicit working directory with `-C`;
- model selection with `-m`;
- sandbox values `read-only`, `workspace-write`, and `danger-full-access`;
- approval policy control; and
- specialized review input through `codex review`.

Do not use `danger-full-access` or bypass flags as normal product features. The inspected Claude Code 2.1.269 supports restricted mode, explicit read-only tools, stream JSON, model selection, effort levels, and web tools when the task decision permits them.

## Model discovery and configuration

Implement capability probing behind adapters. A provider capability response should return:

- installed and authenticated state;
- CLI version;
- available model IDs when the CLI has an authoritative listing;
- available effort/reasoning settings;
- structured-output and session-resume support; and
- whether model discovery is dynamic or editable fallback.

Settings resolution order is role override, task override, project default, global default. Store the resolved request before launch. After completion, store the actual model only when provider output supplies it. `null` means unknown; it must not be filled by copying the requested value.

## Brainstorm workflow engine

The Phase 3 `BrainstormWorkflow` service currently lives in the server beside the run manager. It persists `DRAFT → ANALYZING → CROSS_REVIEW → READY`, with `FAILED` and `CANCELLED` terminal paths. Move the stable, multi-workflow state-machine contract into `packages/core` when Phase 4/5 introduces additional task types and transitions.

Transitions are explicit and integration-tested. Refreshing the browser reconstructs state from SQLite. Long-running work is represented by run records and events, not in-memory UI state. Cancellation is a terminal run result distinct from failure.

Independent brainstorm branches must be scheduled from the same user problem without exposing one provider's output to the other. Cross-review begins only after both original analyses are durably stored.

`brainstorm-analysis:v1` and `cross-review:v1` live under `prompts/`. The workflow validates their JSON shapes without discarding invalid or original output. The comparison is deterministic: reciprocal review agreements feed consensus; disagreements and factual/assumption concerns stay visible; unknowns, missing evidence, and experiments are deduplicated. It never selects a winner.

## Git and worktree layer

The current inspector uses `execFile` with an argument array and a timeout. It never interpolates a repository path into a shell command. Registration uses only read commands:

- `rev-parse --is-inside-work-tree`;
- `branch --show-current`;
- `symbolic-ref --short refs/remotes/origin/HEAD`; and
- `status --porcelain=v1`.

`packages/git`'s `WorktreeService` owns all worktree-mutating Git behavior for Phase 4. `proposeWorktree` derives a deterministic path (`<worktreeRoot>/TASK-<id>-<slug>/<role>`) and branch (`ai/TASK-<id>/<slug>/<role>`) from the task ID, a bounded slug of the task title, and the provider role; both remain independently editable up to creation. Every mutating method validates the canonical source repository path, the target root (rejecting traversal and paths outside the configured root or inside the source repository), the generated/edited branch name (`check-ref-format`), the base ref (`rev-parse --verify`), and collisions against both Git's own worktree list and (at the route layer) the `worktrees` table's unique `(taskId, provider)` and `(projectId, branchName)` indexes. All Git subprocess calls go through a single `execFile`-based helper with an argument array, a 10 MiB output cap, and a 30s timeout — never a shell.

`move`, `renameBranch`, and `remove` share an `assertSafeToMutate` guard that refuses a locked, prunable, dirty, or in-use worktree (`WORKTREE_LOCKED` / `WORKTREE_PRUNABLE` / `WORKTREE_DIRTY` / `WORKTREE_IN_USE`, mapped to HTTP 409). If Git no longer registers a worktree at all — an interrupted `CREATING` record, a failed creation, or a worktree removed outside the application — `remove` recognizes `WORKTREE_NOT_REGISTERED`, runs `git worktree prune`, and reports `{ forgotten: true }` instead of throwing, so the route can delete the orphaned DB record and free its task/provider and project/branch slots. This is the only case where a managed record is deleted without a live Git worktree behind it; a record with a real, non-clean worktree is never silently discarded. At the route layer, a DB write that fails after a Git move/rename already succeeded triggers an automatic rollback attempt; whether or not the rollback succeeds, the outcome is recorded on the worktree row (`lastError`, and `status: "ERROR"` if the rollback itself also failed) so the inconsistency is inspectable rather than only surfaced to the immediate caller.

`WorktreeUsageManager` (`apps/server/src/services/worktree-usage-manager.ts`) tracks which run/validation/system process currently owns a worktree (`worktreeUsages`, keyed by worktree + owner). `listActive` flags a lease `stale` once it has been open longer than a configurable threshold (default 6 hours), and `releaseById` gives a human an explicit recovery path (`DELETE /api/worktrees/:id/usages/:usageId`) for a lease a crashed process never released. Phase 5 build/review runs and Phase 6 experiments now call `acquire`/`release` in production, holding the lease across their worktree-scoped agent activity so `isInUse` can block unsafe mutation and cleanup.

Git push, force push, hard reset, branch deletion outside the explicit merged-branch-deletion flow, deployment, and production migration are outside the automated workflow. Project deregistration (`DELETE /api/projects/:id`) is refused with 409 `WORKTREES_LINKED` while any `worktrees` row still references the project — clean up each managed worktree first.

### Worktree HTTP API

- `GET /api/projects/:id/worktrees` — managed records (each with live inspection, `inUse`, and `activeUsages`) plus the raw `git worktree list`.
- `GET /api/tasks/:id/worktrees/preview` — a proposal per provider, validated but not created; `available: false` carries the specific collision reason.
- `GET /api/tasks/:id/worktrees` / `GET /api/worktrees/:id` — managed record detail.
- `POST /api/tasks/:id/worktrees` — validates, inserts a `CREATING` row, runs `git worktree add`, then updates to `ACTIVE` (or `ERROR` with `lastError` on failure).
- `GET /api/worktrees/:id/diff` — staged and unstaged unified diff.
- `PATCH /api/worktrees/:id/path` / `PATCH /api/worktrees/:id/branch` — independent move/rename, each refusing a dirty/locked/prunable/in-use worktree.
- `DELETE /api/worktrees/:id` — requires `{ confirm: true }`; `deleteBranch: true` additionally requires Git to confirm the branch is merged before either the worktree or the branch is touched.
- `DELETE /api/worktrees/:id/usages/:usageId` — explicit human release of an active (typically stale) usage lease.

Every route validates its body at the boundary and returns 400 for invalid input, 404 for a missing project/task/worktree, and 409 for a collision, dirty/locked/prunable state, an in-use worktree, or a database uniqueness conflict; unexpected failures return a generic 500 without leaking internals beyond what this local-only tool already assumes (the caller is the trusted local user).

## Provider usage safety

`apps/server/src/services/usage-safety.ts` (`UsageSafetyService`) is the single provider-neutral safety system covering both CLAUDE and CODEX; nothing downstream branches on provider name.

Data model (`apps/server/src/db/schema.ts`):

- `provider_usage_readings`: one row per point-in-time reading of a provider's usage against one window (`windowId`/`windowLabel`, e.g. a 5-hour or weekly allowance). History is retained; the latest row per `(provider, windowId)` (ties broken by SQLite `rowid`, since two readings can share a millisecond `createdAt`) is what is shown and evaluated. `source` is `CLI_REPORTED` (unused today — see below), `MANUAL`, or `RATE_LIMIT_ERROR`; `sourceConfidence` is `EXACT` or `ESTIMATED`.
- `usage_safety_settings`: one configurable policy row (`id = "default"`) — `warningThresholdPercent`, `checkpointThresholdPercent`, `staleAfterMs`, `acknowledgementTtlMs`.
- `usage_safety_audit`: append-only log of `CHECKPOINT_TRIGGERED` (recorded automatically whenever `assertReady` blocks a call) and `ACKNOWLEDGEMENT` (recorded only via an explicit human action) events, each with the provider, window, status, an optional `relatedReadingId`, and (for acknowledgements) the user action (`PROCEED`/`OVERRIDE`/`PAUSE`).
- `tasks.status` gained a `CHECKPOINTED` value. This needed no migration: Drizzle's `enum` option on a `text` column is a TypeScript-level annotation, not a database `CHECK` constraint.

Status derivation (`UsageSafetyService.getProviderUsage`): no reading at all is `UNAVAILABLE` (never a fabricated percentage); a reading older than `staleAfterMs` is `STALE`; a `RATE_LIMIT_ERROR` source or `usedPercent >= 100` is `EXHAUSTED`; then `CHECKPOINT_REQUIRED` / `WARNING` / `SAFE` by threshold. `evaluate(provider, { combined })` turns that into a decision: `EXHAUSTED` always blocks with no override; `CHECKPOINT_REQUIRED` blocks unless a matching `OVERRIDE` acknowledgement tied to that exact `readingId` was recorded within `acknowledgementTtlMs`; `UNAVAILABLE`/`STALE` blocks only when `combined: true` (a single, isolated provider action is allowed to proceed) unless a matching `PROCEED` acknowledgement is still within its TTL. `assertReady` calls `evaluate` and throws `UsageCheckpointError`, recording a `CHECKPOINT_TRIGGERED` audit row, when blocked.

There is no supported local CLI or API surface that reports exact Claude Code / Codex CLI usage percentages today (see the CLI capability findings above), and this project's safety rules forbid probing further for one. `refresh()` therefore always reports "no automatic source" rather than fabricating a value. The two real data sources are `submitManualSnapshot` (validated, always labeled `MANUAL`) and `recordRateLimitError`, which heuristically pattern-matches a provider process's stderr/failure text (`parseRateLimitMessage`) for wording specific to the *account/subscription usage allowance* ("usage limit reached", "5-hour limit", "usage cap", "quota/allowance exceeded") plus a nearby reset-time phrase. It explicitly excludes wording that indicates an API-level tokens/requests-per-minute throttle (`tokens per minute`, `requests per minute`, `TPM`/`RPM`, `rate_limit_error`, `429`) — conflating that with the subscription usage window is exactly the mistake this project must avoid. Even so, this remains a best-effort signal, not a verified parser, since validating it against a real exhausted response would require spending real usage.

Preflight call sites:

- `POST /api/agent-runs` (single-provider, `combined: false`) — blocks on `EXHAUSTED`/unresolved `CHECKPOINT_REQUIRED`; allows `UNAVAILABLE`/`STALE` through for an isolated read-only run.
- `BrainstormWorkflow` (`combined: true`) checks at two levels: `assertPhaseReady` once for both providers before either the analysis or the cross-review `Promise.all` starts (so a ready provider's process is never started only to have its sibling call refused a moment later — Promise.all does not cancel sibling promises), and again inside the shared `run()` helper immediately before every one of the four individual provider calls. On block, the workflow checkpoints (`status: "CHECKPOINTED"`, `errorMessage` holds the reason) instead of failing; whatever analyses/reviews already persisted are untouched. `BrainstormWorkflow.resume` reconstructs already-completed analyses from `task_artifacts` and continues from wherever the workflow left off — it never re-runs a stage that already finished.
- `AgentRunManager` accepts an optional `UsageSafetyService` and calls `recordRateLimitError` on every `stderr` chunk and `failed` event, independent of the preflight checks above.

Routes (`apps/server/src/routes/usage-safety.ts`): `GET /api/usage`, `GET /api/usage/:provider`, `POST /api/usage/:provider/refresh`, `POST /api/usage/manual-snapshot`, `GET`/`PATCH /api/usage/policy`, `POST /api/usage/acknowledge`, `GET /api/usage/audit`. `POST /api/tasks/:id/resume` resumes a `CHECKPOINTED` task after rechecking both providers.

Never: automatically redeem provider reset credits, automatically start a replacement provider, automatically downgrade a requested model, or silently treat unknown/stale usage as safe in a combined workflow.

## Security model

Three permission profiles define intent:

- `READ_ONLY`: repository inspection, brainstorming, architecture, investigation, and review;
- `WORKTREE_WRITE`: changes only inside an assigned task worktree; and
- `TEST_ONLY`: configured validation under a controlled working directory.

The process supervisor must enforce—not merely label—these profiles. Build it before live adapters.

Environment sanitization should start from a minimal allowlist needed for executable discovery, locale, temporary files, and legitimate CLI authentication. Explicitly deny common cloud/database credentials and never log environment values. Authentication files remain owned by each CLI and are never copied into SQLite.

Sensitive path rules should reject automatic reads of `.env`, `.env.*`, private keys, cloud credential directories, macOS Keychain data, and configured user additions. A future run requesting those paths must pause for explicit human action rather than weakening the profile.

## Web permission model

Brainstorm drafts currently resolve the decision before creation as `DISABLED` or `ENABLED_FOR_TASK`, record the human decision and time, and copy it to every run. The broader `ASK_BEFORE_USE` state remains a future interactive permission flow; unresolved decisions are never passed to adapters.

Adapters translate the resolved decision into supported provider flags. If a CLI cannot guarantee the requested restriction, report the capability mismatch and block the run. Never infer permission from general network availability.

## Process execution and streaming

The Phase 2 implementation uses `spawn` without a shell. The process supervisor:

1. validates the absolute working directory and currently rejects every profile except `READ_ONLY`;
2. constructs an allowlisted environment and rejects credential-like overrides;
3. starts the provider process without a shell and in its own process group where supported;
4. streams bounded stdout/stderr chunks;
5. terminates the process group on timeout or cancellation; and
6. emits one normalized terminal result.

`AgentRunManager` writes each normalized event to SQLite before broadcasting it. It separately stores visible output, structured raw events, and stderr; each channel is capped at 5 MiB. The Phase 2 routes expose run creation, detail/history, cancellation, provider health, and SSE event replay. Refresh recovery can reconstruct completed and in-progress records from SQLite, although startup reconciliation for a process interrupted by a server restart remains Phase 7 work.

SSE is the initial transport because run output is primarily server-to-client; cancellation and user decisions remain normal HTTP commands. Revisit WebSocket only if later bidirectional streaming requirements justify it.

Do not rely on terminal-screen scraping when structured or line-oriented CLI output is supported.

## Adding another LLM provider

1. Inspect the installed CLI's help and version locally.
2. Document supported authentication, model, structured-output, permission, web, resume, and cancellation behavior.
3. Implement `AgentAdapter` in `packages/agents`.
4. Map provider output to common events without discarding raw stdout/stderr.
5. Add capability and failure tests using a fake executable.
6. Register the adapter in the server composition root.
7. Add editable model configuration when discovery is unavailable.
8. Update user documentation.

No workflow module should change merely to add a provider.

## Adding workflow types

1. Define the task type and allowed state transitions in `packages/core`.
2. Add versioned prompt files under `prompts/`.
3. Define structured outputs and validation/parsing.
4. Add required persistence and audit events.
5. Implement orchestration against `AgentAdapter` roles.
6. Add failure, cancellation, refresh/recovery, and maximum-round tests.
7. Add UI only after server behavior has deterministic tests.
8. Update the user guide with the human decision points.

## Testing strategy

Unit tests should cover state transitions, output parsers, command/path generation, permission mapping, environment sanitization, and model-setting resolution.

Integration tests should use temporary Git repositories and fake agent executables. They should prove worktree isolation, diff collection, cleanup refusal for dirty work, exact validation-result capture, cancellation, timeout behavior, and startup recovery.

Real Claude/Codex calls are manual acceptance tests. Automated tests must not require authentication, network access, or model credits.

The Phase 3 integration test uses paired fake Claude/Codex adapters and synchronization barriers to prove independent analyses and reciprocal reviews start in parallel, then verifies prompt versions, raw/structured artifacts, comparison, evidence, and the explicit web decision. Automated tests never spend provider credits.

`apps/server/src/routes/end-to-end-workflow.test.ts` is different in kind from the rest: every other test above exercises one route or service in isolation, with fixtures seeded directly. This one drives the entire currently-implemented pipeline through the app's own HTTP API in one continuous run, in the order a real user follows it — register → health → draft → the usage-safety acknowledgement gate → independent analysis → cross-review → comparison/evidence → worktree creation → isolation → the deregistration-vs-linked-worktrees guard → cleanup — using a temporary repository and fake adapters. Extend this same test as later phases land rather than writing a second, separate end-to-end test; keep the per-phase integration tests above as the place for exhaustive edge cases.

## Agent policy synchronization

`AGENTS.md` is the canonical policy for any LLM coding agent working in this repository; `CLAUDE.md`
is a relative symbolic link to it (`CLAUDE.md -> AGENTS.md`), so both paths always return identical
bytes and there is exactly one copy to edit. `npm run check:agent-policy`
(`scripts/check-agent-policy.mjs`) verifies this on every `npm test` run (wired via the `pretest`
script): `AGENTS.md` is a regular file, `CLAUDE.md` is a symlink whose target is exactly
`"AGENTS.md"`, both resolve to the same canonical file, their bytes are identical, and the policy
text contains no secret-shaped strings or a literal, soon-stale usage percentage. If this check ever
fails, do not "fix" it by duplicating content into two files — restore the symlink
(`ln -sf AGENTS.md CLAUDE.md`) and edit `AGENTS.md` only.

The check's core logic is exported as `checkAgentPolicy(root)` (pure, no `process.exit`) so
`scripts/check-agent-policy.test.mjs` can exercise every failure mode — missing file, a duplicated
regular file instead of a symlink, a wrong symlink target, a secret-shaped string, a stale usage
percentage — against disposable fixture directories under the OS temp dir, never against this
repository's real `AGENTS.md`/`CLAUDE.md`. Run it directly with `node --test
scripts/check-agent-policy.test.mjs`, or via `npm run test:scripts`; both run automatically as part
of `pretest` before every `npm test`.

## Change protocol

For every phase:

- keep the change within the declared phase boundary;
- generate and inspect database migrations;
- run tests, type checks, a production build, and `npm run check:agent-policy`;
- exercise the user-visible flow locally;
- update `IMPLEMENTATION_STATUS.md`;
- update `USER_GUIDE.md` for behavior changes; and
- add or revise ADRs only for consequential decisions.
