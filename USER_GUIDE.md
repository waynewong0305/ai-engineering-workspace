# AI Engineering Workspace User Guide

AI Engineering Workspace is a local control room for using Claude Code and Codex as independent engineering collaborators. It is designed to keep decisions, evidence, code changes, reviews, and test results traceable while leaving final authority with you.

## What works today

The current implementation can:

- start a local Vue and Fastify application;
- report whether Git, Claude Code, and Codex are available;
- report Codex's local authentication status;
- register a local Git repository without modifying it;
- edit a registered project's path, name, branches, worktree root, context, and validation commands;
- deregister a project after confirmation without deleting its Git repository;
- detect the current/default branch and clean/dirty status;
- save a future worktree location, project context, and validation commands; and
- recheck a registered repository's Git status;
- run an explicit, read-only repository explanation with Claude Code or Codex;
- stream the visible answer and process messages;
- cancel an active run; and
- retain run output and audit metadata locally;
- create brainstorm and architecture task drafts with an explicit per-task web decision;
- run Claude and Codex analyses independently, then cross-review in both directions;
- retain structured and raw responses and compare consensus, disagreements, questions, missing evidence, and experiments; and
- add or correct facts, assumptions, questions, decisions, and experiment results on a persistent evidence board;
- preview, edit, and create isolated Claude and Codex worktrees per task, without ever switching or modifying the active project checkout;
- inspect, move, rename, diff, and safely clean up managed worktrees, including recovering a record left behind by an interrupted or failed creation; and
- check Claude and Codex usage safety before any provider-consuming action, checkpoint a workflow at a configurable threshold without losing completed work, and record a manual usage snapshot or an explicit acknowledgement.

Implementation/review loops, ADRs, and reports are planned but not enabled yet. Brainstorming, architecture comparison, and worktree isolation are available now.

## Installation

### Prerequisites

You need:

- macOS on Apple silicon for the currently tested setup;
- Git;
- Node.js 22 or newer;
- npm;
- Claude Code for Claude workflows; and
- Codex CLI for Codex workflows.

The project includes `.nvmrc`. If you use nvm, run:

```bash
nvm install
nvm use
node --version
```

The Node version should begin with `v22` or a newer supported major. The environment inspected on 2026-09-13 defaulted to Node 16.20.2, which is too old. This project did not change that installation automatically.

### Claude Code setup

Install Claude Code using Anthropic's supported local installation process, then authenticate by running Claude Code yourself. Confirm the CLI is available:

```bash
claude --version
claude --help
```

AI Engineering Workspace will never ask for your Claude password or copy authentication tokens into its database. If Claude reports that authentication is required, complete authentication in your own terminal and use **Recheck tools** in the application.

The inspected environment has Claude Code 2.1.269 and supports restricted read-only runs, structured streaming output, model selection, and effort levels. Availability and authentication are still checked locally each time.

### Codex setup

Install and authenticate Codex through its supported local flow. Confirm it is ready:

```bash
codex --version
codex login status
codex --help
```

The inspected environment has Codex CLI 0.153.4 and is logged in using ChatGPT. The application does not read or store the underlying credentials.

### Install the application

From the AI Engineering Workspace directory:

```bash
nvm use
npm install
npm run db:migrate
```

The database is stored locally under `data/` and is ignored by Git.

### Start the application

Run:

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:5173
```

The development command starts both the web interface and the local API. The API listens only on `127.0.0.1`, not on your network interface.

### Stop the application

Return to the terminal that is running the application and press `Ctrl+C`. The launcher forwards the stop signal to both processes.

### Update the application

When this project is later connected to a source remote, the safe update sequence will be:

1. Stop the application.
2. Back up the `data/` directory if the release notes mention database changes.
3. Pull the intended version through your normal Git workflow.
4. Run `nvm use`.
5. Run `npm install`.
6. Run `npm run db:migrate`.
7. Run `npm run dev`.

Do not replace the `data/` directory during an update. A formal backup and migration-recovery workflow is planned for hardening.

## First-time setup

### Check local tools

The first screen shows readiness cards for Git, Claude Code, and Codex. Select **Recheck tools** after installing or re-authenticating a CLI.

A green tool status means the executable answered a local health command. It does not mean every model is available or that a live agent run has been tested.

### Add a Git repository

In **Projects → Register a project**:

1. Enter the absolute repository path, such as `/Users/you/Projects/example`.
2. Optionally enter a display name. The folder name is used if you leave it blank.
3. Optionally enter a default branch. The application first tries the locally known `origin/HEAD`, then falls back to the checked-out branch.
4. Optionally enter a worktree root. If blank, a sibling location under `.ai-worktrees` is suggested and stored.
5. Add project context that future agents should know.
6. Add test, lint, and build commands that fit this repository.
7. Select **Inspect & register**.

Registration reads Git metadata and writes only to AI Engineering Workspace's own SQLite database. It does not create the worktree directory, run your commands, stage files, create branches, or edit the repository.

### Manage a registered repository

Each registered project provides these controls:

- **Recheck Git** refreshes the checked-out branch and clean/dirty state.
- **Edit** changes the registration settings. Saving re-inspects the repository path read-only and rejects invalid or duplicate repositories.
- **Deregister** removes the project from AI Engineering Workspace after confirmation. It never deletes or modifies the Git repository, but it does remove that project's local tasks, agent-run history, comparisons, and evidence. Deregistration is refused while an agent run for the project is queued or running. Once managed worktrees are enabled, they will require safe cleanup before deregistration.

### Choose the default branch

Use the branch from which new task branches should eventually begin. This is commonly `main`, `master`, `develop`, or a project-specific integration branch. If the automatic value is wrong, enter the correct branch during registration. Future worktree creation must verify that the selected branch exists before using it.

### Set the worktree location

Keep worktrees outside the active repository directory. A typical layout is:

```text
/Users/you/Projects/.ai-worktrees/example/TASK-123/claude
/Users/you/Projects/.ai-worktrees/example/TASK-123/codex
```

Registration saves the root path but does not create it. Worktree creation is planned for Phase 4.

### Configure validation commands

Save commands that already belong to the project, for example:

```text
Tests       npm test
Lint        npm run lint
Build       npm run build
```

or:

```text
PHP tests   php artisan test
Frontend    npm run prod
```

These commands are stored only. A later validation workflow will show the exact command and working directory before it runs, then record start time, duration, exit code, stdout, stderr, and final status.

### Run a read-only repository explanation

After registering a project, go to **02 — Read-only agent run**:

1. Select the registered project.
2. Select Codex or Claude Code. The provider must show **Ready**.
3. Edit the explanation prompt if needed.
4. Optionally enter a model ID. Leave it blank to use the provider default.
5. Select **Run explanation**. This is the deliberate action that may use provider credits.
6. Watch the streamed answer, or select **Cancel** while it is queued or running.

These runs use a read-only repository profile and disable web access. They cannot edit repository files. Prompts, visible output, structured CLI events, process messages, timestamps, status, CLI version, requested model, and provider-reported actual model are stored in the local SQLite database. Output is capped at 5 MiB per channel.

Claude Code may be installed but show **Authentication required**. Run `claude auth login` yourself in a terminal, then select **Recheck tools**. The application never asks for or stores the provider credential.

### Select Claude and Codex models

Repository explanations and brainstorming tasks accept editable provider model IDs. Leaving an ID blank uses the provider default, and every run stores the requested value plus the actual model when the CLI reveals it.

A future settings increment will add four-level resolution:

1. global defaults;
2. per-project defaults;
3. per-task overrides; and
4. per-agent-role overrides.

The most specific explicit setting will win. Neither inspected CLI exposes an authoritative local model-list command, so editable IDs remain the current fallback.

### Configure web permission

Each brainstorm or architecture draft requires one explicit choice:

```text
Web Access

○ Disabled
○ Enabled for this task
```

The safe initial selection is **Disabled**. The task records the allow/deny decision, decision time, and human decision source; every run copies that audit decision. The application never silently enables web access. Project registration still describes the broader product default as “ask before use,” but no provider run starts until the task form contains an explicit resolved choice.

## Brainstorm workflow

In **03 — Independent brainstorming**:

1. Select a registered project.
2. Enter the title, task type, risk, and problem statement.
3. Explicitly disable or allow web access for this task.
4. Select **Create draft**. This stores local data only and does not use a provider.
5. Review the saved draft and provider readiness. Optionally enter provider model IDs and Claude effort.
6. Select **Start independent analyses**. This is the deliberate action that can start four paid/provider runs.

For example:

```text
Design database sharding for 500 tenant databases
```

The workflow is:

1. You describe the problem and mark known facts.
2. Claude receives the problem as an independent architect. It does not see Codex's answer.
3. Codex receives the same problem independently. It does not see Claude's answer.
4. Each response is stored in its original form and parsed into facts, assumptions, unknowns, options, risks, experiments, and any recommendation.
5. Codex critiques Claude's analysis.
6. Claude critiques Codex's analysis.
7. The comparison screen groups consensus, disagreements, open questions, missing evidence, and recommended experiments.
8. You correct facts and assumptions, add evidence or decisions, and decide which disagreement matters.

The task screen persists and reconstructs the draft, stage, runs, artifacts, comparison, and evidence after a browser refresh. You can cancel while analysis or cross-review is active. A server restart during active provider processes is not yet reconciled automatically.

Claude's role is not to lead automatically, and Codex's role is not merely to approve. Either provider can be assigned as architect or skeptic. Cross-review should distinguish a factual error from a legitimate difference in engineering judgment.

### Facts, assumptions, and decisions

The evidence board will use these record types:

- **Fact:** supported information you currently accept as true.
- **Assumption:** an unverified belief that affects the design.
- **Question:** something that needs an answer.
- **Decision:** a human-approved choice.
- **Experiment result:** evidence produced by a bounded test or proof of concept.

Items show whether they came from you, Claude, or Codex. You can edit or reclassify them through the local API; the current screen supports adding records and correcting their content. An AI suggestion never becomes a human decision merely because both models agree.

### Consensus and disagreement

Consensus is useful evidence that two analyses overlap; it is not proof. A disagreement is preserved with each side's reasoning, supporting evidence, and missing information. If evidence is insufficient, the correct result may be an experiment or a human decision—not a forced winner.

## Feature planning — planned

The planning path is:

```text
idea → brainstorm → architecture → ADR → implementation plan → coding tasks
```

Use brainstorm to widen and challenge the problem. Use architecture to compare system-level options and operational risks. Create an Architecture Decision Record only after you choose an option. The ADR records context, alternatives, decision, consequences, risks, and follow-up. Promote the approved decision into small implementation phases, then create linked coding tasks with explicit acceptance criteria.

The links matter: a future reviewer should be able to move from a code task back to the plan, ADR, experiment, and original problem.

## Bug fixing — planned

The intended bug workflow is:

```text
bug report
→ investigation
→ isolated builder worktree
→ implementation
→ tests
→ independent review
→ findings
→ fixes or evidence-backed rejection
→ re-review
→ human review
```

You choose the builder and reviewer. The reviewer cannot modify the builder worktree. Each finding records severity, category, location, evidence, impact, suggested fix, suggested test, confidence, and status.

The builder responds **Accepted**, **Rejected**, or **Partially accepted**, with evidence. The reviewer rechecks fixed or disputed findings. After three automated rounds, unresolved findings stop and go to you. The system never loops indefinitely.

## Choosing models — planned

Use stronger models when the cost of a missed issue is high or the task needs long-horizon reasoning. Examples include:

- a database migration with rollback and data-integrity risk;
- a security review;
- architecture spanning several services;
- a subtle concurrency bug; or
- a final review of a large, high-risk diff.

Use faster or cheaper models when the task is bounded and easily verified. Examples include:

- summarizing a small module;
- generating a test fixture;
- renaming a local symbol;
- reviewing documentation; or
- checking a narrow diff after comprehensive tests pass.

A practical pattern is to use a faster model for initial inventory, a stronger model for the consequential decision or implementation, and an independent strong reviewer for high-risk changes. Avoid spending premium reasoning on mechanical work that deterministic tools can verify.

## Browser and web access — planned

Enabling web access allows an agent to consult internet sources when its CLI supports that capability. It is useful for current vendor documentation, changed API behavior, security advisories, current compatibility information, or a specific external source you want checked.

Web access may increase token and context usage because search results and pages become part of the run. Local repository files, Git history, installed CLI help, lockfiles, tests, and local documentation are usually sufficient for repository-specific questions.

Choose:

- **Disabled** when the task should rely only on local evidence.
- **Ask before use** when browsing might help but you want a decision at the moment it becomes relevant.
- **Enabled for this task** when current external information is part of the task.

You can disable web access at the task level before a run. A denied web request must remain visible in run history and cannot be bypassed silently.

## Git worktrees

A Git worktree is another checked-out folder connected to the same repository history. It lets a branch have its own directory without copying the entire repository or disturbing your current checkout.

AI Engineering Workspace uses separate task worktrees so a builder cannot overwrite your active work and Claude and Codex do not edit the same files concurrently. In **04 — Worktrees**:

1. Select a task. The screen proposes a Claude and a Codex worktree, for example:

   ```text
   .ai-worktrees/example/TASK-123-add-promotion-versioning/claude
   .ai-worktrees/example/TASK-123-add-promotion-versioning/codex
   ai/TASK-123/add-promotion-versioning/claude
   ai/TASK-123/add-promotion-versioning/codex
   ```

2. Edit the directory path, branch name, and base ref if the generated values are not what you want. All three are independent and previewed before anything is created.
3. Select **Create Claude worktree** or **Create Codex worktree**. This is the explicit action that creates the worktree; nothing is created automatically. Creation never switches or modifies your active checkout, and Git rejects (and the screen reports) any path, branch, ref, or ownership collision before anything changes.
4. Select **Inspect and manage** on a created worktree to see its branch, HEAD, clean/dirty status, staged and unstaged diff, and any active usage lease.
5. **Move directory** and **Rename branch** are independent controls: moving the directory never renames the branch, and renaming the branch never moves the directory. Both are disabled while the worktree is dirty, locked, or in use, and disabled (with an explanation) if Git no longer reports a live worktree at that path.
6. **Prepare removal** arms a two-step confirmation. You must check both "I confirm this worktree should be removed" and, separately, whether to also delete the branch. Branch deletion only succeeds when Git confirms the branch is merged into its base ref; the worktree directory is retained by default and the branch is retained unless you explicitly ask for its deletion too.

If a worktree creation is interrupted (for example, a Claude or Codex worktree that failed partway through), the record is not deleted or discarded automatically. If Git no longer lists a live worktree at its path, requesting removal recovers the record — clearing the stale entry so the task/provider slot is free again — without ever discarding real work: a real, live worktree with uncommitted, staged, locked, prunable, or in-use state is still refused.

An active usage lease (recorded when a future build workflow uses a worktree) that outlives its process is labeled **STALE** after 6 hours and can be released explicitly from the inspector; nothing is released automatically.

## Usage safety

**05 — Usage safety** tracks Claude's and Codex's own provider allowance separately from everything else in this workspace. This is not the same thing as an API's tokens-per-minute rate limit: it is the Claude Code / ChatGPT plan allowance a run can exhaust (for example, Claude's rolling 5-hour window, or a weekly plan allowance), and it is checked before every provider-consuming action so you never spend it blind.

Neither the inspected Claude Code CLI nor the inspected Codex CLI exposes a documented local command that reports exact usage percentages, so:

- **Refresh** always reports that no automatic reading is available. It never shows a fabricated number.
- Use **Submit manual snapshot** to record what the provider's own interface (claude.ai, ChatGPT) shows you. Manual readings are always labeled **MANUAL** and **ESTIMATED**, with the time you entered them, so they are never confused with an automatic reading.
- If a provider process itself reports a rate-limit refusal, the workspace makes a best-effort attempt to parse it and records that provider as exhausted automatically. This parsing is heuristic; treat it as a helpful signal, not a certainty, and re-check with a manual snapshot if in doubt.

Each provider/window card shows used and remaining percentage, when it resets, its source, when it was last updated, and one of six states: **Safe**, **Warning**, **Checkpoint required**, **Exhausted**, **Unavailable**, or **Stale**. State is always shown as text, never color alone.

Before **Start independent analyses**, the brainstorm screen shows both providers' current state. If either provider is unknown, stale, at the checkpoint threshold, or exhausted:

- **Exhausted** blocks the action outright. There is no override; wait for reset or record a fresh reading once you have confirmed capacity.
- **Checkpoint required** or **unknown/stale** usage shows an explanation and an **Acknowledge and continue** button. Acknowledging is a deliberate action, recorded with the provider, the reading, your action, and the time, and only covers that specific situation — it expires after 15 minutes by default.

If usage crosses the checkpoint threshold while a brainstorm task is already running, the workflow pauses rather than continuing blind: the task shows status **CHECKPOINTED**, both completed independent analyses remain saved, and no further provider process starts. Resolve the checkpoint (acknowledge, wait for reset, or record a fresh safe reading), then select **Resume workflow**. Nothing already completed is re-run.

Adjust **Warning threshold %** and **Checkpoint threshold %** under Safety thresholds; both apply to Claude and Codex together. The defaults are 75% and 90%.

## Reviews and human responsibility — planned

AI agreement does not mean the code is automatically correct. Two models may share the same blind spot, rely on the same false assumption, or miss behavior that only appears in production conditions.

The pre-PR report will summarize implementation, changed files, findings, responses, tests, risks, decisions, and unresolved issues. It always marks human review as required. You should inspect the diff, verify important assumptions, consider production constraints, and decide whether the work is ready for your normal pull-request process.

## Troubleshooting

### Claude CLI missing

Run `claude --version` in your terminal. If the command is missing, install Claude Code through its supported process. Authenticate manually, restart the application if needed, and select **Recheck tools**. Do not paste credentials into the workspace.

### Codex CLI missing

Run `codex --version`. Confirm the installation directory is on `PATH`, then restart the application and recheck. On the inspected machine, Codex is bundled with the ChatGPT desktop app.

### Authentication expired

Run the provider CLI manually and follow its supported login flow. AI Engineering Workspace should only report the state; it should not collect your password or token. Recheck after authentication succeeds.

### CLI model unavailable

Confirm the requested model is available to the locally authenticated account. Select another model explicitly or edit the configured model ID. Review run history to confirm the requested and actual values; do not assume a fallback occurred.

### Agent command failed — planned

Open the run record and inspect its exit code, stderr, working directory, CLI version, permission profile, and model request. A failed run remains failed; the application will not label partial text as a success.

### Agent timed out — planned

Check whether the task was too broad or the configured timeout was too short. Inspect captured output, narrow the request, and start a new run. The original timeout remains in history.

### Git repository dirty

Dirty status does not prevent registration. Before creating a future worktree or changing branches, review the existing changes. The platform must not clean, stash, reset, or delete them automatically.

### Worktree conflict

Inspect the worktree path and branch shown by the application. A path, branch, ref, or ownership collision is reported before anything is created; choose a new task branch/path or reuse the existing managed worktree instead. If a worktree record shows an inspection error because Git no longer lists it (for example, after an interrupted creation or a worktree removed outside the application), use removal to clear the stale record — this only ever discards the database record, never a live, uncommitted worktree. Never delete a worktree directory manually while Git still tracks it unless you understand the recovery steps.

### Tests failed — planned

Read the exact command, exit code, stdout, and stderr. A failing command is recorded as failed even if an agent believes its code is correct. Fix the cause or explicitly document why the configured command is invalid before human review.

### Browser permission denied — planned

The agent continues with local evidence when possible. If external information is essential, the run should stop with a clear blocked reason. Change the task's web policy only if you decide the additional access is appropriate.

### Review loop reached three rounds — planned

Automatic debate stops. Unresolved findings appear in the pre-PR report for you to decide. You can accept the risk, request a targeted human or AI investigation, change requirements, or send the task back for another explicitly started workflow.

### Application will not start

Check `node --version` first. Node 16 is not supported. Then run:

```bash
npm install
npm run typecheck
npm run dev
```

If the database migration fails, preserve the `data/` directory and inspect the error before retrying. Do not delete the database as a first troubleshooting step.
