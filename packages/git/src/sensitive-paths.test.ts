import { describe, expect, it } from "vitest";
import { isSensitivePath } from "./sensitive-paths.js";

describe("isSensitivePath", () => {
  it.each([
    [".env"],
    ["nested/dir/.env"],
    [".env.production"],
    ["config/.env.local"],
    ["id_rsa"],
    ["id_ed25519.pub"],
    [".ssh/config"],
    ["home/.ssh/known_hosts"],
    ["server.pem"],
    [".aws/credentials"],
    [".aws/config"],
    ["login.keychain-db"],
    ["Library/Keychains/login.keychain"],
  ])("blocks %s", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    ["README.md"],
    ["src/index.ts"],
    ["environment.ts"],
    ["envelope.txt"],
    [".environment"],
    ["notes/.envrc"],
  ])("lets %s through", (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });
});
