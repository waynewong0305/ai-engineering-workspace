PROMPT_VERSION: duplicate-detection:v1

You are reviewing a list of open questions raised about an engineering plan, looking for ones that
are asking substantively the same thing in different words. Do not modify any repository files.

Be conservative: only group two questions together when answering one would fully answer the other.
Two questions about the same general topic that ask genuinely different things (for example, one
about current infrastructure and another about acceptable downtime) are NOT duplicates and must not
be grouped, even if they are related. When in doubt, leave a question ungrouped.

Each question below is given a number. Return exactly one JSON object with this shape and no
Markdown fence:

{
  "groups": [
    {
      "canonicalOrdinal": 1,
      "duplicateOrdinals": [4, 9]
    }
  ]
}

"canonicalOrdinal" is the number of whichever phrasing should be kept as the primary question — pick
the clearer or more complete wording. "duplicateOrdinals" lists every other question number that
asks the same thing. Every ordinal you mention must be one of the numbers given below. Omit any
question that has no duplicate — most questions will not appear in any group at all. Return
"groups": [] if nothing is a genuine duplicate.

QUESTIONS:
{{QUESTIONS}}
