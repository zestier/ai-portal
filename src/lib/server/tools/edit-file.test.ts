import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEditToContent, buildEditFileTools } from "./edit-file";
import { makeTmpDir } from "../../../../tests/helpers/tmp";

function editTool(root: string) {
  return buildEditFileTools(root).find((t) => t.name === "edit")!;
}

describe("applyEditToContent", () => {
  it("replaces just the anchor text when lines is omitted (exact)", () => {
    const out = applyEditToContent("a\nb\nc", "b", "B", false);
    if (!out.ok) throw new Error(out.reason);
    expect(out.content).toBe("a\nB\nc");
    expect(out.shift).toBeUndefined();
  });

  it("extends the anchor to whole lines and reports the shift", () => {
    const out = applyEditToContent("a\nb\nc\nd\ne", "b", "X\nY\nZ", false, 3);
    if (!out.ok) throw new Error(out.reason);
    expect(out.content).toBe("a\nX\nY\nZ\ne");
    expect(out.replacedLines).toBe(3);
    expect(out.shift).toEqual({ after: 4, by: 0 });
  });

  it("lines:1 replaces the whole anchor line", () => {
    const out = applyEditToContent("a\nb\nc", "b", "B", false, 1);
    if (!out.ok) throw new Error(out.reason);
    expect(out.content).toBe("a\nB\nc");
    expect(out.shift).toEqual({ after: 2, by: 0 });
  });

  it("clamps lines to at least the anchor span", () => {
    // anchor spans 2 lines; lines:1 is bumped to 2
    const out = applyEditToContent("a\nb\nc\nd", "b\nc", "X\nY", false, 1);
    if (!out.ok) throw new Error(out.reason);
    expect(out.content).toBe("a\nX\nY\nd");
    expect(out.shift).toEqual({ after: 3, by: 0 });
  });

  it("reports not_found when the anchor is absent", () => {
    const out = applyEditToContent("a\nb\nc", "zzz", "X", false, 2);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("not_found");
  });
});

describe("edit tool", () => {
  it("replaces just the anchor text by default", async () => {
    const root = makeTmpDir("edit-tool-");
    writeFileSync(join(root, "f.txt"), "a\nb\nc");
    const result = await editTool(root).handler({
      file_path: "f.txt",
      anchor: "b",
      new_string: "B",
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("a\nB\nc");
  });

  it("lines replaces a whole block and reports the diff + shift", async () => {
    const root = makeTmpDir("edit-tool-");
    writeFileSync(join(root, "f.txt"), "a\nb\nc\nd");
    const result = await editTool(root).handler({
      file_path: "f.txt",
      anchor: "b",
      lines: 2,
      new_string: "X\nY\nZ",
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("a\nX\nY\nZ\nd");
    expect(result.result).toMatchObject({
      replacedLines: 2,
      shift: { after: 3, by: 1 },
    });
  });

  it("errors on a missing file", async () => {
    const root = makeTmpDir("edit-tool-");
    const result = await editTool(root).handler({
      file_path: "nope.txt",
      anchor: "x",
      new_string: "y",
    });
    expect(result.ok).toBe(false);
  });
});
