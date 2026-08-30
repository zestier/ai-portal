import { describe, expect, it } from "vitest";
import { ok, type PortalTool } from "../../../src/lib/server/tools/types";
import { runProgram } from "../../../src/lib/server/ptc/program";

const echo: PortalTool = {
  name: "echo",
  description: "Echo a value.",
  parameters: {},
  async handler(args) {
    return ok(args);
  },
};

describe("program runtime", () => {
  it("does not block the main event loop during guest CPU work", async () => {
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 20);

    const result = await runProgram({
      source:
        "const until = Date.now() + 150; while (Date.now() < until) {} return 'done';",
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });

    clearTimeout(timer);
    expect(result.value).toBe("done");
    expect(timerFired).toBe(true);
  });

  it("composes capability calls and returns JSON", async () => {
    const result = await runProgram({
      source: "const first = tools.echo({ value: 2 }); return first.value + 1;",
      capabilities: new Map([[echo.name, echo]]),
      execute: (_name, args) => echo.handler(args),
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      value: 3,
      operations: 1,
      trace: {
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        calls: [
          {
            name: "echo",
            kind: "tool",
            argsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            ok: true,
          },
        ],
        durationMs: expect.any(Number),
      },
    });
  });

  it("returns the completion value of the final expression", async () => {
    const commandTool = tool("__ptc_command_run");
    const result = await runProgram({
      source: `
        const res = command.run("pnpm", ["lint"], { timeoutMs: 120000 });
        const output = "EXIT STATUS: " + res.status + "\\n\\nSTDOUT:\\n" + res.stdout + "\\n\\nSTDERR:\\n" + res.stderr;
        output;
      `,
      capabilities: new Map(),
      facadeCapabilities: new Map([[commandTool.name, commandTool]]),
      execute: async () => ok({ status: 0, stdout: "checked", stderr: "" }),
      signal: new AbortController().signal,
    });
    expect(result.value).toBe(
      "EXIT STATUS: 0\n\nSTDOUT:\nchecked\n\nSTDERR:\n",
    );
    expect(result.operations).toBe(1);
  });

  it("returns a standalone introspection expression", async () => {
    const result = await runProgram({
      source: 'typeof command + " " + typeof globalThis.fs;',
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });
    expect(result.value).toBe("function object");
  });

  it("reports explicit-return runtime errors at user source locations", async () => {
    const run = runProgram({
      source: "return (\nmissingValue\n);",
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });

    await expect(run).rejects.toMatchObject({
      name: "ReferenceError",
      stack: expect.stringContaining("program.js:2:1"),
    });
    await expect(run).rejects.not.toMatchObject({
      stack: expect.stringContaining("program.js:3:1"),
    });
  });

  it("reports implicit-return runtime errors at user source locations", async () => {
    const run = runProgram({
      source: "const present = true;\nmissingValue;",
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });

    await expect(run).rejects.toMatchObject({
      name: "ReferenceError",
      stack: expect.stringContaining("program.js:2:1"),
    });
    await expect(run).rejects.not.toMatchObject({
      stack: expect.stringContaining("program.js:3:1"),
    });
  });

  it("reports explicit-return syntax errors at user source locations", async () => {
    const run = runProgram({
      source: "return {;",
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });

    await expect(run).rejects.toMatchObject({
      name: "SyntaxError",
      lineNumber: 1,
      stack: expect.stringContaining("program.js:1:9"),
    });
  });

  it("does not normalize user-authored exception locations", async () => {
    const run = runProgram({
      source: `throw {
        message: "custom",
        lineNumber: 99,
        stack: "custom program.js:77:8"
      };`,
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });

    await expect(run).rejects.toMatchObject({
      lineNumber: 99,
      stack: expect.stringContaining("custom program.js:77:8"),
    });
  });

  it("lazily composes and caches immutable saved values", async () => {
    const fetched: string[] = [];
    const values = new Map<string, unknown>([
      [
        "RES_rows",
        [
          { path: "src/a.ts", line: 10 },
          { path: "src/b.ts", line: 20 },
        ],
      ],
      ["RES_unused", { large: "unused".repeat(10_000) }],
    ]);
    const result = await runProgram({
      source: `
        const rows = loadValue("RES_rows");
        const sameRows = loadValue("RES_rows");
        try { rows[0].line = 99; } catch {}
        return {
          same: rows === sameRows,
          rows: rows.map(({ path, line }) => ({ path, start: line - 2, end: line + 2 }))
        };
      `,
      savedValues: {
        get(id) {
          fetched.push(id);
          return values.get(id);
        },
      },
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });
    expect(result.value).toEqual({
      same: true,
      rows: [
        { path: "src/a.ts", start: 8, end: 12 },
        { path: "src/b.ts", start: 18, end: 22 },
      ],
    });
    expect(fetched).toEqual(["RES_rows"]);
  });

  it("reports unknown value ids", async () => {
    await expect(
      runProgram({
        source: 'return loadValue("RES_missing");',
        savedValues: new Map(),
        capabilities: new Map(),
        execute: async () => ok(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Unknown saved value: RES_missing");
  });

  it("loads saved values larger than the capability result limit", async () => {
    const text = "x".repeat(128 * 1024);
    const result = await runProgram({
      source: 'return loadValue("RES_large").text.length;',
      savedValues: new Map([["RES_large", { text }]]),
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });
    expect(result.value).toBe(text.length);
  });

  it("returns actionable unknown-tool failures without dispatching", async () => {
    let dispatched = false;
    const run = runProgram({
      source: "return tools.ech({ value: 2 });",
      capabilities: new Map([[echo.name, echo]]),
      execute: async () => {
        dispatched = true;
        return ok();
      },
      signal: new AbortController().signal,
    });
    await expect(run).rejects.toThrow(/Similar: echo/);
    expect(dispatched).toBe(false);
  });

  it("allows declared reads beyond the mutation budget", async () => {
    const readEcho: PortalTool = {
      ...echo,
      program: {
        catalogDescription: "read a value",
        operationCategory: "read",
        resultSchema: {},
        example: "tools.echo({ value: 1 })",
        contractVersion: "1",
      },
    };
    const result = await runProgram({
      source:
        "let total = 0; for (let index = 0; index < 250; index++) total += tools.echo({ value: 1 }).value; return total;",
      capabilities: new Map([[readEcho.name, readEcho]]),
      execute: (_name, args) => readEcho.handler(args),
      signal: new AbortController().signal,
    });
    expect(result.value).toBe(250);
    expect(result.operations).toBe(250);
    expect(result.trace.calls).toHaveLength(250);
  });

  it("bounds total read operations and recommends fused search", async () => {
    const readEcho: PortalTool = {
      ...echo,
      program: {
        catalogDescription: "read a value",
        operationCategory: "read",
        resultSchema: {},
        example: "tools.echo({ value: 1 })",
        contractVersion: "1",
      },
    };
    await expect(
      runProgram({
        source:
          "for (let index = 0; index < 1001; index++) tools.echo({ value: index }); return 'done';",
        capabilities: new Map([[readEcho.name, readEcho]]),
        execute: (_name, args) => readEcho.handler(args),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("1000 operations max");
  });

  it("charges undeclared operations to the mutation budget", async () => {
    await expect(
      runProgram({
        source:
          "for (let index = 0; index < 501; index++) tools.echo({ value: index }); return 'done';",
        capabilities: new Map([[echo.name, echo]]),
        execute: (_name, args) => echo.handler(args),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("mutation operations: limit 500");
  });

  it("bounds command operations independently from reads", async () => {
    const command = tool("__ptc_command_run");
    await expect(
      runProgram({
        source:
          'for (let index = 0; index < 21; index++) command.run("echo", ["ok"]); return "done";',
        capabilities: new Map(),
        facadeCapabilities: new Map([[command.name, command]]),
        execute: (_name, args) => command.handler(args),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("command operations: limit 20");
  });

  it("does not expose ambient process APIs", async () => {
    const result = await runProgram({
      source:
        "return { processType: typeof process, requireType: typeof require };",
      capabilities: new Map([[echo.name, echo]]),
      execute: (_name, args) => echo.handler(args),
      signal: new AbortController().signal,
    });
    expect(result.value).toEqual({
      processType: "undefined",
      requireType: "function",
    });
  });

  it("provides predeclared POSIX path helpers without module loading", async () => {
    const result = await runProgram({
      source: `const { extname } = path; return {
        joined: path.join("src", "lib", "..", "routes", "page.ts"),
        directory: path.dirname("src/routes/page.ts"),
        base: path.basename("src/routes/page.test.ts", ".ts"),
        extension: extname("src/routes/page.test.ts"),
        normalized: path.normalize("src//routes/../lib/./file.ts"),
        relative: path.relative("src/lib", "tests/server"),
        absolute: path.isAbsolute("/tmp/file")
      };`,
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });
    expect(result.value).toEqual({
      joined: "src/routes/page.ts",
      directory: "src/routes",
      base: "page.test",
      extension: ".ts",
      normalized: "src/lib/file.ts",
      relative: "../../tests/server",
      absolute: true,
    });
  });

  it("resolves CommonJS spellings to the predeclared facades", async () => {
    const result = await runProgram({
      source: `const requiredFs = require("fs");
        const requiredPath = require("node:path");
        return {
          fs: requiredFs === fs && require("node:fs") === fs,
          path: requiredPath === path && require("path") === path,
          joined: requiredPath.join("src", "..", "tests")
        };`,
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });
    expect(result.value).toEqual({ fs: true, path: true, joined: "tests" });
  });

  it("reports actionable errors for unsupported modules", async () => {
    const run = runProgram({
      source: 'return require("node:crypto");',
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });
    await expect(run).rejects.toThrow(
      /predeclared fs, path, git, command, tools/,
    );
    await expect(run).rejects.toThrow(/node:crypto/);
  });

  it("captures structured console output without changing the completion value", async () => {
    const result = await runProgram({
      source: `
        const evidence = { answer: 42 };
        console.log("candidate", evidence);
        console.info({ phase: "inspect" });
        console.warn(["check"]);
        console.error(null);
        console.debug(true);
        evidence.answer = 0;
        return "complete";
      `,
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });

    expect(result.value).toBe("complete");
    expect(result.consoleOutput).toEqual([
      { level: "log", values: ["candidate", { answer: 42 }] },
      { level: "info", values: [{ phase: "inspect" }] },
      { level: "warn", values: [["check"]] },
      { level: "error", values: [null] },
      { level: "debug", values: [true] },
    ]);
  });

  it("rejects circular console values with actionable guidance", async () => {
    await expect(
      runProgram({
        source:
          "const circular = {}; circular.self = circular; console.log(circular); return 'done';",
        capabilities: new Map(),
        execute: async () => ok(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Console args: not JSON-compatible");
  });

  it("rejects programs without a completion value", async () => {
    await expect(
      runProgram({
        source: "const answer = 42;",
        capabilities: new Map(),
        execute: async () => ok(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "Execution returned undefined. Return a JSON-compatible value, e.g. { results }.",
    );

    await expect(
      runProgram({
        source: 'return "x".repeat(6 * 1024 * 1024);',
        resultMode: "discard",
        capabilities: new Map(),
        execute: async () => ok(),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ value: undefined });
  });

  it("cannot escape to a host process through Function constructors", async () => {
    const result = await runProgram({
      source:
        'let escaped; try { escaped = globalThis.constructor.constructor("return typeof process")(); } catch { escaped = "blocked"; } return escaped;',
      capabilities: new Map([[echo.name, echo]]),
      execute: (_name, args) => echo.handler(args),
      signal: new AbortController().signal,
    });
    expect(result.value).toBe("undefined");
  });

  it("provides native-like fs methods over audited facade capabilities", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const facadeTools = new Map(
      [
        "read",
        "write",
        "create_directory",
        "move",
        "__ptc_fs_rm",
        "__ptc_fs_readdir",
        "__ptc_fs_stat",
      ].map((name) => [name, tool(name)]),
    );
    const result = await runProgram({
      source: `
        const text = fs.readFile("src/a.ts", "utf8");
        fs.writeFile("src/b.ts", text);
        fs.mkdir("src/generated");
        fs.rename("src/b.ts", "src/generated/b.ts");
        const entries = fs.readdir("src");
        const dirents = fs.readdir("src", { withFileTypes: true });
        const stats = fs.stat("src/a.ts");
        const exists = fs.exists("src/a.ts");
        const lines = fs.readLines("src/a.ts", { start: 2, end: 4 });
        fs.copyFile("src/a.ts", "src/copied.ts");
        const unlinked = fs.unlink("src/copied.ts");
        const removed = fs.rm("src/generated", { recursive: true });
        return {
          text,
          entries,
          dirent: {
            name: dirents[0].name,
            file: dirents[0].isFile(),
            directory: dirents[0].isDirectory(),
            link: dirents[0].isSymbolicLink()
          },
          size: stats.size,
          exists,
          lines,
          unlinked,
          removed,
          file: stats.isFile(),
          directory: stats.isDirectory(),
          link: stats.isSymbolicLink()
        };
      `,
      capabilities: new Map(),
      facadeCapabilities: facadeTools,
      execute: async (name, args) => {
        calls.push({ name, args });
        if (name === "read") {
          const input = args as { offset?: number };
          return ok({
            type: "text",
            file: input.offset
              ? {
                  content: "two\nthree\nfour",
                  startLine: 2,
                  numLines: 3,
                  totalLines: 8,
                }
              : { content: "hello", startLine: 1, numLines: 1, totalLines: 1 },
          });
        }
        if (name === "__ptc_fs_readdir") {
          const input = args as { withFileTypes?: boolean };
          return ok(
            input.withFileTypes
              ? [
                  {
                    name: "a.ts",
                    file: true,
                    directory: false,
                    symbolicLink: false,
                  },
                ]
              : ["a.ts", "b.ts"],
          );
        }
        if (name === "__ptc_fs_stat") {
          return ok({
            size: 5,
            mtimeMs: 1,
            file: true,
            directory: false,
            symbolicLink: false,
          });
        }
        if (name === "__ptc_fs_rm") {
          const input = args as { path: string };
          return ok({
            originalPath: input.path,
            entryId: `trash-${input.path}`,
            trashPath: `.zap/trash/trash-${input.path}`,
          });
        }
        return ok();
      },
      signal: new AbortController().signal,
    });
    expect(result.value).toEqual({
      text: "hello",
      entries: ["a.ts", "b.ts"],
      dirent: { name: "a.ts", file: true, directory: false, link: false },
      size: 5,
      exists: true,
      lines: { text: "two\nthree\nfour", start: 2, end: 4, totalLines: 8 },
      unlinked: ".zap/trash/trash-src/copied.ts",
      removed: ".zap/trash/trash-src/generated",
      file: true,
      directory: false,
      link: false,
    });
    expect(calls).toEqual([
      {
        name: "read",
        args: { file_path: "src/a.ts", mode: "content" },
      },
      {
        name: "write",
        args: { file_path: "src/b.ts", content: "hello" },
      },
      { name: "create_directory", args: { path: "src/generated" } },
      {
        name: "move",
        args: {
          source: "src/b.ts",
          destination: "src/generated/b.ts",
          overwrite: true,
        },
      },
      { name: "__ptc_fs_readdir", args: { path: "src" } },
      {
        name: "__ptc_fs_readdir",
        args: { path: "src", withFileTypes: true },
      },
      { name: "__ptc_fs_stat", args: { path: "src/a.ts" } },
      { name: "__ptc_fs_stat", args: { path: "src/a.ts" } },
      {
        name: "read",
        args: { file_path: "src/a.ts", offset: 2, limit: 3, mode: "content" },
      },
      {
        name: "read",
        args: { file_path: "src/a.ts", mode: "content" },
      },
      {
        name: "write",
        args: { file_path: "src/copied.ts", content: "hello" },
      },
      { name: "__ptc_fs_rm", args: { path: "src/copied.ts", unlink: true } },
      {
        name: "__ptc_fs_rm",
        args: { path: "src/generated", recursive: true },
      },
    ]);
  });

  it("supports undocumented Node-style fs Sync aliases", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const facadeTools = new Map(
      [
        "read",
        "write",
        "create_directory",
        "move",
        "__ptc_fs_rm",
        "__ptc_fs_readdir",
        "__ptc_fs_stat",
      ].map((name) => [name, tool(name)]),
    );
    const result = await runProgram({
      source: `
        const text = fs.readFileSync("src/a.ts", "utf8");
        fs.writeFileSync("src/b.ts", text);
        fs.mkdirSync("src/generated");
        fs.renameSync("src/b.ts", "src/generated/b.ts");
        const entries = fs.readdirSync("src");
        const stats = fs.statSync("src/a.ts");
        const exists = fs.existsSync("src/a.ts");
        const lines = fs.readLines("src/a.ts", { start: 1, end: 1 });
        fs.copyFileSync("src/a.ts", "src/copied.ts");
        fs.unlinkSync("src/copied.ts");
        fs.rmSync("src/generated", { recursive: true });
        return { text, entries, size: stats.size, exists, lines };
      `,
      capabilities: new Map(),
      facadeCapabilities: facadeTools,
      execute: async (name, args) => {
        calls.push({ name, args });
        if (name === "read") {
          return ok({
            type: "text",
            file: {
              content: "hello",
              startLine: 1,
              numLines: 1,
              totalLines: 1,
            },
          });
        }
        if (name === "__ptc_fs_readdir") return ok(["a.ts", "b.ts"]);
        if (name === "__ptc_fs_stat") {
          return ok({
            size: 5,
            mtimeMs: 1,
            file: true,
            directory: false,
            symbolicLink: false,
          });
        }
        return ok();
      },
      signal: new AbortController().signal,
    });
    expect(result.value).toEqual({
      text: "hello",
      entries: ["a.ts", "b.ts"],
      size: 5,
      exists: true,
      lines: { text: "hello", start: 1, end: 1, totalLines: 1 },
    });
    expect(calls.map(({ name }) => name)).toEqual([
      "read",
      "write",
      "create_directory",
      "move",
      "__ptc_fs_readdir",
      "__ptc_fs_stat",
      "__ptc_fs_stat",
      "read",
      "read",
      "write",
      "__ptc_fs_rm",
      "__ptc_fs_rm",
    ]);
  });

  it("exposes search and repository inspection through first-class facades", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const capabilities = new Map(
      [
        "find",
        "grep",
        "git_status",
        "git_diff",
        "git_log",
        "git_show_commit",
        "git_show_file",
      ].map((name) => [name, tool(name)]),
    );
    const blame = tool("__ptc_git_blame");
    const glob = tool("__ptc_fs_glob");
    const grep = tool("__ptc_fs_grep");
    const result = await runProgram({
      source: `
        return {
          glob: fs.glob("**/*.ts", { path: "src", maxDepth: 2, includeIgnored: true }),
          globSync: fs.globSync(["**/*.test.ts", "**/*.spec.ts"], { path: "tests" }),
          grep: fs.grep("needle", { path: "src", caseInsensitive: true, includeIgnored: true }),
          grepSync: fs.grepSync("other", { glob: "*.ts" }),
          grepRegex: fs.grep(/needle|other/i),
          status: git.status(),
          diff: git.diff({ path: "src/a.ts" }),
          log: git.log({ limit: 2 }),
          commit: git.show("abc123"),
          file: git.show("HEAD", "src/a.ts"),
          blame: git.blame("src/a.ts", { startLine: 2, endLine: 4 })
        };
      `,
      capabilities,
      facadeCapabilities: new Map([
        [blame.name, blame],
        [glob.name, glob],
        [grep.name, grep],
      ]),
      execute: async (name, args) => {
        calls.push({ name, args });
        if (name === "__ptc_fs_glob") return ok(["src/a.ts"]);
        if (name === "__ptc_fs_grep") {
          return ok([{ path: "src/a.ts", line: 1, column: 1, text: "needle" }]);
        }
        if (name === "find")
          return ok({ paths: ["src/a.ts"], truncated: false });
        if (name === "grep") return ok({ matches: [], truncated: false });
        if (name === "git_status")
          return ok({ head: {}, merge: {}, changes: [] });
        if (name === "git_diff")
          return ok({ patch: "", files: [], truncated: false });
        if (name === "git_log") return ok({ commits: [{ sha: "abc123" }] });
        if (name === "git_show_commit") return ok({ sha: "abc123" });
        if (name === "git_show_file") return ok("source");
        if (name === "__ptc_git_blame")
          return ok([{ line: 2, text: "source" }]);
        return ok();
      },
      signal: new AbortController().signal,
    });

    expect(result.value).toMatchObject({
      glob: ["src/a.ts"],
      globSync: ["src/a.ts"],
      status: { changes: [] },
      log: [{ sha: "abc123" }],
      commit: { sha: "abc123" },
      file: "source",
      blame: [{ line: 2, text: "source" }],
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          name: "__ptc_fs_glob",
          args: {
            pattern: "**/*.ts",
            path: "src",
            maxDepth: 2,
            includeIgnored: true,
          },
        },
        {
          name: "__ptc_fs_glob",
          args: {
            pattern: ["**/*.test.ts", "**/*.spec.ts"],
            path: "tests",
          },
        },
        {
          name: "__ptc_fs_grep",
          args: {
            pattern: "needle",
            path: "src",
            caseInsensitive: true,
            includeIgnored: true,
          },
        },
        {
          name: "__ptc_fs_grep",
          args: {
            pattern: "needle|other",
            caseInsensitive: true,
          },
        },
        { name: "git_show_commit", args: { sha: "abc123" } },
        { name: "git_show_file", args: { ref: "HEAD", path: "src/a.ts" } },
        {
          name: "__ptc_git_blame",
          args: { path: "src/a.ts", startLine: 2, endLine: 4 },
        },
      ]),
    );
  });

  it("rejects RegExp flags that fs.grep cannot preserve", async () => {
    const grep = tool("__ptc_fs_grep");
    const run = runProgram({
      source: "return fs.grep(/needle/g);",
      capabilities: new Map(),
      facadeCapabilities: new Map([[grep.name, grep]]),
      execute: async () => ok([]),
      signal: new AbortController().signal,
    });

    await expect(run).rejects.toThrow('fs.grep RegExp: "i" flag only');
  });

  it("loads capability results larger than 64 KiB into the VM", async () => {
    const glob = tool("__ptc_fs_glob");
    const paths = Array.from(
      { length: 8_000 },
      (_, index) => `src/generated/file-${index}.ts`,
    );
    const result = await runProgram({
      source: 'const paths = fs.glob("**/*.ts"); return paths.length;',
      capabilities: new Map(),
      facadeCapabilities: new Map([[glob.name, glob]]),
      execute: async () => ok(paths),
      signal: new AbortController().signal,
    });

    expect(Buffer.byteLength(JSON.stringify(paths))).toBeGreaterThan(64 * 1024);
    expect(result.value).toBe(8_000);
  });

  it("does not expose internal facade capabilities through tools", async () => {
    const internal = tool("__ptc_fs_stat");
    const run = runProgram({
      source: 'return tools["__ptc_fs_stat"]({ path: "." });',
      capabilities: new Map(),
      facadeCapabilities: new Map([[internal.name, internal]]),
      execute: (_name, args) => internal.handler(args),
      signal: new AbortController().signal,
    });
    await expect(run).rejects.toThrow(/Unknown tool/);
  });

  it("exposes command.run over its audited facade", async () => {
    const commandTool = tool("__ptc_command_run");
    const calls: unknown[] = [];
    const result = await runProgram({
      source: `
        const first = command.run("printf", ["%s", "hello"]);
        return command.run("sort", [], { stdin: first.stdout, timeoutMs: 5000 });
      `,
      capabilities: new Map(),
      facadeCapabilities: new Map([[commandTool.name, commandTool]]),
      execute: async (name, args) => {
        calls.push({ name, args });
        return ok({
          stdout: calls.length === 1 ? "hello" : "hello\n",
          stderr: "",
        });
      },
      signal: new AbortController().signal,
    });
    expect(result.value).toEqual({ stdout: "hello\n", stderr: "" });
    expect(calls).toEqual([
      {
        name: "__ptc_command_run",
        args: { executable: "printf", args: ["%s", "hello"] },
      },
      {
        name: "__ptc_command_run",
        args: {
          executable: "sort",
          args: [],
          stdin: "hello",
          timeoutMs: 5000,
        },
      },
    ]);
  });

  it("exposes command as a callable shorthand", async () => {
    const commandTool = tool("__ptc_command_run");
    const result = await runProgram({
      source: `
        const res = command("pnpm", ["check"], { cwd: "/workspace", timeoutMs: 300000 });
        ({ exitStatus: res.status ?? "unknown", stdout: res.stdout, stderr: res.stderr });
      `,
      capabilities: new Map(),
      facadeCapabilities: new Map([[commandTool.name, commandTool]]),
      execute: async () => ok({ status: 0, stdout: "checked", stderr: "" }),
      signal: new AbortController().signal,
    });

    expect(result.value).toEqual({
      exitStatus: 0,
      stdout: "checked",
      stderr: "",
    });
  });

  it("supports command.run option and argv overloads", async () => {
    const commandTool = tool("__ptc_command_run");
    const calls: unknown[] = [];
    const result = await runProgram({
      source: `
        const first = command.run("pwd -L", { cwd: "src" });
        const second = command.run(["printf", "%s", first.stdout], { timeoutMs: 5000 });
        return second;
      `,
      capabilities: new Map(),
      facadeCapabilities: new Map([[commandTool.name, commandTool]]),
      execute: async (name, args) => {
        calls.push({ name, args });
        return ok({ stdout: calls.length === 1 ? "src" : "src", stderr: "" });
      },
      signal: new AbortController().signal,
    });
    expect(result.value).toEqual({ stdout: "src", stderr: "" });
    expect(calls).toEqual([
      {
        name: "__ptc_command_run",
        args: { command: "pwd -L", cwd: "src" },
      },
      {
        name: "__ptc_command_run",
        args: {
          executable: "printf",
          args: ["%s", "src"],
          timeoutMs: 5000,
        },
      },
    ]);
  });

  it("returns command.run results synchronously", async () => {
    const commandTool = tool("__ptc_command_run");
    await expect(
      runProgram({
        source:
          'const result = command.run("ls", ["-la"]); return result.stdout;',
        capabilities: new Map(),
        facadeCapabilities: new Map([[commandTool.name, commandTool]]),
        execute: async () => ok({ stdout: "files", stderr: "" }),
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ value: "files" });
  });

  it("lets programs inspect nonzero command results", async () => {
    const commandTool = tool("__ptc_command_run");
    const result = await runProgram({
      source: `
        const res = command.run("pnpm", ["check"], { cwd: "/workspace" });
        return {
          status: res.status,
          stdout: res.stdout,
          stderr: res.stderr,
          verdict: res.status === 0 ? "PASS" : "FAIL"
        };
      `,
      capabilities: new Map(),
      facadeCapabilities: new Map([[commandTool.name, commandTool]]),
      execute: async () =>
        ok({ status: 2, stdout: "checking", stderr: "type error" }),
      signal: new AbortController().signal,
    });

    expect(result.value).toEqual({
      status: 2,
      stdout: "checking",
      stderr: "type error",
      verdict: "FAIL",
    });
  });

  it("rejects unsupported fs encodings before dispatch", async () => {
    let dispatched = false;
    const result = await runProgram({
      source: `
        const failures = [];
        try { fs.readFile("a.bin", "base64"); }
        catch (error) { failures.push(error.message); }
        return failures;
      `,
      capabilities: new Map(),
      facadeCapabilities: new Map(),
      execute: async () => {
        dispatched = true;
        return ok();
      },
      signal: new AbortController().signal,
    });
    expect(dispatched).toBe(false);
    expect(result.value).toEqual([
      'fs.readFile encoding: "utf8" or "utf-8" only.',
    ]);
  });
});

function tool(name: string): PortalTool {
  return {
    name,
    description: name,
    parameters: {},
    async handler(args) {
      return ok(args);
    },
  };
}
