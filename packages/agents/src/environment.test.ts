import { describe, expect, it } from "vitest";
import { sanitizeEnvironment, UnsafeEnvironmentError } from "./environment.js";

describe("sanitizeEnvironment", () => {
  it("keeps only explicitly allowed non-secret variables", () => {
    const result = sanitizeEnvironment({ LANG: "en_US.UTF-8" }, {
      HOME: "/tmp/home",
      PATH: "/usr/bin",
      AWS_SECRET_ACCESS_KEY: "must-not-leak",
    });

    expect(result).toMatchObject({ HOME: "/tmp/home", PATH: "/usr/bin", LANG: "en_US.UTF-8", NO_COLOR: "1" });
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("rejects credential-like overrides", () => {
    expect(() => sanitizeEnvironment({ OPENAI_API_KEY: "secret" }, {})).toThrow(UnsafeEnvironmentError);
  });
});

