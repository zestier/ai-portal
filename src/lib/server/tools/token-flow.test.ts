import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTmpDir } from "../../../../tests/helpers/tmp";
import { buildReadTools } from "./read";
import { buildEditFileTools } from "./edit-file";

// The experiment's consolidated flow, exactly as the model would use it with
// the folded-in tools:
//   1. read (auto) a large file -> outline, giving a block's line range +
//      header text
//   2. edit mode:'range' that block by line numbers + header checksum (no
//      old-block echo, no pre-edit whole-file read)
describe("read + edit range flow (consolidated)", () => {
  it("navigates by outline and edits by range", async () => {
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

    // 2. edit range with outline-derived line numbers + header checksum.
    const er = await edit.handler({
      file_path: "svc.py",
      anchor: block.text,
      lines: block.extent - block.line + 1,
      new_string:
        '    def method_0(self):\n        return -1\n        print("x")',
    });
    if (!er.ok) throw new Error(er.error.message);
    expect(er.result).toMatchObject({ shift: { after: block.extent, by: 1 } });
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
