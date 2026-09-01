import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeTmpDir } from "../../helpers/tmp";
import { buildProgramFacadeTools } from "../../../src/lib/server/ptc/facades";

describe("program fs facade capabilities", () => {
  it("derives advertised parameters from runtime schemas", () => {
    for (const tool of buildProgramFacadeTools("/tmp").values()) {
      const parameters = z.toJSONSchema(tool.argsSchema!, {
        io: "input",
      });
      delete parameters.$schema;
      expect(tool.parameters).toEqual(parameters);
    }
  });

  it("filters internal facades by their owning tool group", () => {
    expect([
      ...buildProgramFacadeTools("/tmp", ["filesystem", "git", "shell"]).keys(),
    ]).toEqual([]);
    expect([...buildProgramFacadeTools("/tmp", ["filesystem"]).keys()]).toEqual(
      ["__ptc_git_blame", "__ptc_command_run"],
    );
  });

  it("returns structured directory and stat data", async () => {
    const root = makeTmpDir("ptc-fs-");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "a.txt"), "hello");
    await symlink("a.txt", join(root, "src", "link.txt"));
    const tools = buildProgramFacadeTools(root);

    const listed = await tools
      .get("__ptc_fs_readdir")!
      .handler({ path: join(root, "src") });
    expect(listed).toMatchObject({
      ok: true,
      result: ["a.txt", "link.txt"],
    });
    const dirents = await tools.get("__ptc_fs_readdir")!.handler({
      path: join(root, "src"),
      withFileTypes: true,
    });
    expect(dirents).toMatchObject({
      ok: true,
      result: [
        { name: "a.txt", file: true, directory: false, symbolicLink: false },
        { name: "link.txt", file: false, directory: false, symbolicLink: true },
      ],
    });

    const file = await tools.get("__ptc_fs_stat")!.handler({
      path: join(root, "src", "a.txt"),
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

  it("rejects oversized directory listings with glob guidance", async () => {
    const root = makeTmpDir("ptc-fs-large-dir-");
    const directory = join(root, "large");
    await mkdir(directory);
    await Promise.all(
      Array.from({ length: 1_001 }, (_, index) =>
        writeFile(join(directory, `${index}.txt`), ""),
      ),
    );

    const result = await buildProgramFacadeTools(root)
      .get("__ptc_fs_readdir")!
      .handler({ path: directory });

    expect(result).toMatchObject({
      ok: false,
      error: {
        message: expect.stringContaining("limit 1000"),
      },
    });
    expect(result).toMatchObject({
      error: { message: expect.stringContaining("Use fs.glob") },
    });
  });

  it("supports ripgrep ignores, explicit ignored trees, and bounded depth", async () => {
    const root = makeTmpDir("ptc-fs-glob-");
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, ".git", "objects"), { recursive: true });
    await mkdir(join(root, ".generated", "fixture", ".git"), {
      recursive: true,
    });
    await writeFile(join(root, ".gitignore"), "node_modules/\n.generated/\n");
    await writeFile(join(root, "src", "top.ts"), "");
    await writeFile(join(root, "src", "component.svelte"), "");
    await writeFile(join(root, "src", "nested", "deep.ts"), "");
    await writeFile(join(root, "node_modules", "pkg", "index.ts"), "");
    await writeFile(join(root, ".git", "objects", "ignored.ts"), "");
    await writeFile(join(root, ".generated", "fixture", "generated.ts"), "");
    await writeFile(join(root, ".generated", "fixture", ".git", "HEAD"), "");
    const glob = buildProgramFacadeTools(root).get("__ptc_fs_glob")!;

    await expect(glob.handler({ pattern: "*.ts" })).resolves.toMatchObject({
      ok: true,
      result: ["src/nested/deep.ts", "src/top.ts"],
    });
    await expect(glob.handler({ pattern: "**/*" })).resolves.toMatchObject({
      ok: true,
      result: expect.not.arrayContaining([
        ".generated/fixture/.git/HEAD",
        ".generated/fixture/generated.ts",
      ]),
    });
    await expect(
      glob.handler({ pattern: "*.ts", path: "src", maxDepth: 1 }),
    ).resolves.toMatchObject({
      ok: true,
      result: ["src/top.ts"],
    });
    await expect(
      glob.handler({ pattern: ["*.ts", "*.svelte"], path: "src" }),
    ).resolves.toMatchObject({
      ok: true,
      result: ["src/component.svelte", "src/nested/deep.ts", "src/top.ts"],
    });
    await expect(
      glob.handler({ pattern: "*.ts", includeIgnored: true }),
    ).resolves.toMatchObject({
      ok: true,
      result: ["node_modules/pkg/index.ts", "src/nested/deep.ts", "src/top.ts"],
    });
  });

  it("returns complete structured grep matches for multiple globs", async () => {
    const root = makeTmpDir("ptc-fs-grep-");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "one.ts"), "first needle\n");
    await writeFile(join(root, "src", "two.svelte"), "second needle\n");
    await writeFile(join(root, "src", "skip.txt"), "third needle\n");
    const grep = buildProgramFacadeTools(root).get("__ptc_fs_grep")!;

    await expect(
      grep.handler({
        pattern: "needle",
        path: "src",
        glob: ["*.ts", "*.svelte"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: [
        { path: "src/one.ts", line: 1, column: 7, text: "first needle" },
        {
          path: "src/two.svelte",
          line: 1,
          column: 8,
          text: "second needle",
        },
      ],
    });
  });

  it("derives read permissions for workspace and outside paths", async () => {
    const root = makeTmpDir("ptc-fs-permission-");
    const tools = buildProgramFacadeTools(root);
    const stat = tools.get("__ptc_fs_stat")!;
    expect(
      tools.get("__ptc_fs_glob")!.derivePermissionRequest?.({ pattern: "*" }),
    ).toEqual({ permissionKind: "read", path: root });
    expect(
      tools.get("__ptc_fs_grep")!.derivePermissionRequest?.({
        pattern: "needle",
      }),
    ).toEqual({ permissionKind: "read", path: root });
    expect(stat.derivePermissionRequest?.({ path: "src/a.ts" })).toEqual({
      permissionKind: "read",
      path: join(root, "src", "a.ts"),
    });
    expect(
      stat.derivePermissionRequest?.({ path: join(root, "src", "a.ts") }),
    ).toEqual({
      permissionKind: "read",
      path: join(root, "src", "a.ts"),
    });
    const outside = makeTmpDir("ptc-fs-outside-");
    await writeFile(join(outside, "granted.txt"), "outside");
    expect(
      await stat.handler({ path: join(outside, "granted.txt") }),
    ).toMatchObject({ ok: true, result: { file: true, size: 7 } });
    expect(
      stat.derivePermissionRequest?.({ path: join(outside, "granted.txt") }),
    ).toEqual({
      permissionKind: "read",
      path: join(outside, "granted.txt"),
    });
    expect(stat.derivePermissionRequest?.({ path: "../outside" })).toEqual({
      permissionKind: "read",
      path: join(root, "..", "outside"),
    });
  });

  it("removes files and recursive directories through reversible trash", async () => {
    const root = makeTmpDir("ptc-fs-remove-");
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "file.txt"), "hello");
    const remove = buildProgramFacadeTools(root).get("__ptc_fs_rm")!;

    expect(remove.derivePermissionRequest?.({ path: "file.txt" })).toEqual({
      permissionKind: "write",
      path: join(root, "file.txt"),
    });
    await expect(remove.handler({ path: "dir" })).resolves.toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("recursive: true") },
    });
    await expect(
      remove.handler({ path: "file.txt", unlink: true }),
    ).resolves.toMatchObject({ ok: true });
    await expect(access(join(root, "file.txt"))).rejects.toThrow();
    await expect(
      remove.handler({ path: "dir", recursive: true }),
    ).resolves.toMatchObject({ ok: true });
    await expect(access(join(root, "dir"))).rejects.toThrow();
    await expect(
      remove.handler({ path: "missing", force: true }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("returns bounded structured Git blame lines", async () => {
    const root = makeTmpDir("ptc-git-blame-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Proc Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "proc@example.com"], {
      cwd: root,
    });
    await writeFile(join(root, "source.ts"), "one\ntwo\nthree\n");
    execFileSync("git", ["add", "source.ts"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "add source"], { cwd: root });
    const blame = buildProgramFacadeTools(root).get("__ptc_git_blame")!;

    expect(
      blame.derivePermissionRequest?.({
        path: "source.ts",
        startLine: 2,
        endLine: 3,
      }),
    ).toEqual({ permissionKind: "read", path: join(root, "source.ts") });
    await expect(
      blame.handler({ path: "source.ts", startLine: 2, endLine: 3 }),
    ).resolves.toMatchObject({
      ok: true,
      result: [
        { author: "Proc Test", line: 2, text: "two" },
        { author: "Proc Test", line: 3, text: "three" },
      ],
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
        status: 0,
        stdout: JSON.stringify({
          value: "piped input",
          arg: "literal;not-shell",
        }),
        stderr: "",
      },
    });
  });

  it("returns stdout and stderr for nonzero command exits", async () => {
    const root = makeTmpDir("ptc-command-fail-");
    const command = buildProgramFacadeTools(root).get("__ptc_command_run")!;
    expect(
      await command.handler({
        executable: process.execPath,
        args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
      }),
    ).toMatchObject({
      ok: true,
      result: { status: 7, stdout: "", stderr: "bad" },
    });
  });

  it("returns command output larger than the direct tool limit", async () => {
    const root = makeTmpDir("ptc-command-output-");
    const command = buildProgramFacadeTools(root).get("__ptc_command_run")!;
    const outputBytes = 96 * 1024;
    const result = await command.handler({
      executable: process.execPath,
      args: ["-e", `process.stdout.write("x".repeat(${outputBytes}))`],
    });
    expect(result).toMatchObject({
      ok: true,
      result: { status: 0, stderr: "" },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(
      Buffer.byteLength((result.result as { stdout: string }).stdout),
    ).toBe(outputBytes);
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
      result: { status: 0, stdout: "quoted value", stderr: "" },
    });
    expect(
      await command.handler({ command: "printf hi | sort" }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("no shell operators") },
    });
  });
});
