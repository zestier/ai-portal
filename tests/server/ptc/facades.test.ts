import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "../../helpers/tmp";
import { buildProgramFacadeTools } from "../../../src/lib/server/ptc/facades";

describe("program fs facade capabilities", () => {
  it("returns structured directory and stat data", async () => {
    const root = makeTmpDir("ptc-fs-");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "hello");
    await symlink("a.txt", join(root, "src", "link.txt"));
    const tools = buildProgramFacadeTools(root);

    const listed = await tools
      .get("__ptc_fs_readdir")!
      .handler({ path: "src" });
    expect(listed).toMatchObject({
      ok: true,
      result: ["a.txt", "link.txt"],
    });

    const file = await tools.get("__ptc_fs_stat")!.handler({
      path: "src/a.txt",
    });
    expect(file).toMatchObject({
      ok: true,
      result: {
        size: 5,
        file: true,
        directory: false,
        symbolicLink: false,
      },
    });

    const link = await tools.get("__ptc_fs_stat")!.handler({
      path: "src/link.txt",
    });
    expect(link).toMatchObject({
      ok: true,
      result: { symbolicLink: true },
    });
  });

  it("derives read permissions and rejects workspace escapes", async () => {
    const root = makeTmpDir("ptc-fs-permission-");
    const tools = buildProgramFacadeTools(root);
    const stat = tools.get("__ptc_fs_stat")!;
    expect(stat.derivePermissionRequest?.({ path: "src/a.ts" })).toEqual({
      permissionKind: "read",
      path: join(root, "src", "a.ts"),
    });
    expect(await stat.handler({ path: "../outside" })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("escapes the workspace") },
    });
  });

  it("runs argv commands with bounded stdin and no shell interpretation", async () => {
    const root = makeTmpDir("ptc-command-");
    const command = buildProgramFacadeTools(root).get("__ptc_command_run")!;
    const result = await command.handler({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdin.setEncoding('utf8'); let value = ''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ value, arg: process.argv[1] })));",
        "literal;not-shell",
      ],
      stdin: "piped input",
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        stdout: JSON.stringify({
          value: "piped input",
          arg: "literal;not-shell",
        }),
        stderr: "",
      },
    });
  });

  it("rejects nonzero command exits", async () => {
    const root = makeTmpDir("ptc-command-fail-");
    const command = buildProgramFacadeTools(root).get("__ptc_command_run")!;
    expect(
      await command.handler({
        executable: process.execPath,
        args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
      }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("code 7: bad") },
    });
  });

  it("parses one command-line string but rejects shell operators", async () => {
    const root = makeTmpDir("ptc-command-line-");
    const command = buildProgramFacadeTools(root).get("__ptc_command_run")!;
    expect(
      await command.handler({
        command: `printf %s "quoted value"`,
      }),
    ).toMatchObject({
      ok: true,
      result: { stdout: "quoted value", stderr: "" },
    });
    expect(
      await command.handler({ command: "printf hi | sort" }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("without shell operators") },
    });
  });
});
