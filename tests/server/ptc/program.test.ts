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
    await expect(run).rejects.toThrow(/Available related tools: echo/);
    expect(dispatched).toBe(false);
  });

  it("does not impose an operation-count budget on declared reads", async () => {
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

  it("charges undeclared operations to the mutation budget", async () => {
    await expect(
      runProgram({
        source:
          "for (let index = 0; index < 501; index++) tools.echo({ value: index }); return 'done';",
        capabilities: new Map([[echo.name, echo]]),
        execute: (_name, args) => echo.handler(args),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("mutation operation budget (500)");
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
    ).rejects.toThrow("command operation budget (20)");
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

  it("reports actionable module-loading errors without lexical collisions", async () => {
    const run = runProgram({
      source: 'const fs = require("fs"); return fs;',
      capabilities: new Map(),
      execute: async () => ok(),
      signal: new AbortController().signal,
    });
    await expect(run).rejects.toThrow(
      /fs, path, command, and tools are predeclared globals/,
    );
    await expect(run).rejects.not.toThrow(/redefinition of lexical identifier/);
  });

  it("rejects console output and missing return values", async () => {
    await expect(
      runProgram({
        source: 'console.log({ answer: 42 }); return "unreachable";',
        capabilities: new Map(),
        execute: async () => ok(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "Console output is unavailable in program. Return the final value directly instead; do not JSON.stringify it.",
    );

    await expect(
      runProgram({
        source: "const answer = 42;",
        capabilities: new Map(),
        execute: async () => ok(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "Program returned undefined. Return the final value directly, for example return { results }.",
    );
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
        const stats = fs.stat("src/a.ts");
        return {
          text,
          entries,
          size: stats.size,
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
          return ok({ type: "text", file: { content: "hello" } });
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
      { name: "__ptc_fs_stat", args: { path: "src/a.ts" } },
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
        return { text, entries, size: stats.size };
      `,
      capabilities: new Map(),
      facadeCapabilities: facadeTools,
      execute: async (name, args) => {
        calls.push({ name, args });
        if (name === "read") {
          return ok({ type: "text", file: { content: "hello" } });
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
    });
    expect(calls.map(({ name }) => name)).toEqual([
      "read",
      "write",
      "create_directory",
      "move",
      "__ptc_fs_readdir",
      "__ptc_fs_stat",
    ]);
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
    await expect(run).rejects.toThrow(/Unknown program tool/);
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

  it("rejects unsupported fs options before dispatch", async () => {
    let dispatched = false;
    const result = await runProgram({
      source: `
        const failures = [];
        try { fs.readFile("a.bin", "base64"); }
        catch (error) { failures.push(error.message); }
        try { fs.readdir("src", { withFileTypes: true }); }
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
      'fs.readFile supports only "utf8" and "utf-8".',
      "fs.readdir does not yet support withFileTypes: true.",
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
