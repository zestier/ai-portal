import { describe, it, expect } from "vitest";
import { computeOutline, renderOutline } from "./outline";

describe("computeOutline (pure-indent, no keyword list)", () => {
  it("finds block headers at depth 0 and 1, filters depth-2 control flow", () => {
    const o = computeOutline(
      [
        "class Foo:",
        "    def bar(self):",
        "        if x:",
        "            pass",
        "    def baz(self):",
        "        return 1",
        "",
        "def top():",
        "    pass",
      ].join("\n"),
    );
    expect(o.format).toBe("normal");
    expect(o.blocks).toEqual([
      { line: 1, depth: 0, text: "class Foo:", extent: 7 },
      { line: 2, depth: 1, text: "def bar(self):", extent: 4 },
      { line: 5, depth: 1, text: "def baz(self):", extent: 7 },
      { line: 8, depth: 0, text: "def top():", extent: 9 },
    ]);
  });

  it("merges an Allman `{`-only opener into the declaration above it", () => {
    const o = computeOutline(["int f()", "{", "    return 1;", "}"].join("\n"));
    expect(o.blocks).toEqual([
      { line: 1, depth: 0, text: "int f() {", extent: 3 },
    ]);
  });

  it("skips multi-line signature continuation headers", () => {
    const o = computeOutline(
      [
        "export function foo(",
        "\targ: string,",
        "): Promise<string> {",
        "\treturn arg;",
        "}",
      ].join("\n"),
    );
    expect(o.format).toBe("normal");
    // `): Promise<string> {` is a continuation, not a block of its own; the
    // function block's extent closes where the continuation dedents.
    expect(o.blocks).toEqual([
      { line: 1, depth: 0, text: "export function foo(", extent: 2 },
    ]);
  });

  it("reports flat files (single indent level) as format flat", () => {
    const o = computeOutline("a\nb\nc\nd");
    expect(o.format).toBe("flat");
    expect(o.blocks).toEqual([]);
  });

  it("reports minified files (a line over the cap) as format minified", () => {
    const o = computeOutline(`let x = '${"y".repeat(2500)}';\nfoo(x);`);
    expect(o.format).toBe("minified");
    expect(o.blocks).toEqual([]);
  });
});

describe("renderOutline (dedup, top-level only)", () => {
  const src = [
    "export function a(): void {",
    "  for (let i = 0; i < 10; i++) {",
    "    work(i);",
    "  }",
    "}",
    "",
    "export function b(): void {",
    "  return 1;",
    "}",
    "",
    "export function c(): void {",
    "  return 2;",
    "}",
  ].join("\n");

  it("lists top-level blocks only and drops any block already in the tail body", () => {
    const text = renderOutline(computeOutline(src));
    // Small file: header (1-13) echoes the whole file, so scope the checks
    // to the block index — the section between the two markers.
    const blocksSection = text
      .split("blocks (top-level")[1]!
      .split("tail (")[0];
    expect(blocksSection).toContain("export function a(): void {");
    expect(blocksSection).not.toContain("for (let i = 0"); // nested child not listed
    expect(blocksSection).not.toContain("export function b(): void {"); // tail region, not listed twice
    expect(text).toContain("export function b(): void {"); // still in the tail body
    expect(text).toContain("Outline only"); // single drill-in instruction
  });
});
