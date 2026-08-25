import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyEditToContent, buildEditFileTools } from "./edit-file";
import { makeTmpDir } from "../../../../tests/helpers/tmp";

function editTool(root: string) {
  return buildEditFileTools(root).find((t) => t.name === "edit")!;
}

describe("applyEditToContent", () => {
  it("replaces exact text and reports line shift", () => {
    const out = applyEditToContent("a\nb\nc", "b", "B", false);
    if (!out.ok) throw new Error(out.reason);
    expect(out.content).toBe("a\nB\nc");
    expect(out.replacedLines).toBe(1);
    expect(out.shift).toEqual({ after: 2, by: 0 });
  });

  it("reports replacedLines and shift for a multi-line exact-text replacement", () => {
    const out = applyEditToContent("a\nb\nc\nd", "b\nc", "X", false);
    if (!out.ok) throw new Error(out.reason);
    expect(out.content).toBe("a\nX\nd");
    expect(out.replacedLines).toBe(2);
    expect(out.shift).toEqual({ after: 3, by: -1 });
  });

  it("reports not_found when old_string is absent", () => {
    const out = applyEditToContent("a\nb\nc", "zzz", "X", false);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("not_found");
  });
});

describe("edit tool", () => {
  it("replaces exact text by default", async () => {
    const root = makeTmpDir("edit-tool-");
    writeFileSync(join(root, "f.txt"), "a\nb\nc");
    const result = await editTool(root).handler({
      file_path: "f.txt",
      old_string: "b",
      new_string: "B",
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("a\nB\nc");
  });

  it("reports replacedLines and shift for a multi-line exact-text replacement", async () => {
    const root = makeTmpDir("edit-tool-");
    writeFileSync(join(root, "f.txt"), "a\nb\nc\nd");
    const result = await editTool(root).handler({
      file_path: "f.txt",
      old_string: "b\nc",
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
      old_string: "x",
      new_string: "y",
    });
    expect(result.ok).toBe(false);
  });
});
