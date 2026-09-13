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

  it.each([
    "GITHUB_TOKEN",
    "NPM_AUTH_TOKEN",
    "DB_PASSWORD",
    "SERVICE_CLIENT_SECRET",
    "SESSION_COOKIE",
    "DATABASE_CONNECTION_STRING",
  ])("rejects additional credential-shaped override %s", (key) => {
    expect(() => sanitizeEnvironment({ [key]: "must-not-leak" }, {})).toThrow(UnsafeEnvironmentError);
  });

  it.each(["HOME", "PATH", "CODEX_HOME", "XDG_CONFIG_HOME", "TMPDIR"])(
    "does not let a run redirect trusted process location %s",
    (key) => {
      expect(() => sanitizeEnvironment({ [key]: "/tmp/untrusted" }, { [key]: "/trusted" })).toThrow(
        /trusted server process/,
      );
    },
  );

  it("rejects null bytes in otherwise allowed overrides", () => {
    expect(() => sanitizeEnvironment({ LANG: "en_US\0.UTF-8" }, {})).toThrow(/null byte/);
  });
});
