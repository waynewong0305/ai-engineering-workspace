import type { QuestionPriority, StructuredQuestion } from "../db/schema.js";

export const MAX_STRUCTURED_RESPONSE_CHARS = 160_000;
export const MAX_LIST_ITEMS = 100;
export const MAX_ITEM_CHARS = 5_000;

const QUESTION_PRIORITIES = new Set<QuestionPriority>(["BLOCKING", "HIGH", "MEDIUM", "LOW"]);

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function strings(value: unknown): string[] | null {
  if (
    !Array.isArray(value)
    || value.length > MAX_LIST_ITEMS
    || value.some((item) => typeof item !== "string" || item.length > MAX_ITEM_CHARS)
  ) return null;
  return value.map((item) => item.trim()).filter(Boolean);
}

/**
 * brainstorm-analysis:v2 / cross-review:v2: each item is either a plain string (v1 shape, and a
 * v2-prompted model's defensive fallback) or a fully-populated StructuredQuestion object —
 * all-or-nothing per item, matching every other structured parser here (a malformed structured item
 * fails the whole response rather than silently dropping fields).
 */
export function structuredQuestions(value: unknown): (string | StructuredQuestion)[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) return null;
  const result: (string | StructuredQuestion)[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (!trimmed || trimmed.length > MAX_ITEM_CHARS) return null;
      result.push(trimmed);
      continue;
    }
    const entry = record(item);
    if (!entry) return null;
    const question = typeof entry.question === "string" ? entry.question.trim() : "";
    const whyItMatters = typeof entry.whyItMatters === "string" ? entry.whyItMatters.trim() : "";
    const suggestedAction = typeof entry.suggestedAction === "string" ? entry.suggestedAction.trim() : "";
    const expectedEvidence = strings(entry.expectedEvidence);
    const suggestedAnswers = strings(entry.suggestedAnswers);
    if (
      !question || question.length > MAX_ITEM_CHARS
      || !whyItMatters || whyItMatters.length > MAX_ITEM_CHARS
      || !suggestedAction || suggestedAction.length > MAX_ITEM_CHARS
      || typeof entry.priority !== "string" || !QUESTION_PRIORITIES.has(entry.priority as QuestionPriority)
      || !expectedEvidence || !suggestedAnswers
    ) return null;
    result.push({ question, priority: entry.priority as QuestionPriority, whyItMatters, suggestedAction, expectedEvidence, suggestedAnswers });
  }
  return result;
}

export function extractJson(text: string): unknown {
  if (text.length > MAX_STRUCTURED_RESPONSE_CHARS) {
    throw new Error(`The structured response exceeds ${MAX_STRUCTURED_RESPONSE_CHARS.toLocaleString()} characters.`);
  }
  const candidates = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === "\\") { escaped = true; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  for (const candidate of candidates) {
    try { return JSON.parse(candidate); } catch { /* Try the next candidate. */ }
  }
  throw new Error("The agent did not return a parseable JSON object.");
}
