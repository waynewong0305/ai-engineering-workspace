# Implementation Status

Last updated: 2026-09-13

## Current release boundary

The application currently supports local startup, tool readiness checks, SQLite-backed project registration, read-only Git inspection, saved validation-command configuration, deliberate read-only Claude Code/Codex repository-explanation runs, persisted brainstorm/architecture workflows with independent analysis, reciprocal review, comparison, web-decision audit, cancellation, and an evidence board, isolated Git worktree creation/inspection/rename/cleanup for Claude and Codex task work, a cross-cutting Claude/Codex usage-safety system, and **Phase 5 (build, validate, and review) is now fully implemented**: a worktree-scoped `WORKTREE_WRITE` builder run, honest validation-command execution, diff capture, a `READ_ONLY` reviewer run producing structured findings, a human-triggered finding-response/re-review round capped by a per-build maximum round count, a human-approved merge (commits the builder's outstanding worktree changes, merges into a target branch through a throwaway detached worktree that never touches the developer's own checkout, runs post-merge validation, and only then auto-cleans up the task worktree/branch when every §12 safety condition holds), and a generated pre-PR report summarizing the task, implementation, findings, tests, and merge state for the human's own final review. Phase 6 (planning/ADRs) and Phase 7 (hardening) remain unimplemented — see below.

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
- Known limitations: deregistration intentionally removes the project's local tasks, run history, and evidence after confirmation; remote default-branch discovery is local-only and falls back to the checked-out branch; validation commands are stored but cannot yet run.

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

Current record:

- Date: 2026-09-13
- Decisions: task drafts are free and separate from the paid start action; analysis providers receive identical task context independently; cross-review begins only after both analyses persist; the comparison is deterministic and never selects a winner; task web access is resolved explicitly before creation.
- Modules introduced: task/artifact/comparison/evidence schema and migration, `BrainstormWorkflow`, task APIs, versioned prompt files, and the Phase 3 task/comparison UI.
- Tests executed: paired fake-provider parallelism barriers; full analysis → review → comparison workflow; structured/raw persistence; evidence creation/update; explicit web-decision validation; full TypeScript check; production build; migrated local API/UI inspection.
- Acceptance state: the database-sharding task exists as a `DRAFT` for the registered Boostorder project with web disabled. Its real four provider runs were not started automatically because they spend provider usage.
- Known limitations: active provider processes are not reconciled after a server restart; deterministic comparison depends on structured cross-review quality; the screen edits evidence content while type reclassification is currently API-only.

Later addition (2026-09-13): a brainstorm plan export, modeled on the build workflow's existing pre-PR report (`apps/server/src/services/pre-pr-report.ts`). `buildBrainstormPlanReport` (`apps/server/src/services/brainstorm-report.ts`) reads a task's analyses, cross-reviews, comparison, and evidence and assembles them into a report; unlike the build report it never blocks on task status — a task that's still running, checkpointed, failed, or cancelled still exports whatever completed, with a status-appropriate recommended next action, since a brainstorm task has no single fixed reviewer to gate on. Exposed as `GET /api/tasks/:id/report` and a **BRAINSTORM PLAN REPORT** section with a **Generate report** button on the task detail pane, next to the evidence board. Verified with a route-level test that runs the fake-adapter workflow to `READY` and checks the full report shape, a 404 test for an unknown task, `npm test`/`typecheck`/`build`/`check:agent-policy`/`db:generate` (no schema change), and manual browser verification of the button and its output on a `DRAFT` task.

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
- [ ] Guarded automatic cleanup after approved merge and passing post-merge validation (Phase 5: no merge workflow exists yet)
- [ ] Keep-after-merge override and separate merged-branch deletion policy beyond the existing explicit `deleteBranch` flag (full policy arrives with Phase 5 merge workflow)

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
- Known limitation: `WorktreeUsageManager.acquire`/`release` is fully implemented and tested but not yet called by any production code path, because no Phase 5 worktree-scoped agent run exists yet to acquire a lease. `isInUse` is therefore always `false` today; this is expected for the current phase boundary, not a bug.
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
  unavailable — ADRs (Phase 6) don't exist yet — never fabricated, matching this project's standing
  rule against inventing data a phase hasn't built yet. "Human Review Required" is always `true`
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

- [ ] Assumption board editing
- [ ] ADRs
- [ ] Experiments
- [ ] Plan promotion
- [ ] Linked implementation tasks

## Phase 7 — Hardening

- [ ] Expanded environment-sanitization and deny-list hardening
- [ ] Sensitive path deny list
- [ ] Process cancellation and timeouts
- [ ] CLI failure handling
- [ ] Worktree conflict handling
- [ ] Database backups
- [ ] Cleanup tools
- [ ] Audit history

## Phase 8 — Usage, token, and cost monitoring

Not started. Queued behind the rest of Phase 5, Phase 6, and Phase 7 — see
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
- Known limitation: Phase 5 (build/review) isn't implemented yet, so this walkthrough necessarily stops at worktree creation/cleanup; extend it to cover the builder/reviewer loop once that phase lands rather than writing a second, separate end-to-end test.
