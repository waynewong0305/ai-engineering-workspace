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
- generate a brainstorm plan report for a task on demand, summarizing the problem, both providers' analyses and cross-reviews, the comparison, and the evidence board, always marking a human decision as required;
- preview, edit, and create isolated Claude and Codex worktrees per task, without ever switching or modifying the active project checkout;
- inspect, move, rename, diff, and safely clean up managed worktrees, including recovering a record left behind by an interrupted or failed creation; and
- check Claude and Codex usage safety before any provider-consuming action, checkpoint a workflow at a configurable threshold without losing completed work, and record a manual usage snapshot or an explicit acknowledgement; and
- run a build/review pass per task: a chosen builder edits files inside its own worktree, selected validation commands run and are recorded honestly (including a failure), the full diff is captured, and an independent reviewer (never given write access) returns structured findings;
- send open findings back to the builder for an explicit response, then have the reviewer recheck them and raise any new findings, for up to a per-build configurable number of rounds (default 3);
- merge a completed build's worktree into a target branch once you explicitly approve it, re-run validation against the merged result, and automatically clean up the worktree and (optionally) its branch only when every safety condition holds; and
- generate a pre-PR report for a build on demand, summarizing the problem, implementation, files changed, findings by disposition, tests, and merge state, always marking human review as required; and
- create, edit, and reclassify architecture decision records (ADRs) for a task, numbered sequentially per project, stored locally and never exported into your repository automatically; and
- run an isolated proof-of-concept experiment against a stated hypothesis, with an independent reviewer returning a proven/disproven/inconclusive verdict that's automatically recorded on the task's evidence board; and
- promote an ADR into one or more linked implementation tasks, each keeping a real link back to its ADR (and, transitively, to the originating architecture discussion and any related experiments).

Brainstorming, architecture comparison, worktree isolation, the full build/review/response/merge/report loop, ADRs, and experiments are all available now.

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
- **Deregister** removes the project from AI Engineering Workspace after confirmation. It never deletes or modifies the Git repository, but it does remove that project's local tasks, agent-run history, comparisons, and evidence. Deregistration is refused while an agent run for the project is queued or running, and refused while any managed worktree is still linked to the project — clean up each worktree from the Worktrees screen first.

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

These commands are stored per project and can be selected when starting a build (see "Build and review" below), which runs each one inside the builder's own worktree and records its start time, duration, exit code, stdout, stderr, and final status. Since validation processes never use a shell, a command is limited to a plain program and arguments — pipes, `&&`/`||` chains, redirects, and inline environment assignment are not supported.

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

If authentication expires during a run, the failed run now explains that re-authentication and a
tool recheck are required. If the provider reports a different model from one you explicitly
requested, the run is failed and both model names remain visible in its record; the application does
not silently accept the substitute. Cancellation and timeout stop the provider's whole process tree,
including an uncooperative child process after a short forced-termination grace period.

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

When you have several tasks going at once, each entry in the **Tasks** sidebar list shows an **N open question(s)** badge whenever its evidence board holds one or more `QUESTION` records, so you can tell at a glance which tasks still need a human to weigh in — without opening each one. A question stops counting once you reclassify it to a different record type (typically `DECISION`).

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

### Brainstorm plan report

The **BRAINSTORM PLAN REPORT** section on a task's detail pane generates a summary on demand (select **Generate report**), the same on-demand pattern as the build workflow's pre-PR report. It includes:

- the task's type, risk level, and current status;
- the problem statement;
- each provider's independent analysis (summary and recommendation), or its parse error if the structured output couldn't be read;
- each provider's cross-review of the other, or its parse error;
- the comparison (consensus, disagreements, open questions, missing evidence, recommended experiments) once one has been generated;
- the evidence board's record count; and
- a recommended next action based on the task's current status (for example, resuming a checkpointed task, or reviewing consensus before starting a build).

You can generate this report at any point in the workflow, not only once the task reaches READY — a task that's still running, checkpointed, failed, or cancelled still exports whatever completed so far, never fabricating what hasn't happened yet. The report always states **Human decision required: YES**: it's a plan to review, not an approved decision — see "Reviews and human responsibility" below.

## Feature planning

The planning path is:

```text
idea → brainstorm → architecture → experiment → ADR → linked implementation tasks
```

Use brainstorm to widen and challenge the problem. Use architecture to compare system-level options and operational risks. Run an experiment to test a specific technical hypothesis before committing to it. Create an Architecture Decision Record once you choose an option, then promote it into one or more implementation tasks.

A future reviewer moving from a code task back to the plan, ADR, experiment, and original problem: a promoted task keeps a real link to its ADR, and the ADR itself already carries the originating architecture task and any related experiments — see "Plan promotion" below. This is one link per task, not a full acceptance-criteria/sub-task breakdown structure; write acceptance criteria into the task's own problem statement.

### Architecture decisions

In **08 — Decisions**, select a task and fill in an ADR:

1. **Title** — a short name for the decision.
2. **Context** — the situation that makes a decision necessary.
3. **Options considered** — what was on the table.
4. **Decision** — what was chosen.
5. **Reasons** — why.
6. **Consequences** — what follows from it.
7. Optionally: **Risks**, **Rejected alternatives**, **Required follow-up**.
8. Select **Create ADR**.

Each ADR is numbered sequentially within its project (`ADR-0001`, `ADR-0002`, ...) — one running log across the project's history, not per task. You can change its **status** (Proposed / Accepted / Rejected / Superseded) at any time from the dropdown on its card; every other field can be edited the same way (via the API today — a dedicated edit-in-place UI beyond status is not built yet).

ADRs are stored only in this application's local database. Nothing is ever written into your registered repository automatically — if you want an ADR committed as a Markdown file in the repo itself, that would be a separate, explicit, human-approved action, and is not implemented.

A build's pre-PR report (see "Build and review" below) automatically surfaces any ADR that either originated from that build's task or names it in `relatedTaskIds`.

### Plan promotion

On an ADR's card, below its fields, is a small form to promote it into an implementation task:

1. **New task title** — e.g. "Create shard registry schema".
2. **Problem statement** for the new task.
3. **Plan phase** (optional) — a free-text label like "Phase 1 — Shard Registry" so several tasks promoted from the same ADR can share a visible grouping.
4. Choose a risk level (defaults to Medium).
5. Select **+ Promote to implementation task**.

This creates one new task per submission — call it again for each `TASK-20x` you want under the same ADR (and reuse the same plan phase label to group them). The new task:

- keeps a real link back to the ADR it was promoted from (not the ADR's loose, human-curated `relatedTaskIds` — an actual field on the task itself, always set);
- starts as a plain **DRAFT**, and is never started automatically; and
- is created with type **IMPLEMENTATION** rather than Brainstorm or Architecture, since it's meant to skip independent-analysis brainstorming entirely — take it straight to **06 — Build** once you're ready.

Since the ADR itself already records which architecture task it came from and any related experiments, this one link is enough to walk the whole chain back: implementation task → ADR → architecture discussion (and experiments). Each ADR's card shows everything already promoted from it (title, status, plan phase).

### Experiments

On a task's detail pane (**03 — Brainstorm**), the **EXPERIMENTS / PROOFS OF CONCEPT** section next to the evidence board lets you test a specific technical hypothesis before committing to it:

1. Write a **Hypothesis** — a specific, testable claim (for example, "explicit tenant-to-shard routing can be implemented with a simple modulo router").
2. Choose a **Builder** and a **Reviewer** (must differ, same as Build and review).
3. Select **Start experiment**.

What happens automatically:

1. The builder gets write access scoped to an isolated worktree and is explicitly told to implement only the smallest proof-of-concept needed to test the hypothesis — not a production-ready solution — and to actually test what it builds rather than only reasoning about it.
2. The full diff is captured once.
3. The reviewer receives the diff and the builder's own summary, with read-only access, and returns a verdict: **PROVEN**, **DISPROVEN**, or **INCONCLUSIVE**, with its reasoning, what was actually observed, and a short, decision-ready conclusion. The reviewer is instructed to return INCONCLUSIVE rather than guess when the evidence doesn't clearly support either outcome.
4. That verdict and conclusion are automatically added to the task's evidence board as an **EXPERIMENT_RESULT** record — you don't have to copy it over yourself.

An experiment never merges anywhere and never runs your project's validation commands — it exists to inform a decision, not to ship code. Only one experiment can run at a time per task and provider; starting a second one for the same task and provider while the first is still going is refused. A task cannot run both a regular build (see "Build and review" below) and an experiment for the *same* provider at the same time — they share the same isolated worktree slot for that task/provider — but a different provider, or a later attempt after the first finishes, works fine.

If the reviewer's response can't be parsed into a structured verdict, the experiment is marked failed, the raw response is retained, and no evidence item is created — never a fabricated result.

## Bug fixing — partially planned

The intended bug workflow is:

```text
bug report          — not yet its own tracked concept; use a brainstorm/architecture task
→ investigation     — not yet its own tracked concept
→ isolated builder worktree       )
→ implementation                  )
→ tests                           )
→ independent review              )  available now — see "Build and review" above
→ findings                        )
→ fixes or evidence-backed rejection  )
→ re-review                           )
→ human-approved merge                )
→ pre-PR report                       )
→ human review
```

You choose the builder and reviewer. The reviewer cannot modify the builder worktree. Each finding records severity, category, location, evidence, impact, suggested fix, suggested test, and confidence.

Sending a finding back to the builder for an **Accepted**, **Rejected**, or **Partially accepted** response with evidence, and the reviewer rechecking fixed or disputed findings, both work today — see "Sending findings back to the builder" under "Build and review" above. The number of automatic re-review rounds is a configurable per-build setting (default 3) rather than a fixed number, so it can be tuned per build instead of hardcoded; unresolved findings stop once that limit is reached and the workflow tells you to resolve them directly. The system never loops indefinitely on its own.

Once you're satisfied, merging into a target branch and the guarded worktree/branch cleanup that follows also work today — see "Merging into a target branch" under "Build and review" above. So does generating a pre-PR report that summarizes the whole build (implementation, files changed, findings, tests, merge state) for your final human review — see "Pre-PR report" under "Build and review" above. This application still has no dedicated concept of a "bug report" or a separate "investigation" phase; use a brainstorm or architecture task to capture and think through the problem first, then start a build from it.

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

An active usage lease that outlives its process is labeled **STALE** after 6 hours and can be released explicitly from the inspector; nothing is released automatically.

## Build and review

In **06 — Build**, choose independent builder and reviewer roles for a task and run one bounded build/review pass:

1. Select a task.
2. Choose which provider builds and which reviews. The two must differ — one engineer is never asked to review its own work.
3. Select which saved validation commands to run for this build; all are selected by default. A project with no saved validation commands skips straight to review.
4. Set **Maximum review rounds** (default 3, 1-10). This is a per-build setting, not a fixed limit baked into the code — raise or lower it depending on how much back-and-forth you want to allow before a task needs your direct attention.
5. Select **Start build**.

What happens automatically:

1. The builder gets write access scoped to its own Git worktree only — reusing an existing worktree for that task/provider if one already exists, or creating one. It can edit files directly, but it is not given a general command-execution tool: running your project's own commands is the separate, controlled validation step below.
2. Each selected validation command then runs inside that worktree and is recorded honestly — exit code, duration, and full stdout/stderr — including a failing command, which does not block the review that follows; the workflow never claims a command passed when it did not.
3. The full diff, including brand-new files (not just changes to files Git already tracked), is captured once as a snapshot of exactly what the reviewer will see.
4. The reviewer receives that diff with read-only access — it may read the worktree for surrounding context, but it is never given write access — and returns structured findings: severity, category, file/line, title, description, evidence, impact, a suggested fix and test, and its confidence.

The build detail pane shows validation results, the diff that was reviewed, and every finding the reviewer raised. If the reviewer's response cannot be parsed into structured findings, the build is marked failed and the raw response is retained — nothing the reviewer said is silently dropped.

### Sending findings back to the builder

Once a build with open findings is **COMPLETED**, a **Send N open finding(s) to builder** button appears. Selecting it starts one review round:

1. The builder receives each open finding and must respond to every one of them: **ACCEPTED** (with evidence and what it changed), **REJECTED** (with its reasoning), or **PARTIALLY_ACCEPTED**. It can edit the worktree again before responding.
2. Validation re-runs (by default, the same commands as the previous round) and the diff is re-captured — this replaces the diff shown for the build with the latest snapshot; earlier rounds' diffs are not kept separately.
3. The reviewer rechecks every finding it raised against the builder's response and the fresh diff, marking each **RESOLVED** or leaving it **OPEN** for another round, and may raise brand-new findings from the fresh diff.

Each finding in the detail pane shows its round, current status (**OPEN** / **RESPONDED** / **RESOLVED**), the builder's verdict/evidence/action once it has responded, and the reviewer's recheck note once rechecked. The build heading shows **ROUND n / max**. Once a build reaches its configured maximum review rounds with findings still open, the **Send findings** button is replaced with a note telling you to resolve them directly — the workflow never keeps looping on its own.

### Merging into a target branch

There is no other commit path in this application — a builder or response run only ever edits files in its worktree, and nothing commits them for you. The **MERGE** section on a **COMPLETED** build is where you explicitly approve that:

1. Optionally set a **target branch** (defaults to the branch this task's worktree was created from) and a **commit message** (a sensible default is generated for you).
2. Optionally check **Keep worktree after merge** or **Delete task branch after merge**.
3. Select **Approve & merge**.

What happens automatically:

1. Everything currently in the task's worktree is committed — this is the one and only place a commit happens in this application, and it happens because you asked for it, not silently beforehand. The commit is authored as the builder's provider (so `git log`/`git blame` can always tell an AI-authored change apart from your own), while the *committer* identity stays whatever your repository already has configured.
2. The merge itself happens inside a throwaway, detached worktree at the target branch's current tip — never your own checked-out working copy, and never the task's worktree either. If there's a real conflict, everything is left exactly as it was and the conflicting files are named; nothing is guessed or force-resolved for you.
3. On a clean merge, your project's configured validation commands run again — this time against the merged result — before anything is finalized.
4. The target branch is then updated to point at the new merge commit, and the temporary worktree is discarded.
5. The task worktree is automatically removed only if the merge and post-merge validation both succeeded, the worktree is clean and not in use, and you didn't check "Keep worktree after merge." Otherwise it's preserved, and the detail pane says exactly why. Deleting the task branch only ever happens if you explicitly checked that box, and only once Git itself confirms the branch is actually merged.

**A note about your own checkout.** Landing a merge only ever moves the target branch's pointer (`git update-ref`) — it never checks anything out and never touches any working directory other than the throwaway one it created for the merge itself. If the target branch happens to already be checked out somewhere (most commonly your own primary working copy on that branch), that checkout's index will look stale relative to its own branch until you refresh it yourself (`git status`, then `git reset --hard` or similar). This is not file corruption — your working files are untouched — it's the same thing that happens with any tool that moves a ref out from under a checkout without touching it. The detail pane tells you explicitly when this applies, and names where.

### Pre-PR report

The **PRE-PR REPORT** section on a build's detail pane generates a summary on demand (select **Generate report**) rather than automatically, since it re-reads everything about the build each time. It includes:

- the task's problem statement and risk level;
- an implementation summary (the latest builder run's own closing text);
- the files changed, parsed from the captured diff;
- a findings breakdown: how many were accepted, rejected, or are still unresolved;
- every validation command's result, labeled by whether it ran before or after the merge;
- the merge's current state and target branch; and
- architecture decisions — any ADR linked to the build's task (see "Architecture decisions" under "Feature planning" above), or an honest empty list when none are linked (never fabricated).

The report always states **Human review required: YES** and a recommended next action. It is a summary to help you review, not a substitute for your own judgment — see "Reviews and human responsibility" below.

## Usage safety

**05 — Usage safety** tracks Claude's and Codex's own provider allowance separately from everything else in this workspace. This is not the same thing as an API's tokens-per-minute rate limit: it is the Claude Code / ChatGPT plan allowance a run can exhaust (for example, Claude's rolling 5-hour window, or a weekly plan allowance), and it is checked before every provider-consuming action so you never spend it blind.

Neither the inspected Claude Code CLI nor the inspected Codex CLI exposes a documented local command that reports exact usage percentages, so:

- **Refresh** always reports that no automatic reading is available. It never shows a fabricated number.
- Use **Submit manual snapshot** to record what the provider's own interface (claude.ai, ChatGPT) shows you. Manual readings are always labeled **MANUAL** and **ESTIMATED**, with the time you entered them, so they are never confused with an automatic reading.
- If a provider process itself reports a rate-limit refusal, the workspace makes a best-effort attempt to parse it and records that provider as exhausted automatically. This parsing is heuristic; treat it as a helpful signal, not a certainty, and re-check with a manual snapshot if in doubt.
- Automatic detection only catches wording it recognizes. If a run or brainstorm task fails, a **Mark as exhausted** button appears next to the failure so you can decide — the surrounding text above it names which provider it applies to. When the failure's own wording looks plausibly usage-related, the prompt is labeled **LOOKS LIKE A USAGE LIMIT** as a hint — this is only a suggestion to look closer, never an automatic conclusion; the button still does the same thing either way. Selecting it records the same kind of manual snapshot (100% used, labeled MANUAL) so the next provider call is blocked instead of failing the same way again.

Each provider/window card shows used and remaining percentage, when it resets, its source, when it was last updated, and one of six states: **Safe**, **Warning**, **Checkpoint required**, **Exhausted**, **Unavailable**, or **Stale**. State is always shown as text, never color alone.

Before **Start independent analyses**, the brainstorm screen shows both providers' current state. If either provider is unknown, stale, at the checkpoint threshold, or exhausted:

- **Exhausted** blocks the action outright. There is no override; wait for reset or record a fresh reading once you have confirmed capacity.
- **Checkpoint required** or **unknown/stale** usage shows an explanation and an **Acknowledge and continue** button. Acknowledging is a deliberate action, recorded with the provider, the reading, your action, and the time, and only covers that specific situation — it expires after 15 minutes by default.

If usage crosses the checkpoint threshold while a brainstorm task is already running, the workflow pauses rather than continuing blind: the task shows status **CHECKPOINTED**, both completed independent analyses remain saved, and no further provider process starts. Resolve the checkpoint (acknowledge, wait for reset, or record a fresh safe reading), then select **Resume workflow**. Nothing already completed is re-run.

Adjust **Warning threshold %** and **Checkpoint threshold %** under Safety thresholds; both apply to Claude and Codex together. The defaults are 75% and 90%.

## Reviews and human responsibility

AI agreement does not mean the code is automatically correct. Two models may share the same blind spot, rely on the same false assumption, or miss behavior that only appears in production conditions.

The pre-PR report (see "Pre-PR report" under "Build and review" above) summarizes implementation, changed files, findings, tests, and merge state, and always marks human review as required. You should still inspect the diff yourself, verify important assumptions, consider production constraints, and decide whether the work is ready for your normal pull-request process — an AI-approved merge is never equivalent to your own review.

## Troubleshooting

### Claude CLI missing

Run `claude --version` in your terminal. If the command is missing, install Claude Code through its supported process. Authenticate manually, restart the application if needed, and select **Recheck tools**. Do not paste credentials into the workspace.

### Codex CLI missing

Run `codex --version`. Confirm the installation directory is on `PATH`, then restart the application and recheck. On the inspected machine, Codex is bundled with the ChatGPT desktop app.

### Authentication expired

Run the provider CLI manually and follow its supported login flow. AI Engineering Workspace should only report the state; it should not collect your password or token. Recheck after authentication succeeds.

### CLI model unavailable

Confirm the requested model is available to the locally authenticated account. Select another model explicitly or edit the configured model ID. Review run history to confirm the requested and actual values; do not assume a fallback occurred.

### Agent command failed

Open the run record and inspect its exit code, stderr, working directory, CLI version, permission profile, and model request. A failed run remains failed; the application will not label partial text as a success.

### Agent timed out

Check whether the task was too broad or the configured timeout was too short. Inspect captured output, narrow the request, and start a new run. The original timeout remains in history.

### Git repository dirty

Dirty status does not prevent registration. Before creating a future worktree or changing branches, review the existing changes. The platform must not clean, stash, reset, or delete them automatically.

### Worktree conflict

Inspect the worktree path and branch shown by the application. A path, branch, ref, or ownership collision is reported before anything is created; choose a new task branch/path or reuse the existing managed worktree instead. If a worktree record shows an inspection error because Git no longer lists it (for example, after an interrupted creation or a worktree removed outside the application), use removal to clear the stale record — this only ever discards the database record, never a live, uncommitted worktree. Never delete a worktree directory manually while Git still tracks it unless you understand the recovery steps.

### Tests failed — planned

Read the exact command, exit code, stdout, and stderr. A failing command is recorded as failed even if an agent believes its code is correct. Fix the cause or explicitly document why the configured command is invalid before human review.

### Browser permission denied — planned

The agent continues with local evidence when possible. If external information is essential, the run should stop with a clear blocked reason. Change the task's web policy only if you decide the additional access is appropriate.

### Review loop reached its maximum rounds

Once `reviewRound` reaches a build's configured `maxReviewRounds`, **Send findings to builder** is replaced with a note asking you to resolve the remaining findings directly — the workflow never starts another round on its own. Read the still-open findings' descriptions, evidence, and (if a round was attempted) the builder's and reviewer's own notes on them. You can accept the risk, fix it yourself, or start a fresh build with a higher `maxReviewRounds` if you want to allow more automatic back-and-forth. Generate a pre-PR report (see "Pre-PR report" under "Build and review" above) to see the unresolved findings summarized alongside everything else about the build before you decide.

### Merge conflict

The MERGE section shows **MERGE_CONFLICT** and names the conflicting file(s). Nothing was changed: the task worktree still has its own committed change, and the target branch is exactly as it was. Resolve the conflict the way you normally would (for example, pull the target branch's latest change into your own tooling and rebase or merge manually), or ask the builder to fix it — either way, select **Approve & merge** again once you've addressed it.

### Worktree not cleaned up after a successful merge

The detail pane always says why: **Kept by request** if you checked "Keep worktree after merge," **Post-merge validation did not pass** (check the POST_MERGE validation results), **An active process is using the worktree**, or an unexpected cleanup error. In every case the worktree (and its branch, if you asked to delete it) is left exactly as it was — clean up manually once you're satisfied, or retry the merge action once the blocking condition is resolved.

### Application will not start

Check `node --version` first. Node 16 is not supported. Then run:

```bash
npm install
npm run typecheck
npm run dev
```

If the database migration fails, preserve the `data/` directory and inspect the error before retrying. Do not delete the database as a first troubleshooting step.
