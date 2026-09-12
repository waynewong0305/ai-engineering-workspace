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
  shared/    shared types with no platform dependencies
prompts/     planned versioned prompt files
data/        ignored local SQLite database
docs/
  decisions/ lightweight architecture decision records
scripts/     local development process launcher
```

`packages/core` and `packages/git` should be introduced when workflow and worktree responsibilities become concrete. The Phase 1 repository inspector currently lives in the server because it is a small read-only integration; move stable Git/worktree logic into `packages/git` during Phase 4 rather than inventing an empty abstraction now.

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

The initial SQLite schema contains `projects`:

- `id`: UUID string primary key;
- `name`;
- unique canonical `repository_path`;
- `default_branch` and `current_branch`;
- `worktree_root`;
- optional `project_context`;
- JSON `validation_commands`;
- `git_status` (`CLEAN` or `DIRTY`); and
- ISO timestamps.

Drizzle schema is in `apps/server/src/db/schema.ts`; generated SQL and migration metadata are in `apps/server/drizzle/`. The runtime applies pending migrations when the server opens the database. WAL and foreign-key enforcement are enabled.

Future normalized tables should include tasks, agent runs/events, prompts/versions, evidence items, cross-reviews, ADRs, plans, worktrees, validation runs, review findings/responses, and audit events. Introduce them with the phase that owns their behavior; do not create speculative tables early.

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

Do not use `danger-full-access` or bypass flags as normal product features. Claude capabilities are intentionally undecided until the CLI is installed and inspected.

## Model discovery and configuration

Implement capability probing behind adapters. A provider capability response should return:

- installed and authenticated state;
- CLI version;
- available model IDs when the CLI has an authoritative listing;
- available effort/reasoning settings;
- structured-output and session-resume support; and
- whether model discovery is dynamic or editable fallback.

Settings resolution order is role override, task override, project default, global default. Store the resolved request before launch. After completion, store the actual model only when provider output supplies it. `null` means unknown; it must not be filled by copying the requested value.

## Workflow engine — planned

The workflow engine belongs in `packages/core`. It should consume domain commands and emit persisted state transitions. Suggested states from the specification are `DRAFT`, `BRAINSTORMING`, `AWAITING_COMPARISON`, `PLANNING`, `READY_TO_BUILD`, `BUILDING`, `VALIDATING`, `REVIEWING`, `CHANGES_REQUESTED`, `READY_FOR_HUMAN_REVIEW`, `DONE`, and `FAILED`.

Transitions must be explicit and tested. Refreshing the browser must reconstruct state from SQLite. Long-running work is represented by run records and events, not in-memory UI state. Cancellation is a terminal run result distinct from failure.

Independent brainstorm branches must be scheduled from the same user problem without exposing one provider's output to the other. Cross-review begins only after both original analyses are durably stored.

## Git and worktree layer

The current inspector uses `execFile` with an argument array and a timeout. It never interpolates a repository path into a shell command. Registration uses only read commands:

- `rev-parse --is-inside-work-tree`;
- `branch --show-current`;
- `symbolic-ref --short refs/remotes/origin/HEAD`; and
- `status --porcelain=v1`.

Phase 4 should move Git behavior into `packages/git` and add a `WorktreeService`. Every mutating method must validate canonical source path, default branch/ref, generated task branch, target root, ownership, and collisions. Cleanup must inspect tracked, staged, unstaged, and untracked changes and refuse implicit loss.

Git push, force push, hard reset, branch deletion, deployment, and production migration are outside the automated workflow.

## Security model

Three permission profiles define intent:

- `READ_ONLY`: repository inspection, brainstorming, architecture, investigation, and review;
- `WORKTREE_WRITE`: changes only inside an assigned task worktree; and
- `TEST_ONLY`: configured validation under a controlled working directory.

The process supervisor must enforce—not merely label—these profiles. Build it before live adapters.

Environment sanitization should start from a minimal allowlist needed for executable discovery, locale, temporary files, and legitimate CLI authentication. Explicitly deny common cloud/database credentials and never log environment values. Authentication files remain owned by each CLI and are never copied into SQLite.

Sensitive path rules should reject automatic reads of `.env`, `.env.*`, private keys, cloud credential directories, macOS Keychain data, and configured user additions. A future run requesting those paths must pause for explicit human action rather than weakening the profile.

## Web permission model

Persist a task policy (`DISABLED`, `ASK_BEFORE_USE`, or `ENABLED_FOR_TASK`) and a resolved run decision. `ASK_BEFORE_USE` starts unresolved. A run that actually requires browsing must pause before launching with web flags, obtain a user decision, and then record who decided and when.

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

The current Phase 1 integration test creates a temporary Git repository, registers it through the Fastify route, and verifies the repository remains clean.

## Change protocol

For every phase:

- keep the change within the declared phase boundary;
- generate and inspect database migrations;
- run tests, type checks, and a production build;
- exercise the user-visible flow locally;
- update `IMPLEMENTATION_STATUS.md`;
- update `USER_GUIDE.md` for behavior changes; and
- add or revise ADRs only for consequential decisions.
