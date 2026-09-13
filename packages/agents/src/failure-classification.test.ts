import { describe, expect, it } from "vitest";
import { classifyAgentFailure, modelSubstitutionFailure } from "./failure-classification.js";

describe("agent failure classification", () => {
  it.each([
    "Authentication required",
    "token expired",
    "not authenticated",
    "HTTP 401 unauthorized",
  ])("classifies authentication failures: %s", (message) => {
    expect(classifyAgentFailure("CLAUDE", message)).toMatchObject({ kind: "AUTHENTICATION_REQUIRED" });
  });

  it.each([
    "model gpt-example is not available",
    "unknown model claude-example",
    "The requested model does not exist",
  ])("classifies unavailable-model failures: %s", (message) => {
    expect(classifyAgentFailure("CODEX", message)).toMatchObject({ kind: "MODEL_UNAVAILABLE" });
  });

  it("does not treat an ordinary provider failure as authentication or model availability", () => {
    expect(classifyAgentFailure("CODEX", "process exited with code 2")).toEqual({
      kind: "PROCESS_ERROR",
      message: "process exited with code 2",
    });
  });

  it("rejects only a known substitution of an explicitly requested model", () => {
    expect(modelSubstitutionFailure("CODEX", "gpt-requested", "gpt-actual")).toMatchObject({
      kind: "MODEL_SUBSTITUTED",
    });
    expect(modelSubstitutionFailure("CODEX", "gpt-requested", "gpt-requested")).toBeNull();
    expect(modelSubstitutionFailure("CODEX", "(provider default)", "gpt-actual")).toBeNull();
    expect(modelSubstitutionFailure("CODEX", "gpt-requested", null)).toBeNull();
  });
});
