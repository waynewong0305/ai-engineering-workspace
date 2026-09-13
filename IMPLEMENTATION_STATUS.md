# Implementation Status

Last updated: 2026-09-13

## Current release boundary

The application currently supports local startup, tool readiness checks, SQLite-backed project registration, read-only Git inspection, saved validation-command configuration, deliberate read-only Claude Code/Codex repository-explanation runs, and persisted brainstorm/architecture workflows with independent analysis, reciprocal review, comparison, web-decision audit, cancellation, and an evidence board. It does not yet create worktrees, run saved project commands, or implement code-writing/review workflows.

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

- [ ] Worktree service
- [ ] Meaningfully named task-specific branches and worktree paths
- [ ] Editable generated names and collision validation
- [ ] Safe worktree rename with branch/path independence
- [ ] Claude/Codex isolation
- [ ] Refuse project deregistration while managed worktrees remain linked
- [ ] Status and diff
- [ ] Guarded automatic cleanup after approved merge and passing post-merge validation
- [ ] Keep-after-merge override and separate merged-branch deletion policy
- [ ] Dirty-worktree protection

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
