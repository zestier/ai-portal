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
      source:
        "const first = await tools.echo({ value: 2 }); return first.value + 1;",
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
      source: "return await tools.ech({ value: 2 });",
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
      requireType: "undefined",
    });
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
        const text = await fs.readFile("src/a.ts", "utf8");
        await fs.writeFile("src/b.ts", text);
        await fs.mkdir("src/generated");
        await fs.rename("src/b.ts", "src/generated/b.ts");
        const entries = await fs.readdir("src");
        const stats = await fs.stat("src/a.ts");
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

  it("does not expose internal facade capabilities through tools", async () => {
    const internal = tool("__ptc_fs_stat");
    const run = runProgram({
      source: 'return await tools["__ptc_fs_stat"]({ path: "." });',
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
        const first = await command.run("printf", ["%s", "hello"]);
        return await command.run("sort", [], { stdin: first.stdout, timeoutMs: 5000 });
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

  it("rejects unsupported fs options before dispatch", async () => {
    let dispatched = false;
    const result = await runProgram({
      source: `
        const failures = [];
        try { await fs.readFile("a.bin", "base64"); }
        catch (error) { failures.push(error.message); }
        try { await fs.readdir("src", { withFileTypes: true }); }
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
