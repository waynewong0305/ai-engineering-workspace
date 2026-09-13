# Implementation Status

Last updated: 2026-09-13

## Current release boundary

The application currently supports local startup, tool readiness checks, SQLite-backed project registration, read-only Git inspection, saved validation-command configuration, deliberate read-only Claude Code/Codex repository-explanation runs, persisted brainstorm/architecture workflows with independent analysis, reciprocal review, comparison, web-decision audit, cancellation, and an evidence board, isolated Git worktree creation/inspection/rename/cleanup for Claude and Codex task work, a cross-cutting Claude/Codex usage-safety system, and **Phase 5 (build, validate, and review) is now fully implemented**: a worktree-scoped `WORKTREE_WRITE` builder run, honest validation-command execution, diff capture, a `READ_ONLY` reviewer run producing structured findings, a human-triggered finding-response/re-review round capped by a per-build maximum round count, a human-approved merge (commits the builder's outstanding worktree changes, merges into a target branch through a throwaway detached worktree that never touches the developer's own checkout, runs post-merge validation, and only then auto-cleans up the task worktree/branch when every §12 safety condition holds), and a generated pre-PR report summarizing the task, implementation, findings, tests, and merge state for the human's own final review. **Phase 6 (planning and ADRs) is now fully implemented**: architecture decision records (create, list, edit, reclassify status), isolated proof-of-concept experiments (hypothesis-driven builder/reviewer run whose verdict becomes an evidence-board item), and promoting an ADR into one or more linked `IMPLEMENTATION` tasks (each keeping a real link back to its ADR, and transitively to the originating architecture discussion and any related experiments). Phase 7 hardening is in progress — see below.

Documentation consistency maintenance (2026-09-13): reconciled `AGENTS.md`, this status record,
`IMPLEMENTATION_ROADMAP.md`, `PROJECT_SPEC.md`, `DEVELOPER_GUIDE.md`, and
`USAGE_MONITORING_SPEC.md` with the completed Phase 5/6 implementation. The roadmap now marks the
delivered checklist items complete, Phase 8 is accurately queued behind Phase 7, production
worktree-lease usage is documented, and the remaining cross-phase end-to-end-test gap is stated as
a Phase 7 hardening task rather than an absent Phase 5 implementation. No product behavior or
schema changed. Verified with `npm test` (114 workspace tests plus 9 policy-script tests), `npm run
typecheck`, `npm run build`, `npm run check:agent-policy`, `npm run db:generate` (no schema changes),
and `git diff --check`; all passed under Node 22.23.2.

## LLM agent policy

`AGENTS.md` (canonical) and `CLAUDE.md` (a relative symlink to it) carry the standing policy for any LLM coding agent working in this repository — product purpose, entry points, runtime/verification commands, worktree and usage-safety rules, and a continuation checklist. `npm run check:agent-policy` verifies the pair stays a single canonical file plus a symlink (never two independently editable copies) and runs automatically before `npm test`. The checker's own logic (`checkAgentPolicy` in `scripts/check-agent-policy.mjs`) has automated coverage in `scripts/check-agent-policy.test.mjs` (9 cases, run via `node --test` and wired into `pretest`) against disposable fixtures, so this was verified by an automated test rather than only manually. See `DEVELOPER_GUIDE.md`'s "Agent policy synchronization" section for how the check works.

## Phase 0 — Bootstrap

- [x] npm workspace monorepo
- [x] Vue 3 frontend
- [x] TypeScript and Vite
- [x] Fastify backend
- [x] SQLite persistence
- [x] Drizzle ORM and initial migration
- [x] Basic navigation
- [x] Health endpoint
- [x] Development startup command
- [x] Site-specific favicon and responsive application shell

Completion record:

- Date: 2026-09-13
- Decisions: Node 22+ runtime contract; localhost-only client/API; SQLite stored under ignored `data/`; Fastify owns all OS-facing work.
- Modules introduced: `apps/web`, `apps/server`, `packages/shared`, development launcher, migration.
- Tests executed: TypeScript checks; server integration tests; Vite production build; local client/API startup and HTTP readiness.
- Known limitation: the shell currently selects Node 16.20.2. Validation used bundled Node 24.19.0 without modifying the user's installed runtime.

## Phase 1 — Project registration

- [x] Add project
- [x] List registered projects
- [x] Edit registered project settings and repository path with read-only reinspection
- [x] Confirm and deregister a project without deleting its repository
- [x] Refuse deregistration while agent runs are active
- [x] Validate absolute path
- [x] Verify Git repository
- [x] Resolve canonical path
- [x] Detect current branch
- [x] Detect default branch where practical
- [x] Read Git clean/dirty status
- [x] Configure worktree root without creating it
- [x] Configure test, lint, and build commands without executing them
- [x] Save optional project context
- [x] Recheck Git status
- [x] Integration test with a temporary repository

Completion record:

- Date: 2026-09-13
- Decisions: registration is strictly read-only; Git is invoked with argument arrays; duplicate canonical paths are rejected.
- Modules introduced: project schema, repository inspector, project routes, registration UI.
- Tests executed: clean temporary repository registration, non-repository rejection, project update, safe deregistration, and post-operation Git status checks.
- Known limitations: deregistration intentionally removes the project's local tasks, run history, and evidence after confirmation; remote default-branch discovery is local-only and falls back to the checked-out branch. At the Phase 1 boundary validation commands were stored but not run; Phase 5 now executes selected commands inside an assigned task worktree.

## Phase 2 — Agent adapters

- [x] `AgentAdapter` interface
- [x] Provider-neutral run input
- [x] Typed run event stream
- [x] Permission profile types
- [x] Web-access policy and recorded-decision types
- [x] Requested/actual model audit metadata
- [x] Environment allowlist and credential-variable rejection
- [x] Shared read-only process supervisor
- [x] Claude adapter
- [x] Codex adapter
- [x] SSE streaming transport
- [x] Cancellation and timeouts
- [x] Run and event persistence
- [x] Editable model fallback when discovery is unavailable
- [x] Explicit read-only repository-explanation screen

Current record:

- Date: 2026-09-13
- Decisions: provider-specific CLI behavior remains inside adapters; unavailable actual model values are represented as `null`; Phase 2 launches only `READ_ONLY` runs with web access disabled; model IDs remain editable because neither CLI exposes authoritative model discovery.
- Modules introduced: process supervisor, environment sanitizer, Claude/Codex adapters, run manager, run/event schema and migration, agent API routes, SSE stream, and run UI.
- Tests executed: environment filtering; process output and timeout behavior; fake-adapter run persistence; project/run API tests; full TypeScript check; production build; migrated local API/UI health and visual inspection. Automated tests do not call a live model.
- Known limitations: Claude Code and Codex are authenticated, but a real paid/provider run remains an explicit user action from the UI and was not triggered during implementation. Codex network reachability was unavailable in the restricted diagnostic environment. Run history is persisted but the UI currently shows only the active run; output storage is capped at 5 MiB per channel.

## Phase 3 — Brainstorming

- [x] Brainstorm and architecture task creation
- [x] Parallel independent Claude/Codex analysis
- [x] Versioned prompts and structured-result validation
- [x] Raw-output retention
- [x] Reciprocal cross-review
- [x] Consensus/disagreement/question/evidence/experiment comparison
- [x] Persistent editable assumption/evidence board
- [x] Explicit per-task web decision and run audit
- [x] On-demand brainstorm plan report (`GET /api/tasks/:id/report`)
- [x] Per-task open-question count surfaced in the task list

Current record:

- Date: 2026-09-13
- Decisions: task drafts are free and separate from the paid start action; analysis providers receive identical task context independently; cross-review begins only after both analyses persist; the comparison is deterministic and never selects a winner; task web access is resolved explicitly before creation.
- Modules introduced: task/artifact/comparison/evidence schema and migration, `BrainstormWorkflow`, task APIs, versioned prompt files, and the Phase 3 task/comparison UI.
- Tests executed: paired fake-provider parallelism barriers; full analysis → review → comparison workflow; structured/raw persistence; evidence creation/update; explicit web-decision validation; full TypeScript check; production build; migrated local API/UI inspection.
- Acceptance state: the database-sharding task exists as a `DRAFT` for the registered Boostorder project with web disabled. Its real four provider runs were not started automatically because they spend provider usage.
- Known limitations: active provider processes are not reconciled after a server restart; deterministic comparison depends on structured cross-review quality.
- Correction (2026-09-13): this record previously said "the screen edits evidence content while type reclassification is currently API-only." That was inaccurate even at the time — `PATCH /api/tasks/:taskId/evidence/:itemId` and the evidence board's own Edit → type select → Save flow (`editingEvidenceType` in `App.vue`) both shipped in the same commit as this record and already support changing an item's type (e.g. `QUESTION` → `DECISION`). No code changed to fix this; only the stale claim did, caught while scoping Phase 6.

Later addition (2026-09-13): a brainstorm plan export, modeled on the build workflow's existing pre-PR report (`apps/server/src/services/pre-pr-report.ts`). `buildBrainstormPlanReport` (`apps/server/src/services/brainstorm-report.ts`) reads a task's analyses, cross-reviews, comparison, and evidence and assembles them into a report; unlike the build report it never blocks on task status — a task that's still running, checkpointed, failed, or cancelled still exports whatever completed, with a status-appropriate recommended next action, since a brainstorm task has no single fixed reviewer to gate on. Exposed as `GET /api/tasks/:id/report` and a **BRAINSTORM PLAN REPORT** section with a **Generate report** button on the task detail pane, next to the evidence board. Verified with a route-level test that runs the fake-adapter workflow to `READY` and checks the full report shape, a 404 test for an unknown task, `npm test`/`typecheck`/`build`/`check:agent-policy`/`db:generate` (no schema change), and manual browser verification of the button and its output on a `DRAFT` task.

Later addition (2026-09-13): with several tasks running at once there was no way to tell which needed human attention without opening each one individually, so `GET /api/tasks` and `GET /api/tasks/:id` now both return `openQuestionCount` (a count of the task's `evidence_items` rows of type `QUESTION`, computed in application code rather than a SQL aggregate, matching this route file's existing style) and the task-list sidebar item in `App.vue` shows an amber "N open question(s)" badge whenever that count is nonzero. A question stops counting the moment a human reclassifies it away from `QUESTION` (typically to `DECISION`) through the evidence board's existing edit flow — no new state was added. No schema change. Verified with two new assertions in `tasks.test.ts` (the list endpoint and the detail endpoint both report the count derived from the fake-adapter workflow's real evidence), the full verification list, and manual browser verification (added a `QUESTION` record through the UI, confirmed the badge appeared, then removed that test record from the local database directly since there is no delete-evidence endpoint yet).

## Phase 4 — Git worktrees

- [x] Worktree service (`packages/git`)
- [x] Meaningfully named task-specific branches and worktree paths (`TASK-<id>-<slug>/<role>`, `ai/TASK-<id>/<slug>/<role>`)
- [x] Editable generated names and collision validation (path, branch, base ref, Git-worktree, and DB task/provider + project/branch collisions)
- [x] Safe worktree rename with branch/path independence (`PATCH /path`, `PATCH /branch`)
- [x] Claude/Codex isolation (separate paths/branches per provider; creation never touches the source checkout)
- [x] Status and diff (`GET /api/worktrees/:id`, `GET /api/worktrees/:id/diff`)
- [x] Dirty/locked/prunable/in-use protection before move, rename, and remove
- [x] Recoverable cleanup workflow: a creation failure or interrupted `CREATING` record no longer permanently blocks its task/provider or project/branch slot — removal recognizes an unregistered worktree and forgets the stale record instead of throwing
- [x] Worktree ownership/usage-lease tracking with stale-lease detection (6h default) and explicit human release (`DELETE /api/worktrees/:id/usages/:usageId`)
- [x] Temporary-repository integration tests (service and route level)
- [x] Refuse project deregistration while managed worktrees remain linked (`DELETE /api/projects/:id` returns 409 `WORKTREES_LINKED` while any `worktrees` row still references the project)
- [x] Guarded automatic cleanup after approved merge and passing post-merge validation (delivered in Phase 5)
- [x] Keep-after-merge override and separate opt-in merged-branch deletion policy (delivered in Phase 5)

### Phase 4 completion record

- Date: 2026-09-13
- Audit findings against `PROJECT_SPEC.md` section 12 and the roadmap Phase 4 exit gate:
  1. **Orphaned/interrupted worktree records could permanently block their task/provider and project/branch slots.** `WorktreeService.remove` previously required Git to still list the worktree; a failed `git worktree add`, a crash between inserting a `CREATING` row and finishing creation, or a worktree removed outside the application left an `ERROR`/`CREATING` row that could never be deleted (the unique `(taskId, provider)` and `(projectId, branchName)` indexes then blocked any retry). Fixed: `remove()` now recognizes `WORKTREE_NOT_REGISTERED`, runs `git worktree prune`, and reports `{ forgotten: true }` so the DB record can be deleted and the slot reused (a fresh branch name is still required if the abandoned branch itself was created — recovery never silently reuses stale branch history).
  2. **Locked and prunable worktrees were not explicitly rejected.** `move`, `renameBranch`, and `remove` checked only dirty/in-use state. Fixed with a shared `assertSafeToMutate` guard that also rejects `locked` and `prunable` worktrees with dedicated error codes (`WORKTREE_LOCKED`, `WORKTREE_PRUNABLE`), mapped to HTTP 409.
  3. **A DB-persistence failure after a successful Git move/rename attempted a bare rollback and re-threw the original error, silently discarding a rollback failure and never recording anything on the record itself.** Fixed: failures are now recorded on the worktree row's `lastError` (and `status: "ERROR"` when rollback itself also fails), so an inconsistent record is inspectable and recoverable instead of silently returning to the caller only.
  4. **No test proved an unmerged branch cannot be deleted**, though the code already refused it. Added a unit test that creates a real unmerged commit and asserts both `ensureBranchMerged` and `deleteMergedBranch` refuse it with `BRANCH_NOT_MERGED`, and that the branch still exists afterward.
  5. **Usage leases had no staleness concept.** A lease acquired by a crashed process could never be told apart from a legitimately active one. Added `stale` computation (configurable threshold, default 6h) to `listActive`/`activeUsages`, plus an explicit `releaseById` human-recovery path exposed as `DELETE /api/worktrees/:id/usages/:usageId`.
  6. **Mobile layout regression (pre-existing, not introduced by this phase's checkpoint but caught during Phase 4 UI verification):** below the 820px breakpoint, `.app-shell`'s single grid column had no `min-width: 0`, so the sidebar nav's intrinsic content width (~587px) forced the whole page to overflow horizontally instead of the nav's own `overflow-x: auto` strip scrolling internally. Fixed with `grid-template-columns: minmax(0, 1fr)` and `.sidebar { min-width: 0 }` in the same media query. Verified no page-level horizontal overflow remains at 390px and ~587px viewport widths; desktop layout unaffected.
  7. **`lastError` and active usage leases were tracked but never surfaced in the UI.** The worktree inspector now shows the last recorded error and a list of active usage leases (with a stale label and a Release control) alongside the existing clean/dirty, idle/in-use, and inspection-error states.
  8. **Project deregistration did not check for linked managed worktrees**, contradicting `PROJECT_SPEC.md` section 12 ("Once managed worktrees are enabled, deregistration must also require their safe cleanup first"). Fixed: `DELETE /api/projects/:id` now returns 409 `WORKTREES_LINKED` while any `worktrees` row still references the project, and succeeds again once every managed worktree for that project has been removed. Covered by a new integration test (register a project, create a worktree, confirm deregistration is refused, remove the worktree, confirm deregistration then succeeds).
- Later resolution: Phase 5 build/review runs and Phase 6 experiments now call `WorktreeUsageManager.acquire`/`release` in production, so active worktree-scoped agent activity is represented by a real lease and blocks unsafe mutation or cleanup.
- Tests executed: `packages/git` unit tests (6, including new locked-worktree and orphan-recovery cases), `apps/server` route/service tests (14, including a new orphan-recovery route test), full workspace `npm test` (25 tests across `apps/server`, `packages/agents`, `packages/git`), `npm run typecheck` (clean across all five workspaces), `npm run build` (server `tsc` + web `vue-tsc -b && vite build`, clean), `npm run db:generate` (confirms no schema drift — Phase 4 introduced no new columns), `npm run db:migrate` against the existing local database (no-op, already at migration `0003`), and `git diff --check` (clean). Browser verification at desktop width and at an emulated ~390–587px mobile width confirmed the worktree task selector, proposal cards, availability/collision messaging, and (after the fix above) no page-level horizontal scrolling. Real worktree creation against the registered Boostorder repository was deliberately not exercised in the browser to avoid consuming a real task/provider slot or touching that repository; behavior was instead proven with temporary Git repositories in the automated test suite.

## Provider usage safety (cross-cutting)

Not part of the original phase sequence in `PROJECT_SPEC.md`; added as an explicit cross-cutting safety requirement that must protect every phase's provider-consuming actions, present and future.

- [x] Provider-neutral usage data model: multiple windows per provider, used/remaining percentage, reset time and human-readable time-to-reset, source (`CLI_REPORTED`/`MANUAL`/`RATE_LIMIT_ERROR`), source confidence (`EXACT`/`ESTIMATED`), last-refresh time, freshness, and a `SAFE`/`WARNING`/`CHECKPOINT_REQUIRED`/`EXHAUSTED`/`UNAVAILABLE`/`STALE` status derived from configurable warning/checkpoint/staleness thresholds
- [x] Validated manual usage snapshots, clearly labeled `MANUAL`/`ESTIMATED` and never confused with an automatic reading
- [x] Heuristic parsing of a plausible provider rate-limit refusal into an `EXHAUSTED` reading (best-effort; see limitations)
- [x] Preflight check before every provider-consuming operation: single-provider actions (the read-only repository explanation) check that one provider; the combined brainstorm workflow checks both, and rechecks immediately before every one of its four provider calls (both analyses, both cross-reviews), not only once at workflow start
- [x] Checkpoint behavior: at the checkpoint threshold the workflow pauses (a new `CHECKPOINTED` task status) instead of failing, persists everything already completed, records which provider/window/reading triggered it, and requires either a fresh safe reading or an explicit human override tied to that exact reading before resuming
- [x] Exhaustion behavior: blocks new calls for that provider outright; a reliably exhausted status cannot be overridden, only cleared by reset or a fresh reading
- [x] Unknown/stale usage is never treated as safe; combined/multi-stage workflows default to requiring explicit acknowledgement, persisted with provider, reading, user action, and timestamp
- [x] Usage API: read/refresh/manual-snapshot per provider, read/update policy, record acknowledgement, read checkpoint/override audit history
- [x] Usage UI: Claude/Codex cards with textual state labels (not color-only), progress bar with ARIA attributes, refresh and manual-snapshot controls, policy editor, a pre-action warning on the brainstorm start button, and a checkpoint/resume block on a paused task
- [x] Unit, integration, and route-level tests for safe/warning/checkpoint/exhausted/unavailable/stale states, multiple windows, reset-time transitions, manual snapshot validation, freshness expiration, combined-provider preflight, recheck before cross-review, explicit acknowledgement, exhausted refusing override, rate-limit error parsing, no subprocess starting when blocked, and completed output surviving a checkpoint pause

Completion record:

- Date: 2026-09-13
- Data sources found supported: none automatically. Neither the inspected Claude Code 2.1.269 CLI nor the inspected Codex CLI 0.153.4 exposes a documented local command that reports exact usage/quota percentages (see `IMPLEMENTATION_ROADMAP.md`'s CLI capability findings), and this task's safety constraints prohibit invoking either CLI further to search for one. `refresh()` therefore always reports `unavailable` honestly rather than fabricating a value. The two real data sources implemented are an explicit human-entered manual snapshot, and a heuristic parse of a provider process's rate-limit refusal text.
- Known limitation, hardened same day: the rate-limit-error parser matches on plausible provider wording for the *account/subscription usage allowance* (e.g. "usage limit reached", "5-hour limit", "usage cap", "quota exceeded") and a nearby reset-time phrase. An initial version also matched a bare "rate limit reached", which risked exactly the mistake this project must avoid — confusing an API-level tokens/requests-per-minute throttle with the Claude Code/ChatGPT subscription usage window. Fixed: removed that pattern and added an explicit exclusion (`tokens per minute`, `requests per minute`, `TPM`/`RPM`, `rate_limit_error`, `429`) that blocks a match outright when present, plus added `usage cap` and `quota/allowance exceeded` wording and a broader `until <time>` reset-time pattern. It still has not been validated against a real exhausted response (doing so would consume real usage, which this task must not do) and should be revisited once real refusal text is observed.
- Added same day: since automatic parsing only catches wording it recognizes, an unrecognized rate-limit refusal previously left a failed run/task indistinguishable from any other failure, with nothing to stop the next attempt from failing the same way. A **Mark as exhausted** UI action (next to a failed single agent run, and next to a failed brainstorm task per failed provider, with the surrounding text naming which provider it applies to — the button label is deliberately generic since two can appear stacked together) now closes that gap explicitly: it submits the same manual snapshot (`usedPercent: 100`, labeled `MANUAL`) a human would otherwise have to type into the Usage Safety section by hand. It only appears when that provider isn't already recorded as exhausted, and never fires automatically.
- Added same day: the "Mark as exhausted" prompt now also carries a soft, advisory hint — a broader, looser client-side heuristic (`looksUsageRelated` in `App.vue`) scans the failed run's error text for wording like "usage," "quota," "capacity," "5-hour," or "insufficient credits" (still excluding API-throttle wording) and, when it matches, shows a "LOOKS LIKE A USAGE LIMIT" badge with more specific copy instead of the generic prompt. This is purely a UI nudge: nothing is recorded or persisted from it, the button underneath does exactly the same thing either way, and a human still has to click it. Deliberately kept separate from (and looser than) the server's strict, auto-recording `EXHAUSTION_PATTERNS`, since a false positive here only costs a glance, not a wrongly blocked provider.
- Known limitation: `acknowledgementTtlMs` (default 15 minutes) and the per-window `staleAfterMs` (default 30 minutes) are configurable but not currently surfaced as separate editable fields in the UI beyond the warning/checkpoint percentages; they can be changed via `PATCH /api/usage/policy`.
- Known limitation: there is no automated Vue component test for the usage UI (this project has no established frontend unit-test harness); the UI was verified manually in the browser at desktop and mobile widths instead. See the phase completion record above for exact widths checked.
- Tests executed: `apps/server` unit/integration/route tests (usage-safety service: 14; brainstorm-workflow usage-safety integration: 2; usage-safety routes: 5; plus the existing suites updated to acknowledge unknown usage before starting a combined workflow), full workspace `npm test`, `npm run typecheck`, `npm run build`, `npm run db:generate` (new `provider_usage_readings`, `usage_safety_settings`, `usage_safety_audit` tables plus the `tasks.status` `CHECKPOINTED` value — the latter needed no migration since Drizzle's `enum` option on a `text` column is a TypeScript-level annotation only, not a database `CHECK` constraint), `npm run db:migrate`, and browser verification of the new Usage Safety section and the brainstorm checkpoint/resume UI at desktop and mobile widths.

## Phase 5 — Build and review

- [x] Builder/reviewer selection
- [x] Validation execution
- [x] Diff viewer
- [x] Structured findings
- [x] Finding response
- [x] Re-review
- [x] Maximum review rounds (configurable per build, default 3 — see slice 2 record; not yet a global setting)
- [x] Human-approved merge into the target branch
- [x] Post-merge validation before cleanup
- [x] Guarded automatic worktree removal / `Keep worktree after merge` / merged-branch deletion policy
- [x] Pre-PR report

### Phase 5, slice 1 completion record

- Date: 2026-09-13
- Scope: exactly the Phase 5 acceptance bar from `PROJECT_SPEC.md` §21 — a builder edits a real
  repository inside its own worktree, validation runs and is recorded honestly, the diff is
  captured once, and an independent reviewer (never given write access) returns structured
  findings. Deliberately out of scope for this slice, tracked as unchecked above: the
  finding-response/re-review loop (§23, max rounds), human-approved merge + guarded auto-cleanup
  (§12), `Keep worktree after merge`, merged-branch deletion policy, and the pre-PR report (§25).
- Schema: new `build_runs` (its own status column, separate from `tasks.status`, so
  `BrainstormWorkflow` and the new `BuildReviewWorkflow` can never collide on the same
  `CHECKPOINTED`/`FAILED` value — see `apps/server/src/db/schema.ts`), `validation_runs` (§24's
  exact fields), and `review_findings` (§22's exact fields; `id`/`status` are always
  server-assigned, a model's own values for either are discarded). Widened `agent_runs.role`
  (`BUILD`/`REVIEW`) and `agent_runs.permissionProfile` (`WORKTREE_WRITE`) and `task_artifacts.kind`
  (`REVIEW_FINDINGS`).
- `packages/agents`: `ProcessSupervisor` now accepts `WORKTREE_WRITE`/`TEST_ONLY` but asserts
  `<cwd>/.git` is a file (a worktree), never a directory (a primary checkout), before spawning —
  independent of and in addition to each CLI's own write-scoping flags. `ClaudeAdapter`/
  `CodexAdapter` branch their CLI-argument construction internally for `WORKTREE_WRITE` (Claude:
  `--permission-mode acceptEdits`, tools add `Edit,Write` but never `Bash`; Codex: `-s
  workspace-write`, `--ask-for-approval never`) — provider branching stays inside each adapter, per
  policy. Known limitation: Codex's `WORKTREE_WRITE` flags (`-s workspace-write`,
  `--ask-for-approval never`) are taken from the public Codex CLI flag set, not re-verified against
  an installed binary — this development environment has no standalone `codex` executable on `PATH`
  (only a copy bundled inside the ChatGPT app and a Codex plugin were found), so `codex exec --help`
  could not be run. Claude's flags were verified against the installed CLI's own `--help` output.
  Confirm the Codex flags before a real `WORKTREE_WRITE` Codex run.
- New `apps/server/src/services/build-review-workflow.ts` (mirrors `BrainstormWorkflow`'s
  state-machine/usage-safety-recheck shape) orchestrating builder → validation → diff → reviewer,
  `apps/server/src/services/validation-runner.ts` (sequential, no shell — see known limitation
  below), and `apps/server/src/routes/build-runs.ts`. `WorktreeUsageManager.acquire`/`release` is
  now called from production code for the first time (one continuous lease per build, spanning
  build+validate+review). Shared `extractJson`/`record`/`strings` JSON-parsing helpers were
  extracted from `brainstorm-workflow.ts` into `apps/server/src/services/structured-output.ts` so
  the new reviewer-findings parser reuses them instead of duplicating.
- Known limitation: validation commands never use a shell (an explicit anti-injection stance, like
  every other process this application spawns), so a stored command string is tokenized into a
  plain argv with a minimal whitespace/quote-aware tokenizer — no pipes, `&&`/`||` chains,
  redirects, or inline environment assignment.
- New `WorktreeService.diffIncludingUntracked` (`packages/git`): plain `git diff` never shows a
  brand-new untracked file's content, only changes to files Git already tracks, which would have
  silently hidden a builder's newly created files from the reviewer. Temporarily stages everything
  to compute one full diff, then resets the index back to HEAD so nothing stays staged — a snapshot
  operation, not a persistent mutation. The pre-existing worktree diff route/UI (`04 — Worktrees`)
  is unchanged and still uses the original `diff()`.
- Pre-existing bug found and fixed while building this slice, unrelated to Phase 5 itself:
  migrations 0002/0003 added `agent_runs.task_id`/`agent_runs.worktree_id` via `ALTER TABLE ... ADD
  COLUMN ... REFERENCES ...`, which SQLite always creates as `ON DELETE NO ACTION` regardless of the
  `onDelete: "cascade"`/`"set null"` already declared in `schema.ts` at the time — invisible until
  something tried to delete a worktree or task while `agent_runs` rows referencing it needed to
  survive (every prior code path only ever deleted the whole project, cascading through
  `agent_runs.project_id` directly). Fixed with a hand-written migration
  (`drizzle/0006_fix_agent_runs_worktree_fk.sql`) that rebuilds `agent_runs` with the FK actions
  `schema.ts` already declared; `db:generate` reports "No schema changes" afterward, confirming the
  fix matches declared intent. Verified against seeded sample data in an isolated database before
  applying to the real local database; no data was lost (`PRAGMA foreign_key_check` clean
  afterward).
- Web-decision note: `BuildReviewWorkflow` does not check per-task web access at all — the builder
  and reviewer runs reuse each task's existing `webAccessPolicy`/`webAccessPermitted` decision made
  at task-draft time, the same way brainstorm runs do; no separate build-time web prompt exists.
- UI: un-disabled nav item `06 — Build`; new `#build` section (task picker, builder/reviewer role
  selects with mutual-exclusion, a validation-command checklist, start button, and a detail pane
  with validation results, the reviewed diff, and structured findings). Deliberately does not
  include `[Send Findings to Builder]`/`[Re-review]`/`[Mark Ready for Human Review]` controls (all
  out of scope for this slice). Verified in the browser: task selection, mutual-exclusion between
  builder/reviewer selects (confirmed via each `<select>`'s actual `disabled` option state), and no
  console errors. A real build was deliberately not started against the browser-visible registered
  project, to avoid spending real provider usage or writing to that real repository; correctness
  was instead proven with fake adapters and temporary repositories in the automated test suite.
- Tests executed: full workspace `npm test` (67 tests: 48 `apps/server` + 12 `packages/agents` + 7
  `packages/git`, up from 40/5/6), `npm run typecheck`, `npm run build`, `npm run check:agent-policy`,
  `npm run db:generate` (reports the new migration only), `git diff --check` — all clean. New
  coverage: `ProcessSupervisor` accepting `WORKTREE_WRITE`/`TEST_ONLY` only inside a real worktree;
  `ClaudeAdapter`/`CodexAdapter` argument construction per permission profile (via an injectable
  fake executable and a capturing `ProcessSupervisor` subclass, so no real CLI is spawned);
  `ValidationRunner` recording `PASSED`/`FAILED`/`ERROR` without throwing; `WorktreeService.
  diffIncludingUntracked`; a `build-runs.test.ts` integration suite (builder writes only inside its
  own worktree, a failing validation command doesn't block review, the diff is a true snapshot, the
  reviewer's run leaves the worktree unchanged, an unparseable reviewer response still retains its
  raw output and fails the build, same-provider builder/reviewer is rejected, and
  `WorktreeUsageManager.isInUse` is true during the run and false after); and an extension of
  `end-to-end-workflow.test.ts` (per its own prior note) adding a build/review pass that reuses an
  already-created worktree, asserts findings are reachable via the API, and confirms the builder's
  leftover uncommitted change correctly blocks worktree removal until committed.

### Phase 5, slice 2 completion record

- Date: 2026-09-13
- Scope: `PROJECT_SPEC.md` §23 (review response) — a human-triggered round that sends a build's
  open findings back to the builder, records its per-finding `ACCEPTED`/`REJECTED`/
  `PARTIALLY_ACCEPTED` verdict with evidence and action, re-runs validation and re-snapshots the
  diff, then has the reviewer recheck each finding (resolved or still open) and raise any new
  findings from the fresh diff — capped by a per-build maximum round count. Deliberately out of
  scope, tracked as unchecked above: human-approved merge, post-merge validation, guarded
  auto-cleanup, `Keep worktree after merge`, merged-branch deletion policy, and the pre-PR report.
- Schema: `build_runs` gained `reviewRound` (starts at 1, incremented by each response round) and
  `maxReviewRounds` (set once at build-start time, default 3, range 1-10 — deliberately a per-build
  setting rather than a hardcoded constant, per the standing feedback that the round cap must be
  configurable, not hardcoded). `review_findings` gained `round`, `builderVerdict`, `builderEvidence`,
  `builderAction`, `respondedAt`, `reviewerRecheckNote`, and widened `status` from a single `OPEN`
  value to `OPEN | RESPONDED | RESOLVED`. `build_runs.status` gained `RESPONDING`. `task_artifacts.kind`
  gained `FINDING_RESPONSE` and `REVIEW_RECHECK`. All additive (`ALTER TABLE ... ADD COLUMN`);
  `npm run db:generate` confirms no destructive change and the `kind`/`status` enum widenings needed
  no migration (TypeScript-level only, as with every prior enum addition in this project).
- `apps/server/src/services/build-review-workflow.ts`: new `respondToFindings` entry point and a
  `respondPipeline` mirroring the original build/validate/review pipeline's shape — builder response
  run (new `build-response:v1` prompt, `prompts/builder-response.md`) → validation (re-run against
  the same command set as the prior round by default, via a new `previousValidationCommandIds`
  lookup) → diff re-snapshot (intentionally overwrites the prior round's diff; per-round diff history
  is not separately retained, a known limitation) → reviewer recheck run (new
  `code-review-recheck:v1` prompt, `prompts/code-reviewer-recheck.md`). Both new structured-output
  parses (`parseFindingResponses`, `parseRecheck`) are all-or-nothing like the existing finding parser
  and additionally assert the response/recheck covers *exactly* the findings it was asked about
  (`assertExactOrdinals`) — a missing or invented ordinal fails the whole round rather than silently
  dropping a finding's disposition.
- Known limitation, deliberately scoped out rather than overlooked: a usage-safety checkpoint during
  the *original* build/validate/review pipeline (round 1) remains resumable via the existing
  `/builds/:id/resume` endpoint as before. A checkpoint during a later response round is not — since
  round 1's diff-nullability trick that `resume()` uses to infer which phase to resume from no longer
  works once a diff already exists from an earlier round, `resume()` now explicitly refuses (fails
  the build with a clear message) whenever `reviewRound > 1`, rather than silently resuming into the
  wrong phase. Nothing already persisted for that round is lost; restarting currently requires a
  fresh `/respond` call once usage allows, not `/resume`. Full mid-round checkpoint/resume is left for
  a future slice.
- UI (`apps/web/src/App.vue`): a "Maximum review rounds" number input (default 3) on the start-build
  form; the build inspector heading now shows `ROUND {{reviewRound}} / {{maxReviewRounds}}`; each
  finding shows its round, status (`OPEN`/`RESPONDED`/`RESOLVED`, color-coded), builder
  verdict/evidence/action once responded, and the reviewer's recheck note once rechecked; a
  "Send N open finding(s) to builder" button appears only when the build is `COMPLETED`, has at
  least one `OPEN` finding, and hasn't reached its configured round cap, with an explanatory line
  once the cap is reached instead. The stale "ONE REVIEW ROUND" badge from slice 1 is corrected to
  "CONFIGURABLE REVIEW ROUNDS". Verified in the browser: the new field renders with its default,
  the badge text updates, and no console errors — a real response round was deliberately not
  triggered against the browser-visible registered project's task (no build existed for it yet, and
  starting one would spend real provider usage); the full response/re-review cycle is instead proven
  end-to-end with fake adapters in the automated test suite.
- Tests executed: full workspace `npm test` (74 tests: 55 `apps/server` + 12 `packages/agents` + 7
  `packages/git`, up from 67), `npm run typecheck`, `npm run build`, `npm run check:agent-policy`,
  `npm run db:generate` (reports the new migration only, confirms the enum widenings need none),
  `npm run db:migrate` against the existing local database, `git diff --check` — all clean. New
  coverage in `build-runs.test.ts` (7 new tests): a finding resolved on recheck with the round
  advancing; a finding reopened plus a new finding raised on recheck; refusing a response round with
  no open findings; refusing a response round once `maxReviewRounds` is reached (and confirming
  nothing changed); failing cleanly (finding left untouched) when the builder's response can't be
  parsed; failing cleanly (builder's response still recorded) when the reviewer's recheck can't be
  parsed; and rejecting a response round on a build that isn't `COMPLETED`.

### Phase 5, slice 3 completion record

- Date: 2026-09-13
- Scope: `PROJECT_SPEC.md` §12/§21 — a human-approved merge of a completed build's worktree branch
  into a target branch, post-merge validation, and guarded automatic cleanup. Deliberately out of
  scope, tracked as unchecked above: the pre-PR report.
- **There is no other commit path in this application** — a builder/response run only ever edits
  files in its worktree (confirmed by slice 1's own end-to-end test, which found the builder's
  change left uncommitted). Merge is therefore the first place anything gets committed, and it does
  so explicitly, as part of the human's own approval action, never silently beforehand: `git add -A`
  + `git commit` inside the task worktree, authored as `AI Engineering Workspace (<provider>
  builder) <...>` while leaving the *committer* identity as whatever the repository already has
  configured (so a real registered repository's own commit identity is never overridden).
- `packages/git/src/WorktreeService.ts` gained `commitAll`, `beginMerge`, `finalizeMerge`, and
  `abandonMerge`. The merge itself never checks out or touches the developer's active checkout or
  any existing worktree: `beginMerge` creates a throwaway **detached** worktree at the target
  branch's current tip (detached, not checked out by branch name, so it never collides with that
  branch already being checked out elsewhere), runs `git merge --no-ff` there, and on success leaves
  that temp worktree in place — still uninspected by anything else — so the caller can run
  post-merge validation against exactly the tree that is about to become the target branch's new
  tip. `finalizeMerge` then lands the result with a compare-and-swap `git update-ref` (fails loudly
  rather than silently overwriting if the target branch moved since `beginMerge` read its tip) and
  removes the temp worktree. On conflict, `beginMerge` aborts the merge, removes the temp worktree,
  and reports the conflicting file list — the task worktree and target branch are both left exactly
  as they were.
- Known, deliberate consequence (not a bug, and directly load-bearing on the "never touch the
  developer's active checkout" rule this whole application is built around): if the target branch
  happens to already be checked out somewhere — commonly the developer's own primary checkout —
  `update-ref` moving its ref out from under that checkout leaves that checkout's index stale
  relative to its own branch (proven in `WorktreeService.test.ts`: `git status --porcelain` there
  reports the newly-merged file as a staged deletion until the human runs `git status`/`git reset
  --hard` themselves). This is the same thing that happens with any tool that moves a checked-out
  branch's ref without touching the checkout (e.g. a bare `git fetch` into it) — not file corruption,
  just a checkout that needs a refresh. `BuildReviewWorkflow.mergePipeline` detects this ahead of
  time (`build_runs.mergeTargetCheckedOutAt`, checked via `WorktreeService.list` before merging) and
  the UI surfaces it explicitly next to a successful merge, so it is never a silent surprise.
- Schema: `build_runs` gained `mergeStatus` (`NOT_MERGED|MERGING|MERGED|MERGE_CONFLICT|MERGE_FAILED`,
  tracked independently of `status` so a merge outcome can never be confused with the build/review
  workflow's own), `mergeTargetBranch`, `mergeCommitSha`, `mergedAt`, `mergeError`,
  `mergeTargetCheckedOutAt`, `worktreeRemovedAfterMerge`, `branchDeletedAfterMerge`, and
  `worktreeCleanupSkippedReason` (always populated when the worktree wasn't removed — never left for
  a human to reconstruct from whether the worktree/branch still happens to exist). `validation_runs`
  gained `phase` (`BUILD|POST_MERGE`) so a post-merge validation re-run is distinguishable from the
  original pre-merge one without a second table. All additive (`ALTER TABLE ... ADD COLUMN`); `npm
  run db:generate` confirms no destructive change.
- `BuildReviewWorkflow.mergeBuild`/`mergePipeline`: commits outstanding worktree changes, resolves
  the target branch (defaults to the worktree's own `baseRef`, overridable per merge), detects
  whether it's checked out elsewhere, calls `beginMerge`, runs post-merge validation inside the temp
  worktree on conflict-free success, and writes `mergeStatus`/cleanup outcome together in one final
  update — deliberately combined into a single write (not two sequential ones) so a poller can never
  observe `MERGED` with the cleanup decision still mid-flight. `cleanupAfterMerge` follows §12
  exactly: skips (with a specific recorded reason) when the human asked to keep the worktree, when
  post-merge validation didn't pass, or when the worktree is still in use; otherwise removes the
  worktree (and, if requested, the now-provably-merged branch, reusing the existing
  `ensureBranchMerged`/`deleteMergedBranch` guards from Phase 4) and deletes its database record.
- Known limitation, deliberately scoped out rather than overlooked: `mergeBuild` does not
  participate in the usage-safety checkpoint/resume system — it spends no provider/model usage at
  all (only Git and the configured validation commands), so there is nothing for that system to
  gate. A merge that fails for a non-conflict reason (e.g. the task or project row disappeared)
  records `MERGE_FAILED` and stops; the human can retry by calling merge again once the underlying
  problem is fixed.
- UI (`apps/web/src/App.vue`): a "MERGE" subsection on the build detail pane showing `mergeStatus`,
  target branch, commit SHA, timestamp, the checked-out-elsewhere note when applicable, and the
  worktree/branch cleanup outcome; an "Approve & merge" control (optional target branch, optional
  commit message, "Keep worktree after merge" and "Delete task branch after merge" checkboxes)
  appears whenever the build is `COMPLETED` and not already merged/merging. Verified in the browser:
  the section and its inputs render with no console errors. A real merge was deliberately not
  triggered against the browser-visible registered project's task (no build existed for it, and
  every merge action commits real changes and moves a real branch ref) — the full commit → merge →
  post-merge-validation → cleanup cycle, including the conflict and stale-checkout-detection paths,
  is instead proven end-to-end with fake adapters and temporary repositories in the automated test
  suite.
- Tests executed: full workspace `npm test` (85 tests: 62 `apps/server` + 12 `packages/agents` + 11
  `packages/git`, up from 74), `npm run typecheck`, `npm run build`, `npm run check:agent-policy`,
  `npm run db:generate` (reports the new migration only), `npm run db:migrate` against the existing
  local database, `git diff --check` — all clean. New `WorktreeService` coverage (4 tests):
  `commitAll` committing everything and truthfully no-op'ing when already clean; a clean merge that
  proves the primary checkout's working files are never touched mid-operation and the temp worktree
  is gone afterward; a real conflicting merge that leaves the task worktree, target branch, and
  Git's worktree list completely unchanged; and refusing to merge into a branch that doesn't exist
  locally. New `build-runs.test.ts` coverage (7 tests): a full commit → merge → post-merge-validation
  → cleanup success case (including the target-checked-out-elsewhere detection); `keepWorktreeAfterMerge`
  preserving the worktree despite a successful merge; `deleteBranchAfterMerge` actually deleting the
  branch; a real merge conflict leaving everything untouched with the conflicting file named; a
  failing post-merge validation command keeping the worktree despite the merge landing; refusing a
  merge on a build that isn't `COMPLETED`; and refusing a second merge once already merged. While
  writing these, also fixed two pre-existing test-hygiene bugs unrelated to merge itself: two earlier
  slice-2 tests that deliberately used a delayed fake builder to catch a build mid-flight never
  waited for that background run to actually finish, so it could still be writing to the in-memory
  database well after that test's own app had closed it — an intermittent `Unhandled Rejection`
  that vitest treats as a hard failure (exit code 1) even though every assertion passed. Both now
  explicitly drain the delayed run to a terminal state before returning.

### Phase 5, slice 4 completion record — Phase 5 complete

- Date: 2026-09-13
- Scope: `PROJECT_SPEC.md` §25 (pre-PR report), the last unchecked Phase 5 item. With this, every
  Phase 5 roadmap item is implemented.
- New `apps/server/src/services/pre-pr-report.ts` (`buildPrePrReport`, pure/read-only — no new
  schema, computed on demand from existing `build_runs`/`review_findings`/`validation_runs`/
  `agent_runs` rows) and `GET /api/builds/:id/report`. Deliberately adapted rather than copied
  verbatim from §25: that section's "Claude Findings"/"Codex Findings" split assumed the dual
  independent-review shape from the brainstorm workflow; a Phase 5 build has exactly one fixed
  reviewer, so findings are grouped by disposition instead (accepted/rejected/unresolved, derived
  from each finding's `builderVerdict` and `status`). "Architecture Decisions" is always reported as
  unavailable when this slice shipped because ADRs had not been built yet; Phase 6 subsequently
  replaced that placeholder with the real ADRs related to the build task. "Human Review Required" is always `true`
  (§25: "AI approval is never equivalent to human approval") — not derived from any build state.
- `parseChangedFiles` extracts changed file paths from the stored unified-diff text (via the
  conventional `diff --git a/... b/...` and `+++ b/...` header lines) since the diff is stored as
  text, not as a structured file list, and nothing else in the schema already tracks it separately.
  Tolerant by design: an unrecognized line is skipped rather than failing report generation, since
  this is a human-facing summary, not something anything else depends on being byte-exact.
- UI (`apps/web/src/App.vue`): a "PRE-PR REPORT" subsection on the build detail pane with a
  "Generate report" button (the report is computed on demand, not auto-generated on every build
  view, since it re-reads all of a build's findings/tests each time) rendering problem statement,
  implementation summary, files changed, a findings breakdown, test results, merge state,
  architecture-decisions availability, and the recommended next action. Verified in the browser: no
  console errors; a real report was not generated against the browser-visible registered project's
  task (no build existed for it) — the full report shape is instead proven end-to-end with fake
  adapters in the automated test suite.
- Tests executed: full workspace `npm test` (91 tests: 68 `apps/server` + 12 `packages/agents` + 11
  `packages/git`, up from 85), `npm run typecheck`, `npm run build`, `npm run check:agent-policy`,
  `npm run db:generate` (confirms no schema drift — this slice added no columns), `git diff --check`
  — all clean. New coverage: `pre-pr-report.test.ts` (4 tests) unit-testing `parseChangedFiles`
  directly (a changed-file header, a brand-new file with no `a/` side, dedupe/sort across multiple
  files while ignoring unrelated diff lines, and an empty diff); a `build-runs.test.ts` integration
  test that responds to a finding, merges, then fetches the report and checks every field including
  the findings breakdown and the always-true human-review-required flag; and a 404 test for a
  nonexistent build.

## Phase 6 — Planning and ADRs

- [x] Assumption board editing (already shipped in Phase 3 — see the correction above; content and
      type reclassification both work today)
- [x] ADRs
- [x] Experiments
- [x] Plan promotion
- [x] Linked implementation tasks

### Phase 6, slice 1 completion record — ADRs

- Date: 2026-09-13
- Scope: `PROJECT_SPEC.md` §18 — architecture decision records, stored in SQLite, created from a task
  and editable afterward. Explicitly out of scope per the spec itself ("Optional later... Do not
  automatically modify the target repo for an ADR without approval"): Markdown export into the
  target repository. Deliberately out of scope for this slice, tracked as unchecked above:
  experiments (§19) and plan promotion/linked tasks (§20) — the remaining Phase 6 checklist items.
- While scoping this phase, corrected a stale claim in the Phase 3 record (see above): evidence-item
  type reclassification was already implemented, not "API-only" as previously written.
- Schema: new `adrs` table (`apps/server/src/db/schema.ts`) — a genuine `CREATE TABLE`, not an
  `ALTER TABLE ... ADD COLUMN ... REFERENCES` (the pattern that caused Phase 5's known SQLite
  foreign-key-action bug), so both of its foreign keys carry correct `ON DELETE CASCADE` semantics
  from the start. Numbered sequentially **per project** (`adrs_project_number_idx`, a unique
  `(project_id, number)` index), not per task, so the numbering reads as one running ADR log across
  a project's entire history the way a real ADR directory would, matching the spec's own
  `ADR-0004`-style example. `relatedTaskIds` is a loose, human-curated `json` array of task IDs — not
  FK-enforced — since Phase 6's later plan-promotion work is what's meant to give task relationships
  a first-class, constrained model; this is deliberately a documentation link, not a data-integrity
  one, until then.
- New `apps/server/src/routes/adrs.ts`: `GET /api/projects/:id/adrs` (project-wide, ordered by
  number), `GET /api/tasks/:id/adrs`, `POST /api/tasks/:id/adrs` (assigns the next sequential number
  for that project), `GET /api/adrs/:id`, `PATCH /api/adrs/:id` (partial update of any field
  including `status`, matching the evidence-item PATCH's already-established omitted-field-keeps-
  current-value convention). No delete route — PROJECT_SPEC.md §18 describes an ADR as a durable
  decision record, not something the app should offer to erase.
- `apps/server/src/services/pre-pr-report.ts` updated for cohesion: `architectureDecisions` changed
  from a hardcoded "not implemented yet" string to a real, computed list of ADRs that either
  originated from the build's task or explicitly name it in `relatedTaskIds` — still an honest empty
  list (never a fabricated "none exist" narrative) when nothing matches.
- UI: un-disabled nav item `08 — Decisions` (previously a permanent placeholder alongside the
  still-unimplemented `07 — Reviews`); new `#decisions` section with a task picker, a create form for
  all §18 fields, and a per-ADR card showing every field plus a status dropdown (`PROPOSED` /
  `ACCEPTED` / `REJECTED` / `SUPERSEDED`). Initially reused the evidence board's `.evidence-form`/
  `.evidence-item` CSS classes for consistency, but their fixed 3-column grid (built for evidence's
  short type/content/source shape) badly overlapped ADRs' much longer multi-paragraph fields —
  caught in browser verification, not just by reading the code — so `.adr-form`/`.adr-item` override
  those to a single stacked column instead. Verified live in the browser end-to-end: created a real
  ADR (no provider usage involved, so this was safe to actually exercise rather than only test with
  fake adapters), confirmed it persisted and rendered correctly after the CSS fix, and changed its
  status via the dropdown, confirmed against a fresh `GET`.
- Found and fixed during this slice, unrelated to ADRs themselves: while investigating what Phase 6
  needed, discovered a second Claude Code session was concurrently working in this same repository
  (on an equivalent brainstorm/architecture-task report — see the "Later addition" note under Phase
  3 above). Confirmed with the user this was expected before continuing; no conflicting edits
  occurred since the two efforts touched different routes/files, but this is worth knowing for
  future agents: check `git status --short` for changes you didn't make before assuming something is
  broken, the way `AGENTS.md`'s "Preserving unrelated changes" section already advises.
- Tests executed: full workspace `npm test` (103 tests: 80 `apps/server` + 12 `packages/agents` + 11
  `packages/git`, up from 91 — the increase also includes the concurrent session's own brainstorm-
  report tests), `npm run typecheck`, `npm run build`, `npm run check:agent-policy`, `npm run
  db:generate` (reports only the new `adrs` table), `git diff --check` — all clean. New coverage in
  `adrs.test.ts` (9 tests): sequential per-project numbering (including across two different tasks
  in the same project), a required-field validation failure, 404s for a nonexistent task/ADR/project,
  task-scoped listing, a partial `PATCH` that leaves omitted fields unchanged, and rejecting an
  invalid status value. Extended `build-runs.test.ts`'s pre-PR report tests with a case proving an
  ADR linked via `relatedTaskIds` (or originating from the build's own task) appears in the report.

### Phase 6, slice 2 completion record — experiments

- Date: 2026-09-13
- Scope: `PROJECT_SPEC.md` §19 — an isolated proof-of-concept run on an architecture task: a builder
  implements only the smallest POC needed to test a stated hypothesis, an independent reviewer
  assesses whether it actually holds, and the outcome becomes an `EXPERIMENT_RESULT` evidence-board
  item automatically. Deliberately out of scope, tracked as unchecked above: plan promotion and
  linked implementation tasks (§20), the last Phase 6 item.
- Deliberately much smaller than `BuildReviewWorkflow` (Phase 5), not a copy of it: new
  `apps/server/src/services/experiment-workflow.ts` has no validation-command execution (a POC
  isn't expected to pass a project's full test suite), no finding-response/re-review loop, and no
  merge — an experiment's outcome is meant to inform a decision via evidence, never to land in the
  target branch. New prompts `prompts/experiment-builder.md` (told explicitly to implement only the
  smallest POC and to actually test it, not just implement) and `prompts/experiment-reviewer.md`
  (returns a structured `PROVEN`/`DISPROVEN`/`INCONCLUSIVE` verdict with reasoning, result, and
  conclusion — instructed to return `INCONCLUSIVE` rather than guess when the diff doesn't clearly
  demonstrate the hypothesis either way).
- Schema: new `experiments` table (a genuine `CREATE TABLE`, following slice 1's ADR precedent of
  avoiding Phase 5's known `ALTER TABLE ... ADD COLUMN ... REFERENCES` foreign-key pitfall) and a
  widened `task_artifacts.kind` (`EXPERIMENT_RESULT`, TypeScript-level only — `db:generate` confirmed
  no migration needed). **Known, deliberate limitation, not an oversight:** an experiment reuses the
  exact same worktree slot (`ensureWorktreeForTask`, keyed on `(taskId, provider)`) an ordinary Phase
  5 build would use for that task and provider — a separate experiment-specific worktree-naming
  scheme (the spec's own example names one differently: `experiment/TASK-123/shard-routing`) was
  considered and deliberately not built, since it would need widening `worktrees`' unique
  `(taskId, provider)` index on an existing Phase 4 table, a real migration-risk trade-off not
  justified for this slice. In practice this means an architecture task cannot run both a regular
  Phase 5 build and an experiment for the same provider at the same time; it can for two different
  providers, or sequentially.
- New `apps/server/src/routes/experiments.ts`: `POST /api/tasks/:id/experiments` (starts
  immediately — hypothesis + both providers required up front, no separate draft/start step, unlike
  brainstorm tasks — refuses a second concurrent experiment for the same task+provider), `GET
  /api/tasks/:id/experiments`, `GET /api/experiments/:id`, `POST /api/experiments/:id/cancel`. Same
  provider-readiness and usage-safety preflight pattern as every other provider-consuming route in
  this app.
- UI: a new "EXPERIMENTS / PROOFS OF CONCEPT" subsection on the Brainstorm task detail pane
  (`apps/web/src/App.vue`), next to the evidence board and brainstorm plan report — deliberately
  placed there rather than under "08 — Decisions" (which slice 1 dedicated to ADRs specifically),
  since an experiment belongs to a task's own working context and its result feeds that same
  task's evidence board. Reuses the `.adr-form`/`.adr-item` CSS fix from slice 1 (a single stacked
  column, not evidence board's fixed 3-column grid) for the same reason it was needed there: an
  experiment's hypothesis/result/conclusion fields don't fit a short type/content/source shape.
  Verified in the browser: the section renders with an empty state and no console errors. A real
  experiment was deliberately not started against the browser-visible registered project's task (it
  spends real provider usage, like every other agent-run feature in this app) — the full
  builder → diff → reviewer → verdict → evidence pipeline, including the unparseable-verdict and
  concurrent-experiment-refusal paths, is instead proven end-to-end with fake adapters in the
  automated test suite.
- Tests executed: full workspace `npm test` (110 tests: 87 `apps/server` + 12 `packages/agents` + 11
  `packages/git`, up from 103), `npm run typecheck`, `npm run build`, `npm run check:agent-policy`,
  `npm run db:generate` (reports only the new `experiments` table), `git diff --check` — all clean.
  New coverage in `experiments.test.ts` (7 tests): a full builder → reviewer → verdict →
  evidence-item run (checking the evidence item's content and source provider, not just the
  experiment row); rejecting same-provider builder/reviewer; rejecting a missing hypothesis; failing
  cleanly when the reviewer's verdict can't be parsed, and confirming no evidence item is created in
  that case; refusing a second concurrent experiment for the same task/provider; listing experiments
  for a task; and 404s for a nonexistent task/experiment.

### Phase 6, slice 3 completion record — plan promotion and linked implementation tasks — Phase 6 complete

- Date: 2026-09-13
- Scope: `PROJECT_SPEC.md` §20 — the last unchecked Phase 6 item. An ADR can be promoted into one or
  more implementation tasks (call the promote action once per `TASK-20x` in the spec's own example),
  each keeping a real link back to it. With this, every Phase 6 roadmap item is implemented.
- Relationship chain, deliberately kept to what's actually needed rather than a new relational
  model: a promoted task's `originAdrId` links straight to its ADR; the ADR itself already carries
  the originating architecture task (`taskId`) and any related experiments (`relatedTaskIds`), so
  one link on the task is enough to walk the whole chain (`task -> ADR -> architecture discussion +
  experiments`) the spec asks for. `planPhase` is a free-text grouping label (e.g. "Phase 1 — Shard
  Registry") set at promotion time so several tasks can share a visible phase heading — not a
  separate "plan" entity/table, a deliberate scope reduction given the size of everything else in
  this phase.
- Schema: `tasks` gained `type: "IMPLEMENTATION"` (a new task kind, distinct from `BRAINSTORM`/
  `ARCHITECTURE`, for a task meant to skip straight to Phase 5's Build workflow rather than go
  through independent-analysis brainstorming again), `originAdrId`, and `planPhase`. **Not** a
  `.references()` foreign key on `originAdrId`, unlike most links in this schema: `adrs` is defined
  later in `schema.ts` and itself references `tasks`, and TypeScript's inference through Drizzle's
  lazy `() => table` reference thunks cannot resolve that mutual cycle (confirmed by trying it first
  — `tsc` reported "implicitly has type 'any' because it... is referenced... in its own
  initializer" on both tables) — a real compiler limitation, not a stylistic choice. So, like
  `adrs.relatedTaskIds` on the other side of this same relationship, it's a loose, system-set id,
  not FK-enforced. Both new `tasks` columns are additive `ALTER TABLE ... ADD COLUMN` with no
  `REFERENCES` clause, so Phase 5's known SQLite FK-on-ALTER pitfall doesn't apply here regardless.
- New `apps/server/src/routes/adrs.ts` routes: `POST /api/adrs/:id/promote` (title +
  problemStatement required, riskLevel defaults to `MEDIUM`, planPhase optional — creates exactly
  one new `DRAFT` `IMPLEMENTATION` task per call, never auto-started) and `GET
  /api/adrs/:id/promoted-tasks`.
- UI: each ADR card in `apps/web/src/App.vue`'s Decisions section now shows its already-promoted
  tasks (title, status, plan phase) and an inline "+ Promote to implementation task" form. Verified
  end-to-end in the browser against the real local database (this spends no provider usage — it's
  pure bookkeeping, unlike starting a build or an experiment): promoted ADR-0001 into a real
  `Create shard registry schema` task tagged "Phase 1 — Shard Registry", confirmed via a direct API
  call that `originAdrId` and `planPhase` both persisted correctly, and confirmed the card's
  "Promoted to:" list updated. One transient `Failed to fetch` console error appeared during this
  session — traced to the local dev server restarting (`tsx watch` reacting to a concurrent editing
  session's own file save) at the same moment as a background reload, not a bug in the promotion
  logic itself, which had already completed successfully by then.
- Tests executed: full workspace `npm test` (114 tests: 91 `apps/server` + 12 `packages/agents` + 11
  `packages/git`, up from 110), `npm run typecheck`, `npm run build`, `npm run check:agent-policy`,
  `npm run db:generate` (reports only the two new `tasks` columns), `git diff --check` — all clean.
  New coverage in `adrs.test.ts` (4 tests): promoting an ADR into a linked task and confirming the
  full chain is walkable (promoted task -> ADR -> originating architecture task); creating multiple
  tasks under the same plan phase from repeated promote calls; rejecting promotion with a missing
  title or problem statement; and a 404 for promoting a nonexistent ADR.

## Phase 7 — Hardening

- [x] Expanded environment-sanitization and deny-list hardening
- [ ] Sensitive path deny list
- [x] Process cancellation and timeouts
- [x] CLI failure handling
- [ ] Worktree conflict handling
- [ ] Database backups
- [ ] Cleanup tools
- [ ] Audit history

### Phase 7, slice 1 completion record — process, environment, and CLI failures

- Date: 2026-09-13
- Expanded the environment deny-list to cover access keys, bearer/client secrets, connection
  strings, cookies, passphrases, sessions, and common GitHub/GitLab/npm credential prefixes.
  Per-run input can no longer redirect trusted authentication/configuration locations (`HOME`,
  `CODEX_HOME`, `PATH`, `TMPDIR`, or XDG directories), and null-byte values are rejected.
- `ProcessSupervisor` now sends `SIGTERM` to the whole process group and escalates to `SIGKILL`
  after a bounded grace period. New tests prove both cancellation and timeout finish even when a
  parent and its descendant ignore `SIGTERM`, rather than leaving an orphan process or hanging the
  run forever.
- Added provider-neutral failure classification for expired/missing authentication, unavailable
  models, timeouts, and ordinary process errors. Failure events persist the classification in their
  event payload and replace opaque exit-code messages with actionable guidance. If a CLI reports a
  different actual model from an explicitly requested model, the run is failed and the actual model
  is retained; the workspace never silently accepts a substitution. Provider-default runs remain
  valid because no exact model was requested, and a missing actual-model report remains unknown
  rather than fabricated.
- Re-inspected the installed CLIs before changing invocation flags. The current Codex `exec --help`
  supports `--approve-for-me`, not the previously configured `--ask-for-approval never`; Phase 7
  updates `WORKTREE_WRITE` runs to the supported workspace-write plus automatic-review form and
  adds an argument-construction regression test. No provider call was made.
- Focused verification before the full phase-slice suite: 35 `packages/agents` tests and 5
  `agent-runs` route tests passed; agent and server TypeScript checks were clean.
- Full verification: `npm test` (139 workspace tests: 93 server + 35 agents + 11 Git, plus 9
  policy-script tests), `npm run typecheck`, `npm run build`, `npm run check:agent-policy`, `npm run
  db:generate` (no schema changes), and `git diff --check`; all passed under Node 22.23.2.

## Phase 8 — Usage, token, and cost monitoring

Not started. Queued behind Phase 7; Phases 5 and 6 are complete. See
`IMPLEMENTATION_ROADMAP.md`'s Phase 8 entry and the full spec at `USAGE_MONITORING_SPEC.md`. Do not
start without an explicit human instruction to pull it forward, and re-verify installed Claude/Codex
CLI usage-telemetry capabilities at that time rather than trusting this record.

- [ ] Re-verify installed Claude/Codex CLI usage telemetry and historical-data recoverability
- [ ] `UsageRecord` data model and migration
- [ ] Pricing registry and API-equivalent cost calculation
- [ ] Workspace/project/task/run usage dashboard
- [ ] Cross-review cost breakdown
- [ ] Task usage budgets integrated with the max-review-round cap
- [ ] Historical backfill with a backfill report
- [ ] Usage & Cost settings

## End-to-end workflow verification (cross-cutting)

Not one of the phases above: every earlier phase's tests exercise one route or service at a time with fake data seeded directly. Nothing proved the pieces actually work *together*, in the order a real user would drive them, using only the app's own HTTP surface.

- [x] Single integration test walking the entire currently-implemented pipeline in one continuous run: register a project → confirm tool health → draft a brainstorm task → usage-safety refuses to start it blind → acknowledge both providers → independent analyses run and cross-review follows automatically → comparison and evidence are populated → both Claude and Codex worktrees are created from the approved task → isolation is verified (three worktrees total, source checkout untouched) → deregistration is refused while worktrees remain linked → each worktree is cleaned up → deregistration then succeeds → usage was never fabricated (still `UNAVAILABLE`, only the two acknowledgements from earlier are on record).

Completion record:

- Date: 2026-09-13
- File: `apps/server/src/routes/end-to-end-workflow.test.ts`. Uses a temporary Git repository and fake `AgentAdapter` implementations (no synchronization barrier needed here — that parallelism guarantee is already proven in `tasks.test.ts`; this test's job is pipeline correctness, not timing) and spends no real provider usage.
- This test doubles as a regression guard for the cross-phase interactions two earlier fixes introduced: the combined-workflow usage-safety acknowledgement gate (step 4) and the deregistration-vs-linked-worktrees guard (step 8) — both are now proven not just in isolation but as part of the full flow a user actually follows.
- Tests executed: full workspace `npm test` (59 tests: 40 `apps/server` + 5 `packages/agents` + 6 `packages/git` + 9 `scripts/check-agent-policy.test.mjs`), `npm run typecheck`, `npm run build`, `git diff --check` — all clean.
- Known limitation: this cross-phase walkthrough still stops at Phase 4 worktree creation/cleanup even though Phases 5 and 6 are now implemented and covered by their own route/service integration tests. Extend this same test during Phase 7 hardening to cover the builder/reviewer loop and planning/ADR flow rather than writing a second, separate end-to-end test.
