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
        "const first = await tools.echo({ value: 2 }); return { ok: first.ok, value: first.result.value + 1 };",
      capabilities: new Map([[echo.name, echo]]),
      execute: (_name, args) => echo.handler(args),
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ value: { ok: true, value: 3 }, operations: 1 });
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
});
