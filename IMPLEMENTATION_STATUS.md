# Implementation Status

Last updated: 2026-09-13

## Current release boundary

The application currently supports local startup, tool readiness checks, SQLite-backed project registration, read-only Git inspection, saved validation-command configuration, and deliberate read-only Claude Code/Codex repository-explanation runs with SSE output, cancellation, timeouts, and persisted history. It does not yet create worktrees, run saved project commands, or implement multi-agent task workflows.

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
- Tests executed: clean temporary repository registration, non-repository rejection, post-registration Git status check.
- Known limitations: no project editing/removal UI; remote default-branch discovery is local-only and falls back to the checked-out branch; validation commands are stored but cannot yet run.

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

- [ ] Task creation
- [ ] Independent Claude analysis
- [ ] Independent Codex analysis
- [ ] Structured results
- [ ] Raw-output retention
- [ ] Cross-review
- [ ] Comparison screen
- [ ] Assumption/evidence board

## Phase 4 — Git worktrees

- [ ] Worktree service
- [ ] Task-specific branches
- [ ] Claude/Codex isolation
- [ ] Status and diff
- [ ] Safe cleanup
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
