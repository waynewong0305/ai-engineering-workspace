# Implementation Status

Last updated: 2026-09-13

## Current release boundary

The application currently supports local startup, tool readiness checks, SQLite-backed project registration, read-only Git inspection, and saved validation-command configuration. It does not yet invoke Claude or Codex for engineering work, create worktrees, run saved project commands, or implement task workflows.

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
- [ ] Shared process supervisor
- [ ] Claude adapter
- [ ] Codex adapter
- [ ] Streaming transport
- [ ] Cancellation
- [ ] Run persistence
- [ ] Dynamic capability/model discovery or editable fallback

Current record:

- Date: 2026-09-13
- Decisions: provider-specific CLI behavior remains inside adapters; unavailable actual model values are represented as `null`, never silently copied from the request.
- Modules introduced: `packages/agents`.
- Tests executed: interface package TypeScript check.
- Known limitations: interfaces only, by explicit scope. Claude Code is not installed/discoverable on the current `PATH`.

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

- [ ] Environment sanitization
- [ ] Sensitive path deny list
- [ ] Process cancellation and timeouts
- [ ] CLI failure handling
- [ ] Worktree conflict handling
- [ ] Database backups
- [ ] Cleanup tools
- [ ] Audit history

