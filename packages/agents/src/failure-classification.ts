import type { AgentFailureKind, AgentProvider } from "./types.js";

export type ClassifiedAgentFailure = {
  kind: AgentFailureKind;
  message: string;
};

const AUTHENTICATION_FAILURE = /\b(?:auth(?:entication|orization)?\s+(?:failed|required|expired)|credentials?\s+(?:expired|invalid|missing)|log(?:ged)?\s*(?:in|out)|not\s+authenticated|token\s+(?:expired|invalid)|unauthorized)\b|\b401\b/i;
const MODEL_FAILURE = /\bmodel\b.{0,80}\b(?:does not exist|invalid|not (?:available|found|supported)|unavailable|unsupported)\b|\b(?:invalid|unknown|unsupported)\s+model\b/i;
const TIMEOUT_FAILURE = /\btimed?\s*out\b|\btimeout\b/i;

export function classifyAgentFailure(
  provider: AgentProvider,
  detail: string,
): ClassifiedAgentFailure {
  const providerLabel = provider === "CLAUDE" ? "Claude Code" : "Codex";
  if (AUTHENTICATION_FAILURE.test(detail)) {
    return {
      kind: "AUTHENTICATION_REQUIRED",
      message: `${providerLabel} authentication is required or has expired. Authenticate manually in a terminal, then use Recheck before retrying.`,
    };
  }
  if (MODEL_FAILURE.test(detail)) {
    return {
      kind: "MODEL_UNAVAILABLE",
      message: `The requested ${providerLabel} model is unavailable. Choose an available model explicitly and retry; the workspace will not substitute one automatically.`,
    };
  }
  if (TIMEOUT_FAILURE.test(detail)) {
    return { kind: "TIMEOUT", message: detail.trim() || `${providerLabel} timed out.` };
  }
  return { kind: "PROCESS_ERROR", message: detail.trim() || `${providerLabel} process failed.` };
}

export function modelSubstitutionFailure(
  provider: AgentProvider,
  requestedModel: string,
  actualModel: string | null,
): ClassifiedAgentFailure | null {
  if (!requestedModel || requestedModel === "(provider default)" || !actualModel || requestedModel === actualModel) {
    return null;
  }
  const providerLabel = provider === "CLAUDE" ? "Claude Code" : "Codex";
  return {
    kind: "MODEL_SUBSTITUTED",
    message: `${providerLabel} ran ${actualModel} instead of the explicitly requested ${requestedModel}. The result was not accepted because model substitution requires a human decision. Choose the model explicitly and retry.`,
  };
}
