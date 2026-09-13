import { describe, expect, it } from "vitest";
import { parseChangedFiles } from "./pre-pr-report.js";

describe("parseChangedFiles", () => {
  it("extracts changed paths from diff --git headers", () => {
    const diff = [
      "diff --git a/src/foo.ts b/src/foo.ts",
      "index 1111111..2222222 100644",
      "--- a/src/foo.ts",
      "+++ b/src/foo.ts",
      "@@ -1,1 +1,2 @@",
      " existing line",
      "+added line",
    ].join("\n");
    expect(parseChangedFiles(diff)).toEqual(["src/foo.ts"]);
  });

  it("extracts a brand-new file from the +++ header when there is no a/ side", () => {
    const diff = [
      "diff --git a/feature.txt b/feature.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/feature.txt",
      "@@ -0,0 +1,1 @@",
      "+new content",
    ].join("\n");
    expect(parseChangedFiles(diff)).toEqual(["feature.txt"]);
  });

  it("dedupes and sorts across multiple files, and ignores unrelated lines", () => {
    const diff = [
      "diff --git a/b.ts b/b.ts",
      "+++ b/b.ts",
      "diff --git a/a.ts b/a.ts",
      "+++ b/a.ts",
      "some unrelated context line",
    ].join("\n");
    expect(parseChangedFiles(diff)).toEqual(["a.ts", "b.ts"]);
  });

  it("returns an empty list for an empty or whitespace-only diff", () => {
    expect(parseChangedFiles("")).toEqual([]);
    expect(parseChangedFiles("\n\n")).toEqual([]);
  });
});
