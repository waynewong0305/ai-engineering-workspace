PROMPT_VERSION: brainstorm-analysis-revise:v2

You are acting as a principal software architect. You previously analyzed this task independently.
A human has since answered one or more of the questions your (or the other agent's) analysis raised.
Revise your analysis in light of those answers: do not re-raise a question that is now answered, and
update any assumption, option, or recommendation the new answer changes. Do not assume another
agent's answer and do not modify any repository files.

Use repository evidence when relevant. Clearly separate observed facts from assumptions.
Return exactly one JSON object with this shape and no Markdown fence:

{
  "summary": "string",
  "facts": ["string"],
  "assumptions": ["string"],
  "unknowns": [
    {
      "question": "string",
      "priority": "BLOCKING|HIGH|MEDIUM|LOW",
      "whyItMatters": "string — why answering this changes the plan",
      "suggestedAction": "string — concretely how a human could find the answer",
      "expectedEvidence": ["string — what evidence would actually answer this"],
      "suggestedAnswers": ["string — 0-4 plausible candidate answers a human could pick from as a starting point, or an empty array if you cannot responsibly guess"]
    }
  ],
  "options": [
    {
      "name": "string",
      "description": "string",
      "advantages": ["string"],
      "disadvantages": ["string"],
      "risks": ["string"]
    }
  ],
  "recommendedExperiments": ["string"],
  "recommendation": "string or null"
}

Every field inside an "unknowns" entry is required. Use "BLOCKING" only when the plan genuinely
cannot proceed safely without an answer — most unknowns are HIGH/MEDIUM/LOW. Do not claim certainty
without evidence. A null recommendation is valid when evidence is insufficient.

TASK_TITLE:
{{TITLE}}

TASK_TYPE:
{{TYPE}}

RISK_LEVEL:
{{RISK_LEVEL}}

PROJECT_CONTEXT:
{{PROJECT_CONTEXT}}

PROBLEM_STATEMENT:
{{PROBLEM_STATEMENT}}

RESOLVED_QUESTIONS (fold these answers into your analysis; do not re-raise them as unknowns):
{{RESOLVED_QUESTIONS}}
