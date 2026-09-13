# Agent Policy — AI Engineering Workspace

This file is the single canonical policy for any LLM coding agent (Claude Code, Codex, or another
tool) working in this repository. `CLAUDE.md` is a relative symbolic link to this file — the two
must always contain identical bytes. Never edit `CLAUDE.md` directly and never turn it back into a
regular file; edit `AGENTS.md` and the symlink carries the change automatically. Run
`npm run check:agent-policy` if you are ever unsure the link is intact.

## Product purpose

AI Engineering Workspace is a **local-only** application that orchestrates Claude Code and OpenAI
Codex as **independent** engineers against local Git repositories — brainstorm, cross-review,
compare, isolate work in Git worktrees, build, review, and produce a pre-PR report — while keeping
final authority with a human. It is not a chat UI, and it does not build cloud infrastructure,
authentication, or multi-user support. See `PROJECT_SPEC.md` for the full product specification.

## Current implementation stage

Do not trust a memory of "where the project is" — it changes every phase. The authoritative,
up-to-date record is **`IMPLEMENTATION_STATUS.md`**. Read it first. As of the phase it last
recorded: project registration, agent adapters, independent brainstorming, Git worktree isolation,
and a cross-cutting Claude/Codex usage-safety system are implemented; build/review workflows inside
worktrees (Phase 5) and planning/ADRs (Phase 6) are not yet implemented. Usage, token, and cost
monitoring (Phase 8, spec in `USAGE_MONITORING_SPEC.md`) is queued behind Phases 5–7 — do not start
it early without an explicit human instruction.

## Source-of-truth specifications

- `PROJECT_SPEC.md` — the product requirements. Read this before changing product behavior.
- `IMPLEMENTATION_ROADMAP.md` — how the spec was broken into phases, environment findings, and
  architecture guardrails.
- `IMPLEMENTATION_STATUS.md` — what is actually done, current known limitations, and completion
  records. This is the file to update after every change of consequence; do not duplicate its
  content elsewhere, link to it instead.
- `DEVELOPER_GUIDE.md` — internals: architecture, schema, services, routes.
- `USER_GUIDE.md` — user-facing behavior and workflows.

## Repository and package map

```text
apps/
  web/       Vue 3 + Vite frontend (untrusted client; no Git/process/secret handling here)
  server/    Fastify API, SQLite/Drizzle schema + migrations, routes, services
packages/
  agents/    provider-neutral AgentAdapter contracts, Claude/Codex CLI adapters, process supervisor
  git/       WorktreeService: worktree naming, validation, Git subprocess helpers
  shared/    shared types with no platform dependencies
prompts/     versioned analysis/cross-review prompt files (never hardcode prompts inline)
data/        ignored local SQLite database (never commit, never delete as a first troubleshooting step)
scripts/     local dev launcher (scripts/dev.mjs) and this policy checker (scripts/check-agent-policy.mjs)
docs/decisions/  lightweight architecture decision records
```

## Important entry points and execution flows

- `apps/server/src/app.ts` — composition root: builds the Fastify app, wires `UsageSafetyService`,
  `AgentRunManager`, `WorktreeService`, and registers every route module. Start here to see how
  everything connects.
- `apps/server/src/routes/*.ts` — HTTP surface: `projects.ts`, `agent-runs.ts`, `tasks.ts`
  (brainstorm workflow), `worktrees.ts`, `usage-safety.ts`.
- `apps/server/src/services/brainstorm-workflow.ts` — the independent-analysis →
  cross-review state machine; the reference implementation for adding another multi-stage workflow.
- `apps/server/src/services/usage-safety.ts` — the provider-usage safety gate (see below).
- `packages/git/src/WorktreeService.ts` — all worktree-mutating Git behavior.
- `apps/web/src/App.vue` — the entire frontend UI (single-file; sections are numbered and
  correspond to the sidebar nav).

## Required runtime

- Node.js **22 or newer** (`.nvmrc` pins the tested version). `npm run dev` and every command below
  assume Node 22 is first on `PATH` — run `nvm use` if you use nvm. Do not upgrade or downgrade this
  contract without updating `.nvmrc`, `package.json` `engines`, and this file together.
- npm workspaces (`apps/*`, `packages/*`); do not add a second package manager.

## Installation and development

```bash
npm install
npm run dev          # Fastify on 127.0.0.1:4310, Vite on 127.0.0.1:5173, proxied under /api
```

## Database and migration workflow

- Schema: `apps/server/src/db/schema.ts` (Drizzle ORM, SQLite). Generated SQL + snapshots live in
  `apps/server/drizzle/`.
- After changing `schema.ts`, run `npm run db:generate` and commit the generated migration files.
  Adding a value to a `text(..., { enum: [...] })` column does **not** require a migration — Drizzle
  enums are TypeScript-level only, not a database `CHECK` constraint — but `db:generate` should
  still report "No schema changes" in that case; if it doesn't, investigate before committing.
- `npm run db:migrate` applies pending migrations to the local database at `data/workspace.sqlite`
  (ignored by Git). The server also applies pending migrations on startup. Never delete `data/` to
  "fix" a migration error; preserve it and inspect the error first.

## Verification commands

Run all of these — and fix whatever they find — before every commit that touches code:

```bash
npm test                      # runs check:agent-policy first (see package.json pretest), then all workspace tests
npm run typecheck              # tsc / vue-tsc across every workspace
npm run build                  # production build of apps/server and apps/web
npm run check:agent-policy     # verifies AGENTS.md/CLAUDE.md stay a canonical file + symlink pair
npm run db:generate            # confirms no undeclared schema drift
git diff --check               # whitespace-error check
```

Automated tests must never require network access, provider authentication, or spend model
credits: use fake `AgentAdapter` implementations and temporary Git repositories (below).

## Git worktree isolation and ownership

- All worktree-mutating Git logic lives in `packages/git`'s `WorktreeService`; never call `git
  worktree` directly from a route or another service.
- A worktree's path and branch are generated independently
  (`<worktreeRoot>/TASK-<id>-<slug>/<role>`, `ai/TASK-<id>/<slug>/<role>`) and remain independently
  editable and renameable — moving the directory never renames the branch and vice versa.
- Every mutating operation validates: absolute path, canonical target inside the configured
  worktree root and outside the source repository, a valid branch ref (`check-ref-format`), a
  resolvable base ref, and collisions against Git's own worktree list *and* the `worktrees` table's
  unique `(taskId, provider)` and `(projectId, branchName)` indexes.
- `move`, `renameBranch`, and `remove` share an `assertSafeToMutate` guard: refuse a locked,
  prunable, dirty, or in-use worktree. Ownership/usage leases (`worktree_usages`) track which
  run/validation/system process holds a worktree; a lease older than 6 hours (configurable) is
  flagged stale and can be released only by an explicit human action, never automatically.
- Creation never switches, checks out, or modifies the developer's active repository checkout.

## Worktree cleanup and branch deletion

- Removal always requires an explicit `{ confirm: true }`; a dirty, locked, prunable, or in-use
  worktree is refused, never silently forced.
- If Git no longer registers a worktree at all (an interrupted `CREATING` record, a failed
  creation, or a worktree removed outside the app), removal recognizes this and "forgets" the
  orphaned database record instead of throwing — this is the *only* case a managed record is
  deleted without a live worktree behind it. A real, non-clean worktree is never discarded this way.
- Branch deletion is a separate, explicit `deleteBranch` option and only ever succeeds after Git
  confirms (`merge-base --is-ancestor`) the branch is merged into its base ref. An unmerged branch
  is never deleted, even when its worktree is otherwise being cleaned up.
- Project deregistration does **not** yet check for linked managed worktrees — a known gap, tracked
  in `IMPLEMENTATION_STATUS.md`. Do not silently "fix" this without reading that record first; it
  may already describe the intended design for when it is picked up.

## Claude and Codex usage-safety policy

`apps/server/src/services/usage-safety.ts` (`UsageSafetyService`) is the **only** place usage
safety is decided; do not add a second one.

- Before **every** provider-consuming operation, check that provider's usage. A single-provider
  action (e.g. the read-only repository explanation) checks only its own provider
  (`combined: false`); a multi-provider/multi-stage workflow (the brainstorm workflow) checks both
  together before each phase starts, and again immediately before each of its individual provider
  calls (`combined: true`) — recheck before every later call, not only once at workflow start, and
  explicitly recheck before the independent-analysis → cross-review transition.
- Status is one of `SAFE` / `WARNING` / `CHECKPOINT_REQUIRED` / `EXHAUSTED` / `UNAVAILABLE` /
  `STALE`, derived from configurable thresholds — never fabricate a percentage when a reading is
  missing or stale.
- `EXHAUSTED` blocks unconditionally; there is no override while the exhausted status is current.
- `CHECKPOINT_REQUIRED` blocks until either a fresh reading drops below the threshold or an
  explicit human `OVERRIDE` acknowledgement tied to that exact reading is recorded.
- `UNAVAILABLE`/`STALE` usage is never treated as safe. A single-provider action may proceed; a
  combined/multi-stage workflow defaults to requiring an explicit human `PROCEED` acknowledgement.
  Every acknowledgement is persisted with provider, reading, user action, and timestamp
  (`usage_safety_audit`) and expires after `acknowledgementTtlMs` (default 15 minutes).
- On a block, a combined workflow **checkpoints** (`tasks.status = "CHECKPOINTED"`) rather than
  failing: everything already completed stays persisted, and resuming re-uses it rather than
  re-running it. Never lose completed analysis when pausing between stages.
- Never automatically redeem provider reset credits, automatically start a replacement provider,
  or automatically downgrade a requested model — all three require an explicit human decision.
- There is no supported local CLI/API surface that reports exact Claude Code or Codex usage
  percentages today. Do not add one by probing the CLIs further or calling an undocumented remote
  endpoint. The only real data sources are an explicit human-entered manual snapshot (always
  labeled `MANUAL`/estimated) and a heuristic parse of a provider process's own rate-limit refusal
  text (`parseRateLimitMessage`) — treat the latter as a best-effort signal, not a certainty.

## Web access and permission boundaries

- Permission profiles: `READ_ONLY` (inspection, brainstorming, review), `WORKTREE_WRITE` (changes
  only inside an assigned task worktree), `TEST_ONLY` (configured validation commands). The process
  supervisor enforces these, not just labels them.
- Web access defaults to disabled; a task's resolved decision (`DISABLED` / `ENABLED_FOR_TASK`) is
  recorded once and copied to every run it produces. Never infer or silently enable web access.
- Environment sanitization uses an allowlist; never pass through cloud/database credentials or log
  environment values. `.env`, `.env.*`, private keys, and cloud credential directories are never
  read automatically.

## Prohibited automatic actions

Never automate, in code or in your own actions while working in this repository: `git push`,
`git push --force`, `git reset --hard`, destructive branch deletion outside the merged-branch-only
flow above, production deployment, production migration, redeeming provider reset credits,
starting a replacement provider automatically, or silently downgrading a model.

## Temporary-repository requirement for Git integration tests

Every test that exercises Git or worktree behavior must create its own temporary repository (see
the `createRepository`/`createTestRepository` helpers in `packages/git/src/WorktreeService.test.ts`
and `apps/server/src/routes/worktrees.test.ts`) and use fake `AgentAdapter` implementations for
provider calls. Never point a test at a real registered repository, and never let a test spend
provider usage.

## Preserving unrelated changes

Before changing anything, run `git status --short` and `git log --oneline -8`. If you find
uncommitted or unfamiliar changes that are not part of your task, leave them alone — do not stash,
reset, or discard them without being asked. Keep your own changes scoped to the task you were given;
do not fold in unrelated cleanup.

## File-editing conventions

- Prefer editing existing files over creating new ones; only add a new module when the phase
  boundary genuinely introduces new responsibility (see `DEVELOPER_GUIDE.md`'s package map notes).
- No comments that restate what code does; a comment is only worth adding for a non-obvious
  invariant, a subtle constraint, or a workaround (see examples throughout `usage-safety.ts` and
  `WorktreeService.ts`).
- Keep `packages/agents` provider-neutral: workflow code must never branch on
  `provider === "CLAUDE"` outside an adapter; add capability through the `AgentAdapter` interface.

## Required verification before committing

Run the full verification command list above. Do not claim a test, type-check, or build passed
without having actually run it in this session. If a command fails, fix the root cause rather than
skipping or weakening the check (no `--no-verify`, no deleting a failing test).

## Phase-by-phase commit policy

Keep each phase's (or, for a cross-cutting change, each coherent unit's) changes in its own commit;
do not bundle unrelated phases together. After each phase: run the full verification list, update
`IMPLEMENTATION_STATUS.md` with what changed and what was verified, update `USER_GUIDE.md` for any
user-visible behavior change, and update `DEVELOPER_GUIDE.md`/ADRs only for architectural decisions.
Never amend a commit that already exists when asked to continue work — make a new commit.

## Handling dirty worktrees

If the developer's active checkout (not a managed task worktree) is dirty when you start, do not
clean, stash, reset, or commit on their behalf without being asked — dirty status does not block
registration or read-only work, but no destructive Git command should run against it automatically.
For a *managed* task worktree, dirty/locked/prunable/in-use state must block move/rename/remove
(see above); never bypass that from application code.

## Reporting blockers and limitations

State what you could not do and why, explicitly — do not paper over a limitation with a fabricated
success. Known, already-accepted limitations live in `IMPLEMENTATION_STATUS.md`; check there before
re-reporting one as new. When you hit a genuinely new limitation, record it there rather than only
mentioning it in a commit message or chat response, so the next agent does not rediscover it blind.

## Continuation checklist for the next agent

1. Read `IMPLEMENTATION_STATUS.md` for current state, then `git log --oneline -8` and
   `git status --short`.
2. Run `nvm use` (or otherwise put Node 22 first on `PATH`), then `npm install`.
3. Run the full verification list above once, before changing anything, to confirm a clean
   baseline.
4. Consult `PROJECT_SPEC.md` and `IMPLEMENTATION_ROADMAP.md` for the next undone phase item.
5. Make the smallest coherent change for one phase/unit of work; add or update tests alongside it
   using fake adapters and temporary repositories.
6. Re-run the full verification list; update `IMPLEMENTATION_STATUS.md` and `USER_GUIDE.md`.
7. Commit that unit of work on its own; do not amend prior commits.
