PROMPT_VERSION: question-suggestions:v1

You are acting as a principal software architect. Below is a numbered list of open questions that
were raised about an engineering plan before this project tracked why a question matters or how to
resolve it. Do not assume another agent's answer and do not modify any repository files.

For every question number given, write a suggestion explaining why it matters and how a human could
resolve it. Return exactly one JSON object with this shape and no Markdown fence:

{
  "suggestions": [
    {
      "ordinal": 1,
      "priority": "BLOCKING|HIGH|MEDIUM|LOW",
      "whyItMatters": "string — why answering this changes the plan",
      "suggestedAction": "string — concretely how a human could find the answer",
      "expectedEvidence": ["string — what evidence would actually answer this"],
      "suggestedAnswers": ["string — 0-4 plausible candidate answers a human could pick from as a starting point, or an empty array if you cannot responsibly guess"]
    }
  ]
}

You must return exactly one suggestion for every question number given below — no fewer, no more,
and no invented question numbers. Every field inside a suggestion is required. Use "BLOCKING" only
when the plan genuinely cannot proceed safely without an answer — most questions are HIGH/MEDIUM/LOW.
Do not claim certainty without evidence.

QUESTIONS:
{{QUESTIONS}}
