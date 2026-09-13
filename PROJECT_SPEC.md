# Local AI Engineering Workspace

## 1. Goal

Build a local-only AI engineering workspace that orchestrates Claude Code and OpenAI Codex against local Git repositories.

The platform is NOT merely a chat UI.

It must support the complete engineering lifecycle:

```text
THINK
  ↓
PLAN
  ↓
BUILD
  ↓
REVIEW
  ↓
VERIFY
  ↓
HUMAN REVIEW
```

Primary use cases:

1. Brainstorm new features.
2. Discuss architecture such as database sharding.
3. Challenge assumptions.
4. Compare multiple technical approaches.
5. Create architecture decisions.
6. Turn approved decisions into implementation tasks.
7. Let Claude or Codex implement a task.
8. Let the other model independently review it.
9. Allow the original model to respond to findings.
10. Run automated tests.
11. Re-review changes.
12. Produce a final pre-PR report for a human.

The platform must run locally on macOS first.

It should initially work with already-installed/authenticated Claude Code and Codex CLIs.

Do NOT build cloud infrastructure.

---

# 2. Important design principle

Claude and Codex must be treated as independent engineers.

Do NOT automatically make them agree.

For important workflows:

```text
Claude
   ↓ independent analysis

Codex
   ↓ independent analysis

Cross review
   ↓

Disagreements identified
   ↓

Evidence gathered
   ↓

Human decides
```

The platform should preserve disagreement instead of hiding it.

---

# 3. Technology stack

Use:

Frontend:
- Vue 3
- TypeScript
- Vite

Backend:
- Node.js
- TypeScript
- Fastify

Persistence:
- SQLite
- Drizzle ORM

Process execution:
- Node child_process or execa

Streaming:
- Server-Sent Events or WebSocket

Git:
- Native git CLI invoked from backend

Package management:
- npm workspaces

Do NOT use Laravel for this application.

Do NOT use Docker initially.

Do NOT use a vector database initially.

Do NOT use Redis initially.

Do NOT build authentication initially.

It is a single-user localhost application.

---

# 4. Proposed repository layout

```text
ai-engineering-workspace/
│
├── apps/
│   ├── web/
│   │   └── Vue 3 frontend
│   │
│   └── server/
│       └── Fastify backend
│
├── packages/
│   ├── core/
│   │   ├── workflow engine
│   │   ├── task state machine
│   │   └── domain models
│   │
│   ├── agents/
│   │   ├── AgentAdapter.ts
│   │   ├── ClaudeAdapter.ts
│   │   └── CodexAdapter.ts
│   │
│   ├── git/
│   │   ├── GitService.ts
│   │   └── WorktreeService.ts
│   │
│   └── shared/
│       └── shared TypeScript types
│
├── prompts/
│   ├── brainstorm-architect.md
│   ├── brainstorm-skeptic.md
│   ├── cross-review.md
│   ├── synthesis.md
│   ├── builder.md
│   ├── code-reviewer.md
│   └── finding-response.md
│
├── data/
│   └── local SQLite DB ignored by Git
│
├── package.json
└── README.md
```

---

# 5. Core domain objects

## Project

Represents a local Git repository.

Fields:

```text
id
name
repositoryPath
defaultBranch
worktreeRoot
projectContext
createdAt
updatedAt
```

Example:

```text
name:
Boostorder Web

repositoryPath:
/Users/wayne/Projects/boostorder-web

defaultBranch:
CI

worktreeRoot:
/Users/wayne/Projects/.ai-worktrees/boostorder-web
```

Project settings should also allow configurable commands:

```text
backend tests
frontend tests
lint
static analysis
build
custom validation
```

Example:

```text
php artisan test
npm run prod
```

Do not assume every project uses the same commands.

---

# 6. Task

A task is the main workspace object.

Task types:

```text
BRAINSTORM
ARCHITECTURE
FEATURE
BUG
REFACTOR
INVESTIGATION
```

Fields:

```text
id
projectId
title
problemStatement
type
status
riskLevel
createdAt
updatedAt
```

Risk:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

Examples:

```text
ARCHITECTURE
Design database sharding strategy

BUG
Duplicate notification dispatches

FEATURE
Add promotion versioning workflow
```

---

# 7. Agent abstraction

Never allow business logic to directly call Claude or Codex commands.

Create:

```ts
interface AgentAdapter {
    name: string;

    healthCheck(): Promise<AgentHealth>;

    run(input: AgentRunInput): AsyncIterable<AgentEvent>;

    cancel(runId: string): Promise<void>;
}
```

Implement:

```text
ClaudeAdapter
CodexAdapter
```

AgentRunInput should contain:

```text
cwd
prompt
permissionProfile
sessionId optional
outputFormat
timeout
environment
```

Agent events:

```text
started
stdout
stderr
structured_output
completed
failed
cancelled
```

This allows future providers to be added without changing workflow logic.

---

# 8. CLI detection

On startup:

```text
which claude
claude --version

which codex
codex --version
```

Display:

```text
Claude Code    ✓ Connected
Codex          ✓ Connected
Git            ✓ Available
```

Do NOT automate authentication.

If authentication is missing:

```text
Claude authentication required.
Run Claude Code manually to authenticate.

Codex authentication required.
Run Codex manually to authenticate.
```

Then provide:

```text
Recheck
```

button.

Do not store Claude/OpenAI passwords.

Do not store API keys in SQLite.

---

# 9. CLI invocation

Before implementing adapters, inspect the currently installed versions:

```bash
claude --help
codex --help
```

Implement invocation based on the CURRENT installed CLI capabilities.

Claude should preferably use its non-interactive/structured output capabilities.

Codex should similarly use its supported non-interactive execution interface.

Do not depend unnecessarily on terminal scraping.

CLI commands must be configurable rather than scattered throughout the codebase.

Example abstraction:

```text
CLAUDE_COMMAND_TEMPLATE
CODEX_COMMAND_TEMPLATE
```

The orchestrator should capture:

```text
stdout
stderr
exit code
duration
session/reference ID where available
```

---

# 10. Permission profiles

Every run must have an explicit permission profile.

Profiles:

```text
READ_ONLY
WORKTREE_WRITE
TEST_ONLY
```

READ_ONLY:

Agent may inspect repository.

Agent must not modify source files.

Used for:

```text
brainstorming
architecture discussion
review
investigation
```

WORKTREE_WRITE:

Agent may modify files ONLY inside its assigned Git worktree.

Used for:

```text
implementation
bug fixing
POCs
```

TEST_ONLY:

Used by validation processes.

Do not use unsafe flags such as unrestricted permission bypass by default.

---

# 11. Sensitive information protection

Do not automatically expose:

```text
.env
.env.*
SSH private keys
AWS credentials
database passwords
production secrets
macOS keychain data
```

Create a configurable deny list.

When spawning processes, sanitize environment variables.

Avoid automatically passing things such as:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
DB_PASSWORD
production tokens
```

The CLI must still retain whatever authentication mechanism it legitimately requires to access Claude/Codex.

Never automatically execute:

```text
git push
git push --force
git reset --hard
rm -rf
production deployment
production migration
```

Human approval should be required for destructive actions.

---

# 12. Git worktree strategy

Agents must not edit the same repository working directory simultaneously.

For implementation:

```text
source repo
    |
    ├── task-123-claude
    │
    └── task-123-codex
```

Example:

```text
.ai-worktrees/
└── boostorder-web/
    └── TASK-123/
        ├── claude/
        └── codex/
```

Suggested branches:

```text
ai/TASK-123/design-db-sharding/claude
ai/TASK-123/design-db-sharding/codex
```

Worktree directory and branch names should be generated from:

```text
task ID
sanitized task-title slug
agent/provider role
```

Example:

```text
.ai-worktrees/boostorder-web/TASK-204-add-promotion-versioning/codex
ai/TASK-204/add-promotion-versioning/codex
```

The creation screen must show both generated values before making changes. Users
must be able to edit them, subject to Git/path validation and collision checks.
An existing linked worktree may be renamed through a safe worktree-move operation;
the application must update its persisted path only after Git reports success.
The worktree directory name and branch name are independent and must not be
silently renamed together.

Worktree management must support:

```text
create
status
diff
remove
cleanup
```

Before deleting a worktree, verify that no uncommitted work will be lost.

Never silently delete work.

After an explicitly approved merge, the application may automatically remove the
task worktree only when all of the following are true:

```text
merge completed successfully
post-merge validation completed successfully
worktree contains no uncommitted or untracked work
no agent process is using the worktree
the task has no unresolved merge conflict
```

The user can enable `Keep worktree after merge` before merging. A failed merge,
failed validation, dirty worktree, active process, or unresolved conflict must
preserve the worktree and explain why cleanup was skipped. Deleting the merged
task branch is a separate, configurable option and must never be implied by
removing the worktree.

---

# 13. Brainstorm workflow

This is one of the most important workflows.

Example:

```text
How should Boostorder horizontally scale
its 500+ tenant databases?
```

Stage 1: Independent analysis.

Claude receives:

```text
Role: Principal Architect

Analyze this problem independently.
Do not assume another AI's answer.

Identify:
- current problem
- facts
- assumptions
- unknowns
- possible approaches
- advantages
- disadvantages
- risks
- experiments/data needed
- recommendation if enough evidence exists
```

Codex receives the same problem independently.

Neither should see the other's answer initially.

---

# 14. Brainstorm structured result

Require a structured format conceptually equivalent to:

```json
{
  "summary": "",
  "facts": [],
  "assumptions": [],
  "unknowns": [],
  "options": [
    {
      "name": "",
      "description": "",
      "advantages": [],
      "disadvantages": [],
      "risks": []
    }
  ],
  "recommendedExperiments": [],
  "recommendation": null
}
```

Store the complete original response as well.

Do not discard raw output.

---

# 15. Cross-review workflow

After independent analyses finish:

```text
Claude analysis
      ↓
Codex critique

Codex analysis
      ↓
Claude critique
```

Reviewer instruction:

```text
Do not automatically agree.

Find:
- unsupported assumptions
- technical mistakes
- missing failure cases
- hidden operational costs
- migration risks
- contradictory statements
- missing evidence

Distinguish disagreement from factual error.
```

---

# 16. Comparison screen

UI should display:

```text
Claude                 Codex

Proposal A             Proposal B
Assumptions            Assumptions
Risks                  Risks
Recommendation         Recommendation
```

Then automatically extract:

```text
CONSENSUS

DISAGREEMENTS

OPEN QUESTIONS

MISSING EVIDENCE

RECOMMENDED EXPERIMENTS
```

Do not display a fake winner.

---

# 17. Assumption board

Tasks should have a persistent assumption/evidence board.

Record types:

```text
FACT
ASSUMPTION
QUESTION
DECISION
EXPERIMENT_RESULT
```

Example:

```text
FACT
There are approximately 500 tenant databases.

FACT
Storage capacity is approaching its limit.

ASSUMPTION
Storage growth will continue at the current rate.

QUESTION
How uneven is storage usage between tenants?

QUESTION
What is current disk IOPS saturation?

DECISION
Use explicit tenant → shard mapping.
```

Each item should record its source:

```text
USER
CLAUDE
CODEX
SYSTEM
```

Users must be able to edit/promote/demote items.

---

# 18. Architecture decision record

A discussion can create an ADR.

Example:

```text
ADR-0004

Title:
Explicit Tenant-to-Shard Mapping

Context

Options considered

Decision

Reasons

Consequences

Risks

Rejected alternatives

Required follow-up

Date

Related tasks
```

Store ADRs in SQLite initially.

Optional later:

Export them to Markdown inside the target repository.

Do not automatically modify the target repo for an ADR without approval.

---

# 19. Experiment / POC workflow

Architecture discussions should support:

```text
Create Experiment
```

Example:

```text
Prove Laravel can dynamically route tenants
to different MySQL servers using a shard registry.
```

Create an isolated worktree:

```text
experiment/TASK-123/shard-routing
```

The selected agent implements only the smallest POC required.

Then the second agent reviews it.

Store:

```text
hypothesis
implementation
test executed
result
conclusion
```

The result becomes an EXPERIMENT_RESULT in the evidence board.

---

# 20. Promote plan into implementation

Architecture decisions can become implementation tasks.

Example:

```text
DB Sharding Architecture
        ↓

Phase 1 — Shard Registry
        ↓

TASK-201
Create shard registry schema

TASK-202
Create ShardResolver

TASK-203
Dynamic DB connection routing

TASK-204
Tenant migration tooling
```

Tasks must preserve their relationship to:

```text
original architecture discussion
ADR
experiment
parent plan
```

---

# 21. Build workflow

For a normal coding task:

Choose roles.

Example:

```text
Builder:
Claude

Reviewer:
Codex
```

Then:

```text
Create Claude worktree
        ↓
Claude analyzes task
        ↓
Claude modifies code
        ↓
Run validation
        ↓
Collect git diff
        ↓
Codex reviews diff
```

Reviewer should not modify the builder worktree.

---

# 22. Code review output

Review findings should use structured fields:

```text
id
severity
category
file
startLine
endLine
title
description
evidence
impact
suggestedFix
suggestedTest
confidence
status
```

Severity:

```text
CRITICAL
HIGH
MEDIUM
LOW
INFO
```

Categories:

```text
CORRECTNESS
RACE_CONDITION
SECURITY
DATA_INTEGRITY
PERFORMANCE
TESTING
MAINTAINABILITY
MIGRATION
COMPATIBILITY
```

---

# 23. Review response

Send each review finding back to the builder.

Builder must respond:

```text
ACCEPTED
REJECTED
PARTIALLY_ACCEPTED
```

with evidence.

Example:

```text
Finding:
Race condition still possible.

Builder:
ACCEPTED

Evidence:
Added concurrent execution test that reproduces issue.

Action:
Implemented unique DB constraint and retry handling.
```

Or:

```text
REJECTED

Reason:
Existing transaction lock prevents the claimed race.

Evidence:
Test XYZ executes two workers concurrently and confirms
only one dispatch can be created.
```

Reviewer then rechecks disputed or fixed findings.

Maximum automatic review rounds:

```text
3
```

After 3 rounds, unresolved issues go to the human.

Never allow endless AI debate.

---

# 24. Automated checks

Projects should configure validation commands.

Example Boostorder configuration:

```text
PHP tests:
php artisan test

Frontend build:
npm run prod

Additional future checks:
PHPStan
ESLint
migration validation
```

Record:

```text
command
start time
duration
exit code
stdout
stderr
status
```

Agents must not claim a test passed unless the command actually returned successfully.

## 24.1 Frontend verification and approval policy

A successful type-check or production build does not prove that a frontend still renders or behaves
correctly. For a project with frontend verification configured, the workspace should be able to run
deterministic local checks inside the task worktree before human review:

```text
component and browser tests
critical user scenarios
desktop and mobile viewport checks
console and failed-network-request capture
accessibility scans
approved-baseline screenshot comparison
```

These checks are validation processes, not agent runs, and may execute without separate model
approval when their commands and scope were configured by the human. Browser execution must remain
supervised, local, bounded, and isolated to the task worktree.

No model-backed agent, regardless of provider or adapter, may automatically inspect the rendered
frontend or receive screenshots, rendered pages, DOM/accessibility output, or other browser
evidence. Immediately before each such agent run, require an explicit human approval that displays:

```text
why an agent UI/UX review is recommended
which provider and agent configuration will run
which pages, scenarios, and evidence will be shared
which automated failure or change triggered the recommendation
that provider usage may be consumed
```

This provider-neutral rule applies equally to current and future adapters; Claude and Codex are only
the initially supported examples. It is a separate just-in-time decision. Approval to start a
build, approval for ordinary code review, a web-access decision, or a usage-safety acknowledgement
must not be reused as approval for frontend agent review. The approval applies only to the disclosed
run and scope, and the workspace must persist the displayed reason, scope, provider, agent
configuration, decision, and timestamp.

If the human declines, the workflow continues only as far as deterministic evidence permits and
must report `UI_REVIEW_SKIPPED` or `HUMAN_REVIEW_REQUIRED`; it must never claim `UI_VERIFIED`.
Automated checks may recommend provider review but must not launch it. A provider's visual opinion
is advisory and never replaces final human UX judgment.

Provider usage must be minimized:

```text
do not recommend agent review when deterministic checks pass and approved baselines are unchanged
use one provider by default, not parallel duplicate reviews
send only affected pages, changed screenshot regions, and concise relevant failure excerpts
do not send full unchanged screenshot sets, complete logs, or unrelated DOM content
reuse evidence captured for the exact build revision instead of regenerating or re-analyzing it
require a new approval before adding a second provider or materially widening the evidence scope
```

If no reliable change-to-page mapping exists, say so in the approval reason rather than silently
sending the entire application. The human may approve the broader scope or choose manual review.

---

# 25. Pre-PR report

Before considering a task complete, generate:

```text
TASK
TASK-123

Problem
...

Implementation Summary
...

Files Changed
...

Claude Findings
...

Codex Findings
...

Accepted Findings
...

Rejected Findings
...

Unresolved Findings
...

Tests
✓ xxx
✓ xxx
✗ xxx

Risks
...

Architecture Decisions
...

Human Review Required
YES

Recommended next action
Inspect diff
```

AI approval is never equivalent to human approval.

---

# 26. Main UI

Initial sidebar:

```text
Projects

Tasks

Brainstorm

Architecture

Build

Reviews

Decisions

Settings
```

Project screen:

```text
Boostorder Web

Repository
/Users/.../boostorder-web

Git status
Clean

Claude
Connected

Codex
Connected

Open Tasks
...
```

---

# 27. Task workspace UI

Example:

```text
TASK-123
Design DB Sharding

[Brainstorm] [Plan] [Build] [Review]

------------------------------------------------

Problem Statement

Our existing DB host is approaching storage capacity...

------------------------------------------------

Claude
Completed

Codex
Completed

------------------------------------------------

Consensus
...

Disagreements
...

Open Questions
...

Assumptions
...

------------------------------------------------

[Cross Review]

[Create Experiment]

[Create ADR]

[Create Implementation Plan]
```

---

# 28. Build workspace UI

Example:

```text
TASK-201 — Add ShardResolver

Builder
Claude

Reviewer
Codex

Worktree
.ai-worktrees/...

Builder status
Completed

Validation
✓ tests

Review

HIGH  1
MEDIUM 2
LOW 1

Review Round
2 / 3

[View Diff]

[Send Findings to Builder]

[Run Tests]

[Re-review]

[Mark Ready for Human Review]
```

---

# 29. Diff viewer

Implement a basic unified Git diff viewer.

Need:

```text
filename
added lines
deleted lines
syntax-friendly formatting
```

Later enhancement:

side-by-side diff.

Do not spend excessive MVP effort building an IDE.

Opening a worktree in VS Code should be supported:

```text
Open in Editor
```

---

# 30. Workflow state machine

Suggested states:

```text
DRAFT

BRAINSTORMING

AWAITING_COMPARISON

PLANNING

READY_TO_BUILD

BUILDING

VALIDATING

REVIEWING

CHANGES_REQUESTED

READY_FOR_HUMAN_REVIEW

DONE

FAILED
```

Persist state.

Refreshing the browser must not lose task progress.

---

# 31. Run history

Every agent interaction must be stored.

Store:

```text
task
agent
role
prompt
startedAt
completedAt
status
workingDirectory
CLI version
raw stdout
raw stderr
structured result
```

Do not store hidden chain-of-thought.

Store only output actually made available by the CLI.

---

# 32. Cancellation

Every running agent process needs:

```text
Cancel
```

Backend should track child processes.

Cancellation must terminate the process safely.

UI must distinguish:

```text
FAILED
CANCELLED
COMPLETED
```

---

# 33. MVP scope

The MVP must include:

```text
Project registration
Claude health check
Codex health check
Task creation
Brainstorm mode
Independent Claude/Codex analysis
Cross-review
Comparison screen
SQLite persistence
Git worktree management
One builder + one reviewer workflow
Diff collection
Review findings
Maximum 3 review rounds
Configurable test commands
Pre-PR report
```

Do NOT implement yet:

```text
GitHub integration
GitLab integration
automatic PR creation
multi-user support
cloud hosting
remote agents
mobile app
vector database
Slack
Jira
SSO
CI/CD integration
automatic production deployment
```

Keep the MVP focused.

---

# 34. Development phases

## Phase 0 — Bootstrap

Create monorepo.

Implement:

```text
Vue frontend
Fastify backend
SQLite
Drizzle migrations
basic navigation
health endpoint
```

Acceptance:

```text
npm install
npm run dev

opens local application successfully.
```

---

## Phase 1 — Projects

Implement project registration.

Functions:

```text
add project
edit project registration
deregister project without deleting repository files
validate path
detect Git repository
read branch
read status
configure worktree root
configure validation commands
```

Acceptance:

Boostorder can be registered, edited, re-inspected, and deregistered without
modifying or deleting anything in the Boostorder repository. Deregistration
requires confirmation, removes dependent local workspace history, and is refused
while an agent run is active. Once managed worktrees are enabled, deregistration
must also require their safe cleanup first.

---

## Phase 2 — Agent adapters

Implement:

```text
AgentAdapter
ClaudeAdapter
CodexAdapter
health check
process streaming
cancellation
run history
```

Before coding the adapters, inspect:

```text
claude --help
claude --version

codex --help
codex --version
```

Do not invent unsupported CLI flags.

Acceptance:

The UI can send:

```text
Explain this repository at a high level.
```

to either agent and stream the answer.

---

## Phase 3 — Brainstorming

Implement independent parallel analysis.

Then implement cross-review.

Then produce:

```text
Consensus
Disagreements
Questions
Assumptions
Experiments
```

Acceptance:

Create:

```text
How should this system support database sharding?
```

and successfully obtain independent Claude and Codex analyses.

---

## Phase 4 — Git/worktrees

Implement safe worktree management.

Include meaningful generated worktree/branch names, editable names before
creation, collision validation, and safe renaming of an existing linked
worktree. Track the worktree path and branch independently.

Acceptance:

A task can create:

```text
TASK-X/claude
TASK-X/codex
```

without modifying the developer's active working tree.

Renaming a clean, inactive task worktree succeeds without renaming its branch,
and removal is refused when the worktree is dirty or in use.

---

## Phase 5 — Build and review

Implement:

```text
Builder
Reviewer
diff
findings
responses
review rounds
```

Acceptance:

Claude can change a sample repository.

Codex can review the diff without editing Claude's worktree.

Claude can receive Codex findings.

---

## Phase 6 — Planning and ADRs

Implement:

```text
assumption board
decisions
ADRs
experiments
promote plan into tasks
```

Acceptance:

A brainstorm can create an ADR and generate implementation tasks linked to it.

---

## Phase 7 — Hardening

Add:

```text
environment sanitization
sensitive path deny list
process cancellation
timeout handling
CLI failure handling
worktree conflict handling
database backups
cleanup tools
audit history
```

---

## Phase 8 — Usage, token, and cost monitoring

Queued behind Phase 7; Phases 5 and 6 are complete (see `IMPLEMENTATION_ROADMAP.md`). Full spec:
`USAGE_MONITORING_SPEC.md`.

Implement:

```text
UsageRecord per agent run (tokens, cache, cost, billing mode, usage source)
centralized versioned pricing registry
API-equivalent cost calculation, always labeled as such
workspace/project/task/run usage dashboard
cross-review cost breakdown by role/workflow
task usage budgets integrated with the max-review-round cap
historical backfill from provider-reported data only
```

Acceptance:

A small real Claude run and a small real Codex run each produce a usage record with correctly
labeled billing mode and usage-source reliability, the workspace dashboard reflects both, and no
historical or current value is fabricated.

---

# 35. Testing strategy

Unit test:

```text
workflow state transitions
structured result parser
review parser
Git command generation
worktree path generation
environment sanitization
```

Integration test:

Use a tiny temporary Git repository.

Tests must verify:

```text
worktree creation
file modification
git diff
worktree cleanup
builder/reviewer isolation
```

Mock Claude/Codex adapters for automated tests.

Do not require real AI calls for the test suite.

---

# 36. Prompt versioning

Prompts must be files, not hardcoded throughout the application.

Example:

```text
prompts/
    brainstorm-architect.md
    brainstorm-skeptic.md
    code-reviewer.md
```

Track prompt version in each run.

Example:

```text
brainstorm-architect:v1
```

This is important because changing prompts changes system behaviour.

---

# 37. Architecture constraint

Workflow logic must never contain code such as:

```ts
if (agent === "claude") {
    ...
}
```

outside the provider adapter layer.

Workflow should interact only through:

```text
AgentAdapter
```

This ensures Claude and Codex can swap roles.

Example:

```text
Claude Builder + Codex Reviewer

or

Codex Builder + Claude Reviewer
```

should require no architecture changes.

---

# 38. Human control

The platform must always allow the human to:

```text
stop a run
edit task requirements
add facts
correct assumptions
reject AI recommendations
resolve disagreements
choose builder
choose reviewer
inspect worktree
inspect diff
rerun tests
mark task complete
```

The AI is an engineering assistant, not an autonomous authority.

---

# 39. First real test after MVP

Register:

```text
boostorder-web
```

Create an ARCHITECTURE task:

```text
Title:
Database Horizontal Scaling

Problem:

The application currently has approximately 500 tenant databases.
The existing database server is approaching storage capacity.
We do not want to continue vertical scaling indefinitely.

Investigate database-level horizontal scaling/sharding.

Do not immediately assume sharding is the correct answer.
Challenge the problem statement and identify information needed
before making the decision.
```

Run:

```text
Claude independent analysis
Codex independent analysis
Cross-review
```

Evaluate whether the resulting comparison is actually useful.

Do NOT allow either agent to modify Boostorder during this task.

This is the MVP's first major acceptance test.

---

# 40. Second real test

Create a small real bug-fixing task.

Choose:

```text
Claude = Builder
Codex = Reviewer
```

Expected flow:

```text
Task
 ↓
Claude worktree
 ↓
Claude implementation
 ↓
tests
 ↓
git diff
 ↓
Codex review
 ↓
findings
 ↓
Claude response/fix
 ↓
tests
 ↓
Codex re-review
 ↓
pre-PR report
 ↓
human
```

Then repeat once with roles reversed:

```text
Codex = Builder
Claude = Reviewer
```

Both directions must work.

---

# 41. Definition of MVP success

The MVP is successful when I can open:

```text
http://localhost:<port>
```

select Boostorder, describe either:

```text
an architecture problem
```

or:

```text
a coding problem
```

and the platform can orchestrate Claude and Codex independently while maintaining:

```text
task history
agent outputs
assumptions
decisions
worktrees
diffs
review findings
test results
```

without requiring me to manually copy/paste messages between Claude and Codex.

---

# 42. Implementation instructions for the coding agent

Read this entire specification first.

Do NOT attempt to implement every feature in one giant change.

Before writing code:

1. Inspect the local development environment.
2. Verify Node/npm/Git.
3. Verify Claude CLI.
4. Verify Codex CLI.
5. Inspect their current help output.
6. Create an implementation checklist.
7. Start with Phase 0.
8. Keep architecture extensible for later phases.
9. Commit logically separated changes.
10. Do not access or modify boostorder-web until project registration exists.

Do not prematurely add features outside this specification.

When a design decision is unclear, choose the simplest design that preserves the documented architecture.

After each phase:

```text
run tests
run type checking
summarize files changed
summarize remaining work
```

Most importantly:

Do not sacrifice agent isolation, Git safety, or auditability for speed.
