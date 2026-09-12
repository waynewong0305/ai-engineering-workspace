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
- [x] Require an absolute, existing directory
- [x] Verify a Git working tree
- [x] Canonicalize the repository path
- [x] Detect current branch and local `origin/HEAD` default where available
- [x] Detect clean/dirty status
- [x] Suggest, but do not create, a sibling worktree root
- [x] Store project context and validation commands
- [x] Recheck Git status on demand
- [x] Test that registration leaves a temporary repository unchanged

Exit gate: a real repository can be registered and refreshed without writes to that repository. Do not register Boostorder automatically; the user chooses it in the UI.

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

- [ ] Task creation for brainstorm and architecture types
- [ ] Parallel independent analyses without cross-contamination
- [ ] Versioned prompts and structured-result parsing
- [ ] Raw-output retention
- [ ] Cross-review in both directions
- [ ] Comparison view: consensus, disagreements, questions, evidence, experiments
- [ ] Persistent assumption/evidence board
- [ ] Per-task web permission prompt and audit record

Exit gate: the database-sharding acceptance problem produces two independent analyses and a transparent comparison while both agents remain read-only.

## Phase 4 — Git worktree isolation

Goal: permit scoped modifications without touching the developer's active checkout.

- [ ] Worktree path and branch-name validation
- [ ] Create, inspect, diff, and list worktrees
- [ ] Worktree ownership and process-use tracking
- [ ] Dirty-worktree protection before removal
- [ ] Recoverable cleanup workflow with explicit human confirmation
- [ ] Temporary-repository integration tests

Exit gate: task-specific Claude and Codex worktrees can coexist and cleanup refuses to discard uncommitted work.

## Phase 5 — Build, validate, and review

Goal: run one builder and one independent reviewer through a bounded review loop.

- [ ] Builder/reviewer role selection independent of provider
- [ ] Worktree-scoped builder run
- [ ] Configured validation command execution and complete result capture
- [ ] Unified diff collection and viewer
- [ ] Read-only reviewer run
- [ ] Structured findings and builder responses
- [ ] Re-review with a hard maximum of three rounds
- [ ] Pre-PR report and `READY_FOR_HUMAN_REVIEW`

Exit gate: run the bug-fix acceptance workflow once in each provider direction. No push or PR creation is included.

## Phase 6 — Planning, evidence, and decisions

Goal: turn approved reasoning into traceable plans.

- [ ] Editable facts, assumptions, questions, decisions, and experiment results
- [ ] ADR creation and relationships
- [ ] Isolated experiment/POC workflow
- [ ] Promote decisions into implementation phases and linked tasks
- [ ] Optional ADR Markdown export with explicit approval

Exit gate: a brainstorm can create an ADR and a linked, reviewable implementation plan without modifying a target repository implicitly.

## Phase 7 — Hardening

Goal: make normal failure safe and understandable.

- [ ] Deny-list and environment-sanitization tests
- [ ] Process-tree cancellation and timeout tests
- [ ] CLI authentication-expiry handling
- [ ] Model-unavailable and substitution handling
- [ ] Worktree conflict recovery
- [ ] SQLite backup/restore and migration recovery
- [ ] Audit-history export
- [ ] Startup recovery for interrupted runs
- [ ] Accessibility and responsive UI audit

Exit gate: documented failure drills preserve source code, history, and user control.

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
