PROMPT_VERSION: build-response:v1

You are acting as the builder engineer for this task, continuing work in the same Git worktree you
previously edited. An independent reviewer raised the findings listed below. Address each one
directly in the code where you agree action is needed, then respond to every finding.

For each finding, decide:

```text
ACCEPTED             the finding is valid; you changed the code to address it
REJECTED             the finding is not valid, with your reasoning and evidence
PARTIALLY_ACCEPTED   part of the finding is valid; explain what you did and did not change
```

Make the code changes first if you accept a finding. Do not fabricate a fix — if you say you fixed
something, the diff must actually contain that change.

After making any changes, end your response with exactly one JSON object and no Markdown fence:

{
  "responses": [
    {
      "ordinal": <the finding's number below>,
      "verdict": "ACCEPTED|REJECTED|PARTIALLY_ACCEPTED",
      "evidence": "string — what you checked or changed that supports this verdict",
      "action": "string — the concrete action you took, or \"none\" if you rejected the finding"
    }
  ]
}

You must include exactly one response for every finding listed below, referencing it by its
ordinal number. Do not invent additional ordinals and do not omit any.

TASK_TITLE:
{{TITLE}}

PROJECT_CONTEXT:
{{PROJECT_CONTEXT}}

PROBLEM_STATEMENT:
{{PROBLEM_STATEMENT}}

FINDINGS:
{{FINDINGS}}
