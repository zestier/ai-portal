import { describe, it, expect } from "vitest";
import {
  MAX_RENDERABLE_DIFF_CHARS,
  isRenderableDiff,
  parseUnifiedDiff,
  diffStats,
} from "../../src/lib/client/diff-parser";

const SAMPLE = `diff --git a/a.txt b/a.txt
index 0000001..0000002 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,4 @@
 line1
-line2
+line2b
+inserted
 line3
`;

describe("parseUnifiedDiff", () => {
  it("emits meta lines before the first hunk", () => {
    const rows = parseUnifiedDiff(SAMPLE);
    const meta = rows.filter((r) => r.kind === "meta").map((r) => r.text);
    expect(meta[0]).toMatch(/^diff --git/);
    expect(meta).toContain("--- a/a.txt");
    expect(meta).toContain("+++ b/a.txt");
  });

  it("parses the hunk header and assigns line numbers", () => {
    const rows = parseUnifiedDiff(SAMPLE);
    const body = rows.filter((r) => r.kind !== "meta" && r.kind !== "hunk");
    // Expected sequence: context, del, add, add, context.
    expect(body.map((r) => r.kind)).toEqual([
      "context",
      "del",
      "add",
      "add",
      "context",
    ]);

    // First context line: old=1, new=1.
    expect(body[0]).toMatchObject({
      kind: "context",
      oldNo: 1,
      newNo: 1,
      text: "line1",
    });
    // Deletion of original line 2 (no new number).
    expect(body[1]).toMatchObject({
      kind: "del",
      oldNo: 2,
      newNo: null,
      text: "line2",
    });
    // Two additions get new line numbers 2 and 3.
    expect(body[2]).toMatchObject({
      kind: "add",
      oldNo: null,
      newNo: 2,
      text: "line2b",
    });
    expect(body[3]).toMatchObject({
      kind: "add",
      oldNo: null,
      newNo: 3,
      text: "inserted",
    });
    // Trailing context: old advanced past the deletion, new advanced past adds.
    expect(body[4]).toMatchObject({
      kind: "context",
      oldNo: 3,
      newNo: 4,
      text: "line3",
    });
  });

  it("counts adds and removes", () => {
    const stats = diffStats(parseUnifiedDiff(SAMPLE));
    expect(stats).toEqual({ added: 2, removed: 1 });
  });

  it('handles "\\ No newline at end of file" markers', () => {
    const d = `--- a/x
+++ b/x
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`;
    const rows = parseUnifiedDiff(d);
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain("nonewline");
    expect(kinds.filter((k) => k === "nonewline").length).toBe(2);
  });

  it("handles multiple hunks with independent line numbering", () => {
    const d = `--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 a
-b
+B
@@ -10,2 +10,3 @@
 j
+k
 l
`;
    const rows = parseUnifiedDiff(d);
    const body = rows.filter((r) => r.kind !== "meta" && r.kind !== "hunk");
    // First hunk
    expect(body[0]).toMatchObject({ kind: "context", oldNo: 1, newNo: 1 });
    expect(body[1]).toMatchObject({ kind: "del", oldNo: 2, newNo: null });
    expect(body[2]).toMatchObject({ kind: "add", oldNo: null, newNo: 2 });
    // Second hunk resets numbering to 10/10.
    expect(body[3]).toMatchObject({ kind: "context", oldNo: 10, newNo: 10 });
    expect(body[4]).toMatchObject({ kind: "add", oldNo: null, newNo: 11 });
    expect(body[5]).toMatchObject({ kind: "context", oldNo: 11, newNo: 12 });
  });

  it("returns empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("treats lines before any hunk as meta even without leading space", () => {
    const d = `diff --git a/x b/x
Binary files a/x and b/x differ
`;
    const rows = parseUnifiedDiff(d);
    expect(rows.every((r) => r.kind === "meta")).toBe(true);
  });

  it("bounds diffs that are safe for eager rendering", () => {
    expect(isRenderableDiff("x".repeat(MAX_RENDERABLE_DIFF_CHARS))).toBe(true);
    expect(isRenderableDiff("x".repeat(MAX_RENDERABLE_DIFF_CHARS + 1))).toBe(
      false,
    );
  });
});
