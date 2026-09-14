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

**Phase 8 Step 0 re-investigation (2026-09-13) found two more things, both fixed/used in that phase:**

- `--mcp-config "{}"` is now rejected by this same installed version ("Invalid MCP configuration:
  mcpServers: Invalid input") — it requires the full `'{"mcpServers":{}}'` shape even for "no
  servers". `ClaudeAdapter.ts` was passing the bare form; every real Claude run through this app was
  failing before reaching the model until this was fixed. A reminder that "re-verify before trusting
  a prior finding" applies to *already-shipped* invocation code, not only new phases.
- Claude Code reports exact, real-time subscription-plan usage percentages directly in its
  `--output-format stream-json` output (a `rate_limit_event` message) — confirmed live and wired
  into `UsageSafetyService`. A real `codex exec --json` completion confirmed that run stream still
  carries tokens but not plan percentages. Follow-up on 2026-09-14 found the documented Codex App
  Server `account/rateLimits/read` method, which returns current account windows without starting
  a model turn; that supported path is now wired into the same safety service as `APP_SERVER` /
  `EXACT`. See `IMPLEMENTATION_STATUS.md`'s Phase 8 completion records for the full detail.

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
- [x] Sensitive file-path deny list (separate from the environment-variable deny list above)
- [x] Process-tree cancellation and timeout tests
- [x] CLI authentication-expiry handling
- [x] Model-unavailable and substitution handling
- [x] Worktree conflict recovery
- [x] SQLite backup/restore and migration recovery
- [x] Audit-history export
- [x] Startup recovery for interrupted runs
- [ ] Supervised frontend verification runner (browser scenarios, console/network capture,
      accessibility, responsive screenshots, and optional approved-baseline comparison) —
      evaluated in detail 2026-09-13 (design, dependencies, and a scoped first slice all worked
      out against the user's real registered project) and deliberately deferred: it would only
      ever be manually triggered against an already-running instance the human looks at directly,
      so it wouldn't save meaningful effort over testing by eye today. Revisit if Claude/Codex
      builders start running with less direct human oversight. See `IMPLEMENTATION_STATUS.md`'s
      matching record for the full reasoning.
- [x] Separate just-in-time human approval, with a displayed reason and persisted scope, before any
      current or future model-backed agent reviews frontend UI/UX or receives browser evidence —
      `FrontendReviewApprovalService` and its routes (server-side only; the runner this gate
      protects, and the UI that will drive it, are not yet built, so nothing calls it yet)
- [ ] Token-efficient evidence selection: exception-only provider review, one-provider default,
      affected-region/failure-excerpt inputs, exact-revision artifact reuse, and separate approval
      before second-provider escalation or material scope expansion — governs the runner above and
      is deferred along with it
- [x] Accessibility and responsive UI audit of this workspace itself

Exit gate: documented failure drills preserve source code, history, and user control.

## Phase 8 — Usage, token, and cost monitoring (started 2026-09-13)

Goal: make Claude/Codex token usage, billing mode, and API-equivalent cost visible from workspace
level down to an individual run, without ever presenting an estimate as an exact figure.

Pulled forward by explicit human instruction on 2026-09-13 for its Step 0 re-verification; the
first slice (below) came out of what that investigation found. Full spec, data model, UI surfaces,
budget behavior, backfill rules, and testing/reporting requirements: `USAGE_MONITORING_SPEC.md`.
See `IMPLEMENTATION_STATUS.md`'s completion record for the full first-slice detail, including a
real, pre-existing `ClaudeAdapter` bug this investigation found and fixed along the way, and a
confirmed `codex exec --json` does not report plan-usage percentages, followed by a supported
Codex App Server integration that fills that gap without changing the run invocation path.

- [x] Re-verify installed Claude/Codex CLI usage telemetry and historical-data recoverability —
      found Claude reports exact, real-time plan-usage percentages in its own output, not just
      per-run tokens; folded a real-time usage-safety upgrade into this phase as a result (by
      explicit human instruction, since it wasn't part of the original Phase 8 scope). Confirmed
      Codex's `exec --json` invocation path does not expose the equivalent; the documented App
      Server `account/rateLimits/read` path now supplies it on demand — see above.
- [x] `UsageRecord` data model and migration, linked to run/task/project — exact token counts plus
      immutable API-equivalent cost snapshots when a matching pricing version exists
- [x] Centralized, versioned pricing registry and auditable API-equivalent cost calculation —
      append-only pricing versions, exact token × rate category breakdown, and no partial total
      when a required category or model price is unavailable
- [ ] Workspace/project/task/run usage dashboard and drill-down UI, each value labeled with its
      usage-source reliability (`EXACT`/`CALCULATED`/`ESTIMATED`/`UNAVAILABLE`)
- [ ] Cross-review cost breakdown by role/workflow
- [ ] Task usage budgets (presets + custom) integrated with the existing max-review-round cap
- [x] Historical backfill from recoverable provider-reported data only, with a backfill report
- [ ] Usage & Cost settings

Exit gate (unmet, tracks the remaining unchecked items above): small real Claude and Codex runs now
both produce usage records with correctly labeled billing mode and usage-source reliability. The
dashboard still does not exist, and API-equivalent figures remain unavailable until the append-only
registry contains a verified price for the exact model ID; no vendor prices were guessed or silently
seeded.

## End-to-end workflow verification (cross-cutting, added 2026-09-13)

Not one of the phases above: a single integration test (`apps/server/src/routes/end-to-end-workflow.test.ts`) that drives every currently-implemented phase together through the app's own HTTP API, in the order a real user would — registration, health, brainstorm draft, the usage-safety acknowledgement gate, independent analysis, cross-review, comparison/evidence, worktree creation, isolation, a build/review round, an ADR, an isolated experiment, ADR promotion, the deregistration-vs-linked-worktrees guard, and cleanup — using a temporary repository and fake adapters, spending no real provider usage. See `IMPLEMENTATION_STATUS.md` for the full record.

Exit gate: met. The test now also covers the Phase 5 build/review loop and the Phase 6
planning/ADR/experiment/promotion flow in the same continuous run, closing the Phase 7
cross-phase-verification hardening item.

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
