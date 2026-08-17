import { describe, expect, test } from "vitest";
import {
  formatReviewMessage,
  lineKey,
  type ReviewComment,
} from "../../src/lib/client/review-format";

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    path: "src/app.ts",
    side: "new",
    lineNo: 10,
    lineText: "const x = 1;",
    body: "Use a const enum here.",
    ...over,
  };
}

describe("lineKey", () => {
  test("distinguishes side, line, path and sha", () => {
    const base = { path: "a.ts", side: "new" as const, lineNo: 1, sha: null };
    expect(lineKey(base)).toBe(lineKey({ ...base }));
    expect(lineKey(base)).not.toBe(lineKey({ ...base, side: "old" }));
    expect(lineKey(base)).not.toBe(lineKey({ ...base, lineNo: 2 }));
    expect(lineKey(base)).not.toBe(lineKey({ ...base, path: "b.ts" }));
    expect(lineKey(base)).not.toBe(lineKey({ ...base, sha: "deadbeef" }));
  });

  test("null line number does not collide with line 0-prefixes", () => {
    const a = lineKey({ path: "a.ts", side: "file", lineNo: null, sha: null });
    const b = lineKey({ path: "a.ts", side: "file", lineNo: 1, sha: null });
    expect(a).not.toBe(b);
  });
});

describe("formatReviewMessage", () => {
  test("returns empty string for no comments", () => {
    expect(formatReviewMessage([])).toBe("");
  });

  test("summarises a single comment with its line and code", () => {
    const msg = formatReviewMessage([comment()]);
    expect(msg).toContain("1 comment");
    expect(msg).toContain("### `src/app.ts`");
    expect(msg).toContain("**line 10**");
    expect(msg).toContain("`const x = 1;`");
    expect(msg).toContain("Use a const enum here.");
  });

  test("groups by file and orders by line number", () => {
    const msg = formatReviewMessage([
      comment({ id: "a", path: "b.ts", lineNo: 30, body: "b30" }),
      comment({ id: "b", path: "a.ts", lineNo: 20, body: "a20" }),
      comment({ id: "c", path: "a.ts", lineNo: 5, body: "a5" }),
    ]);
    const aHeading = msg.indexOf("### `a.ts`");
    const bHeading = msg.indexOf("### `b.ts`");
    expect(aHeading).toBeGreaterThanOrEqual(0);
    // Files appear in the order their first comment was added (b.ts first).
    expect(bHeading).toBeGreaterThanOrEqual(0);
    expect(bHeading).toBeLessThan(aHeading);
    // Within a.ts, line 5 precedes line 20.
    expect(msg.indexOf("a5")).toBeLessThan(msg.indexOf("a20"));
    expect(msg).toContain("3 comments");
  });

  test("labels old-side comments and includes commit sha in heading", () => {
    const msg = formatReviewMessage([
      comment({
        side: "old",
        lineNo: 7,
        sha: "abcdef1234",
        body: "removed line note",
      }),
    ]);
    expect(msg).toContain("old line 7");
    expect(msg).toContain("commit abcdef12");
  });

  test("handles general (no line) comments", () => {
    const msg = formatReviewMessage([
      comment({ lineNo: null, body: "overall structure" }),
    ]);
    expect(msg).toContain("**general**");
    expect(msg).toContain("overall structure");
  });

  test("keeps multi-line comment bodies indented", () => {
    const msg = formatReviewMessage([comment({ body: "line one\nline two" })]);
    expect(msg).toContain("  line one");
    expect(msg).toContain("  line two");
  });

  test("truncates very long code lines", () => {
    const long = "x".repeat(500);
    const msg = formatReviewMessage([comment({ lineText: long })]);
    expect(msg).toContain("…");
    expect(msg).not.toContain(long);
  });
});
