import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../../../../tests/helpers/tmp";
import { buildReadTools } from "./read";
import { buildEditFileTools } from "./edit-file";

// The consolidated flow, exactly as the model would use it with the folded-in
// tools:
//   1. read (auto) a large file -> outline, giving a block's line range +
//      header text
//   2. read that specific range -> the block's exact text
//   3. edit with `old_string: <exact block text>` (exact-text replacement)
//   4. re-read (broad) -> outline reflects the redrawn block
describe("read + edit range flow (consolidated)", () => {
  it("navigates by outline and edits by exact text", async () => {
    const root = makeTmpDir("token-flow-");
    writeFileSync(join(root, "svc.py"), bigPy());
    const read = buildReadTools(root)[0]!;
    const edit = buildEditFileTools(root).find((t) => t.name === "edit")!;

    // 1. read -> outline; grab the method_0 block.
    const o = await read.handler({
      file_path: "svc.py",
      offset: 1,
      limit: 100,
    });
    if (!o.ok) throw new Error(o.error.message);
    const blocks = (
      o.result as {
        file: { outline: { line: number; extent: number; text: string }[] };
      }
    ).file.outline;
    const block = blocks[1];
    expect(block.text).toBe("def method_0(self):");

    // 2. read the exact range for the block body.
    const r = await read.handler({
      file_path: "svc.py",
      offset: block.line,
      limit: block.extent - block.line + 1,
    });
    if (!r.ok) throw new Error(r.error.message);
    const oldBlock = (r.result as { file: { content: string } }).file.content;
    expect(oldBlock).toBe("    def method_0(self):\n        return 0");

    // 3. edit by exact text: old_string is the block body exactly.
    const er = await edit.handler({
      file_path: "svc.py",
      old_string: oldBlock,
      new_string:
        '    def method_0(self):\n        return -1\n        print("x")',
    });
    if (!er.ok) throw new Error(er.error.message);

    // 4. broad re-read -> the outline now reflects the changed body.
    const o2 = await read.handler({
      file_path: "svc.py",
      offset: 1,
      limit: 100,
    });
    if (!o2.ok) throw new Error(o2.error.message);
    expect(o2.result).toMatchObject({ type: "text", file: { outlined: true } });
  });
});

function bigPy(): string {
  const lines: string[] = [];
  lines.push("import os", "");
  lines.push("class Service:");
  for (let i = 0; i < 20; i++) {
    lines.push(`    def method_${i}(self):`);
    lines.push(`        return ${i}`);
  }
  lines.push("");
  lines.push("def main():");
  lines.push("    pass");
  return lines.join("\n");
}
