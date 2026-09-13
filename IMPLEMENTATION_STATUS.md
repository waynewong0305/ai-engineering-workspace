# Implementation Status

Last updated: 2026-09-13

## Current release boundary

The application currently supports local startup, tool readiness checks, SQLite-backed project registration, read-only Git inspection, saved validation-command configuration, deliberate read-only Claude Code/Codex repository-explanation runs, persisted brainstorm/architecture workflows with independent analysis, reciprocal review, comparison, web-decision audit, cancellation, and an evidence board, and isolated Git worktree creation/inspection/rename/cleanup for Claude and Codex task work. It does not yet run saved project commands or implement code-writing/review workflows (Phase 5).

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

Current record:

- Date: 2026-09-13
- Decisions: task drafts are free and separate from the paid start action; analysis providers receive identical task context independently; cross-review begins only after both analyses persist; the comparison is deterministic and never selects a winner; task web access is resolved explicitly before creation.
- Modules introduced: task/artifact/comparison/evidence schema and migration, `BrainstormWorkflow`, task APIs, versioned prompt files, and the Phase 3 task/comparison UI.
- Tests executed: paired fake-provider parallelism barriers; full analysis → review → comparison workflow; structured/raw persistence; evidence creation/update; explicit web-decision validation; full TypeScript check; production build; migrated local API/UI inspection.
- Acceptance state: the database-sharding task exists as a `DRAFT` for the registered Boostorder project with web disabled. Its real four provider runs were not started automatically because they spend provider usage.
- Known limitations: active provider processes are not reconciled after a server restart; deterministic comparison depends on structured cross-review quality; the screen edits evidence content while type reclassification is currently API-only.

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
- [ ] Refuse project deregistration while managed worktrees remain linked (deregistration does not yet check for linked worktrees; tracked as a known limitation below)
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
- Known limitation carried forward: project deregistration does not yet check for or block on linked managed worktrees (`PROJECT_SPEC.md` section 12 / roadmap Phase 4 exit gate). This is scoped for a follow-up change alongside Phase 5, since no build/merge workflow exists yet to make an orphaned worktree during deregistration a live risk.
- Known limitation: `WorktreeUsageManager.acquire`/`release` is fully implemented and tested but not yet called by any production code path, because no Phase 5 worktree-scoped agent run exists yet to acquire a lease. `isInUse` is therefore always `false` today; this is expected for the current phase boundary, not a bug.
- Tests executed: `packages/git` unit tests (6, including new locked-worktree and orphan-recovery cases), `apps/server` route/service tests (14, including a new orphan-recovery route test), full workspace `npm test` (25 tests across `apps/server`, `packages/agents`, `packages/git`), `npm run typecheck` (clean across all five workspaces), `npm run build` (server `tsc` + web `vue-tsc -b && vite build`, clean), `npm run db:generate` (confirms no schema drift — Phase 4 introduced no new columns), `npm run db:migrate` against the existing local database (no-op, already at migration `0003`), and `git diff --check` (clean). Browser verification at desktop width and at an emulated ~390–587px mobile width confirmed the worktree task selector, proposal cards, availability/collision messaging, and (after the fix above) no page-level horizontal scrolling. Real worktree creation against the registered Boostorder repository was deliberately not exercised in the browser to avoid consuming a real task/provider slot or touching that repository; behavior was instead proven with temporary Git repositories in the automated test suite.

## Phase 5 — Build and review

- [ ] Builder/reviewer selection
- [ ] Validation execution
- [ ] Diff viewer
- [ ] Structured findings
- [ ] Finding response
- [ ] Re-review
- [ ] Maximum three rounds
- [ ] Pre-PR report

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
