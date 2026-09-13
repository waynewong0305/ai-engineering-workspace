# Implementation Roadmap

This roadmap turns `PROJECT_SPEC.md` into small, testable increments. Safety, provider independence, auditability, and human control are release gates—not later polish.

## Environment baseline — 2026-09-13

| Component | Observed state | Impact |
| --- | --- | --- |
| macOS | 26.5.2, arm64 | Supported first platform |
| Shell | zsh 5.9 | Supported |
| Node.js on shell `PATH` | 16.20.2 | Too old for this project's supported toolchain |
| Other user-installed Node versions | 22.23.2 under nvm | Run `nvm use` before development |
| Phase 2 validation runtime | Node 22.23.2 under nvm | Matches the declared runtime contract |
| npm | 8.19.4 | Workspaces supported |
| Git | 2.50.1 (Apple Git-155) | Available |
| Claude Code | 2.1.269 installed and authenticated | Ready for an explicit read-only run |
| Codex CLI | 0.153.4 | Available |
| Codex authentication | Logged in using ChatGPT | Available for a later explicit agent-run test |
| Codex default model | `gpt-5.6-sol` reported by the redacted doctor report | Informational only; not hardcoded into the product |
| Workspace Git repository | Not initialized at discovery time | Initialize locally before making project commits |
| Free disk | Approximately 267 GiB | Sufficient for the MVP and isolated worktrees |

No browser or internet research was used. The Codex diagnostic attempted its own connectivity checks and reported provider endpoints unreachable from the restricted execution environment; this does not invalidate the locally stored authentication state.

## Local CLI capability findings

The installed Codex CLI exposes a suitable non-interactive foundation:

- `codex exec` accepts a working directory, model override, sandbox mode, approval policy, timeout ownership by the parent process, JSONL event output, and a JSON output schema.
- `codex review` can review uncommitted changes, a base branch, or a commit.
- `codex login status` reports authentication without exposing credentials.
- `codex doctor --json` provides a redacted health report and current default model.
- The inspected top-level help does not expose an authoritative model-list command. Phase 2 must investigate a supported local protocol before falling back to editable model IDs.

Claude Code 2.1.269 exposes non-interactive `--print`, `stream-json`, restricted mode, explicit tool selection, permission modes, effort controls, and session resume. `claude auth status` reports an authenticated local session; credentials remain outside the application database.

## Architecture guardrails

1. The browser UI never invokes Git or an AI CLI directly; the Fastify server owns those processes.
2. Workflow code depends on `AgentAdapter`, not provider names.
3. Repository registration is read-only. Worktree creation is a separate, later, explicit operation.
4. User-entered commands are stored as data during registration and are never executed at that point.
5. Agent processes use argument arrays, bounded output buffers, timeouts, cancellation, explicit working directories, and a sanitized environment.
6. Raw CLI output and structured results are stored separately. Hidden reasoning is never requested or stored.
7. Web permission defaults to `ASK_BEFORE_USE`; every run stores the resolved permission decision.
8. Requested and actual models are recorded separately. A fallback or substitution may never be silent.
9. No push, destructive Git operation, deployment, or production access is automated.
10. Automated tests use fake adapters and temporary repositories; they do not spend model credits.

## Phase 0 — Bootstrap

Goal: prove the local application stack and persistence loop.

- [x] npm workspaces and a Node 22+ runtime contract
- [x] Vue 3, TypeScript, and Vite frontend
- [x] Fastify and TypeScript backend
- [x] SQLite database opened locally
- [x] Drizzle schema and migration
- [x] Basic navigation and local-first application shell
- [x] Server health endpoint
- [x] Combined development launcher and clean signal forwarding
- [x] Type check, tests, production build, and live endpoint verification

Exit gate: `npm run dev` serves the client and API on localhost with a connected SQLite database. Completed using Node 24.19.0; the user's default Node 16 remains a documented prerequisite issue.

## Phase 1 — Project registration

Goal: register a repository without changing it.

- [x] Add and list projects
- [x] Edit registered project metadata, repository path, worktree root, context, and validation commands
- [x] Confirm and safely deregister projects without deleting repository files
- [x] Refuse deregistration while a project has an active agent run
- [x] Require an absolute, existing directory
- [x] Verify a Git working tree
- [x] Canonicalize the repository path
- [x] Detect current branch and local `origin/HEAD` default where available
- [x] Detect clean/dirty status
- [x] Suggest, but do not create, a sibling worktree root
- [x] Store project context and validation commands
- [x] Recheck Git status on demand
- [x] Test that registration leaves a temporary repository unchanged

Exit gate: a real repository can be registered, edited, refreshed, and deregistered without writes to or deletion of that repository. Do not register Boostorder automatically; the user chooses it in the UI.

## Phase 2 — Agent adapters

Goal: establish safe, observable CLI process adapters.

- [x] Provider-neutral `AgentAdapter` interface
- [x] Run input, event, health, model, permission, and web-access types
- [x] Authenticate Claude Code outside the application
- [x] Inspect current Claude CLI version and complete help output
- [x] Determine supported local model discovery for each CLI
- [x] Implement a shared process supervisor
- [x] Implement environment sanitization and sensitive-variable deny list first
- [x] Implement `ClaudeAdapter`
- [x] Implement `CodexAdapter`
- [x] Stream events over SSE
- [x] Persist prompts, versions, output, exit state, duration, CLI version, and model metadata
- [x] Implement cancellation and timeouts
- [x] Add a read-only, explicit single-agent health/run screen

Exit gate: the full path passes with a fake adapter without spending model credits. Both providers are authenticated; live provider acceptance remains a deliberate user action.

## Phase 3 — Independent brainstorming

Goal: preserve independent analysis and make disagreement useful.

- [x] Task creation for brainstorm and architecture types
- [x] Parallel independent analyses without cross-contamination
- [x] Versioned prompts and structured-result parsing
- [x] Raw-output retention
- [x] Cross-review in both directions
- [x] Comparison view: consensus, disagreements, questions, evidence, experiments
- [x] Persistent assumption/evidence board
- [x] Per-task web permission prompt and audit record

Exit gate: the database-sharding acceptance draft is created with web disabled. Fake-provider acceptance passes; the real four-provider-run acceptance remains a deliberate user action because it spends provider usage.

## Phase 4 — Git worktree isolation

Goal: permit scoped modifications without touching the developer's active checkout.

- [x] Meaningful worktree paths and branch names generated from task ID, task-title slug, and agent role
- [x] Editable generated names before creation, with path/ref validation and collision handling
- [x] Safe existing-worktree rename using Git worktree move, with persisted-path updates only after success
- [x] Keep worktree directory names and branch names independently manageable
- [x] Create, inspect, diff, and list worktrees
- [x] Worktree ownership and process-use tracking, including stale-lease detection and explicit release
- [x] Refuse project deregistration until its managed worktrees are safely cleaned up
- [x] Dirty/locked/prunable-worktree protection before removal
- [x] Recoverable cleanup workflow with explicit human confirmation, including recovery from an interrupted or failed creation
- [x] Temporary-repository integration tests

Exit gate: task-specific Claude and Codex worktrees can coexist, generated names are editable and renameable without silently renaming branches, and cleanup refuses to discard uncommitted or in-use work. Met — including deregistration refusing to proceed while managed worktrees remain linked.

## Provider usage safety (cross-cutting, added 2026-09-13)

Not one of the phases above: a safety requirement that must guard every phase's provider-consuming actions. See `IMPLEMENTATION_STATUS.md` for the full completion record.

- [x] Provider-neutral usage data model, thresholds, and status computation
- [x] Manual snapshot and rate-limit-error data sources (no automatic CLI-based source exists today)
- [x] Preflight checks wired into the single read-only agent run and the combined brainstorm workflow, rechecked before every provider call
- [x] Checkpoint/resume workflow state (`CHECKPOINTED`) that preserves completed work and requires acknowledgement or a fresh reading to continue
- [x] Usage API and UI, including a pre-action warning and manual-snapshot controls

Exit gate: met. A provider-consuming action cannot start while its provider is reliably exhausted or at the checkpoint threshold without an explicit override, and unknown usage in a combined workflow requires acknowledgement rather than being silently treated as safe.

## Phase 5 — Build, validate, and review

Goal: run one builder and one independent reviewer through a bounded review loop.

- [x] Builder/reviewer role selection independent of provider
- [x] Worktree-scoped builder run
- [x] Configured validation command execution and complete result capture
- [x] Unified diff collection and viewer
- [x] Read-only reviewer run
- [x] Structured findings and builder responses
- [x] Re-review with a hard maximum of three rounds
- [x] Explicit human-approved merge into the selected target branch
- [x] Post-merge validation before cleanup
- [x] Guarded automatic worktree removal after successful merge and validation
- [x] `Keep worktree after merge` override
- [x] Separate opt-in policy for deleting a merged task branch
- [x] Pre-PR report and `READY_FOR_HUMAN_REVIEW`

Exit gate: implementation complete. Temporary-repository tests with fake adapters prove the bounded
review loop, explicit human-approved merge, post-merge validation, cleanup overrides, branch policy,
and preservation on conflicts or failed validation without spending provider usage. A real run in
each provider direction remains an explicit human acceptance action. No push or PR creation is
included.

## Phase 6 — Planning, evidence, and decisions

Goal: turn approved reasoning into traceable plans.

- [x] Editable facts, assumptions, questions, decisions, and experiment results
- [x] ADR creation and relationships
- [x] Isolated experiment/POC workflow
- [x] Promote decisions into implementation phases and linked tasks
- Optional follow-up, not required by the Phase 6 exit gate: ADR Markdown export with explicit
  approval. ADRs currently remain in the local application database.

Exit gate: met. A brainstorm can create an ADR, record experiment evidence, and promote the decision
into linked, reviewable implementation tasks without modifying a target repository implicitly.

## Phase 7 — Hardening

Goal: make normal failure safe and understandable.

- [x] Deny-list and environment-sanitization tests
- [x] Process-tree cancellation and timeout tests
- [x] CLI authentication-expiry handling
- [x] Model-unavailable and substitution handling
- [ ] Worktree conflict recovery
- [ ] SQLite backup/restore and migration recovery
- [ ] Audit-history export
- [ ] Startup recovery for interrupted runs
- [ ] Accessibility and responsive UI audit

Exit gate: documented failure drills preserve source code, history, and user control.

## Phase 8 — Usage, token, and cost monitoring (queued, added 2026-09-13)

Goal: make Claude/Codex token usage, billing mode, and API-equivalent cost visible from workspace
level down to an individual run, without ever presenting an estimate as an exact figure.

Queued behind Phase 7: Phases 5 and 6 are complete, but do not start Phase 8 until hardening is
complete unless explicitly pulled forward by the user.
Full spec, data model, UI surfaces, budget behavior, backfill rules, and testing/reporting
requirements: `USAGE_MONITORING_SPEC.md`. Re-investigate installed Claude/Codex CLI capabilities at
execution time — do not assume this roadmap's or that spec's CLI findings still hold.

- [ ] Re-verify installed Claude/Codex CLI usage telemetry and historical-data recoverability
- [ ] `UsageRecord` data model and migration, linked to run/task/project
- [ ] Centralized, versioned pricing registry and auditable API-equivalent cost calculation
- [ ] Workspace/project/task/run usage dashboard and drill-down UI, each value labeled with its
      usage-source reliability (`EXACT`/`CALCULATED`/`ESTIMATED`/`UNAVAILABLE`)
- [ ] Cross-review cost breakdown by role/workflow
- [ ] Task usage budgets (presets + custom) integrated with the existing max-review-round cap
- [ ] Historical backfill from recoverable provider-reported data only, with a backfill report
- [ ] Usage & Cost settings

Exit gate: a small real Claude run and a small real Codex run each produce a usage record with
correctly labeled billing mode and usage-source reliability, the dashboard reflects both, and no
historical or current value is fabricated.

## End-to-end workflow verification (cross-cutting, added 2026-09-13)

Not one of the phases above: a single integration test (`apps/server/src/routes/end-to-end-workflow.test.ts`) that drives every currently-implemented phase together through the app's own HTTP API, in the order a real user would — registration, health, brainstorm draft, the usage-safety acknowledgement gate, independent analysis, cross-review, comparison/evidence, worktree creation, isolation, the deregistration-vs-linked-worktrees guard, and cleanup — using a temporary repository and fake adapters, spending no real provider usage. See `IMPLEMENTATION_STATUS.md` for the full record.

Exit gate: met through Phase 4. Phases 5 and 6 are complete but are covered by their own route and
service integration tests rather than this single cross-phase test. Extend this same test (not a
second one) during Phase 7 hardening to include the build/review and planning/ADR flows.

## Phase completion protocol

At the end of every phase:

1. Run unit and integration tests.
2. Run TypeScript type checking.
3. Run a production build.
4. Exercise the user-facing happy path locally.
5. Confirm no out-of-scope repository was modified.
6. Update `IMPLEMENTATION_STATUS.md` and `USER_GUIDE.md`.
7. Update `DEVELOPER_GUIDE.md` and ADRs only when architecture changes.
8. Report failures and limitations honestly.
9. Stop before the next major phase.
