import { describe, expect, it } from "vitest";
import {
  parseProcArgs,
  parseProcExecutionArgs,
  parseProcExecutionMeta,
  parseProcExecutionResult,
  parseProcMeta,
  parseProcOutcome,
} from "../../src/lib/client/proc-display";

describe("proc display parsing", () => {
  it("parses proc and execution arguments", () => {
    expect(
      parseProcArgs(
        JSON.stringify({
          summary: "Map routing",
          procedure: "Search then reduce",
          result_contract: "Paths and ranges",
          max_result_bytes: 4096,
        }),
      ),
    ).toMatchObject({ summary: "Map routing", max_result_bytes: 4096 });
    expect(
      parseProcMeta({
        summary: "Map routing",
        procedure: "Search then reduce",
        result_contract: "Paths and ranges",
      }),
    ).toMatchObject({ procedure: "Search then reduce" });
    expect(
      parseProcExecutionArgs(
        JSON.stringify({
          summary: "Search and reduce",
          javascript: "return [];",
          purpose: "final",
        }),
      ),
    ).toMatchObject({ purpose: "final" });
    expect(
      parseProcExecutionMeta({
        summary: "Search and reduce",
        javascript: "return [];",
        purpose: "checkpoint",
      }),
    ).toMatchObject({ purpose: "checkpoint" });
  });

  it("unwraps protocol result strings and portal envelopes", () => {
    expect(
      parseProcExecutionResult(
        JSON.stringify(
          JSON.stringify({
            purpose: "checkpoint",
            result_id: "RES_1",
            bytes: 1200,
            projection: "array(20)",
            projection_bytes: 9,
          }),
        ),
      ),
    ).toMatchObject({ purpose: "checkpoint", result_id: "RES_1" });
    expect(
      parseProcExecutionResult(JSON.stringify("readFile is not defined")),
    ).toEqual({ error: "readFile is not defined" });
    expect(
      parseProcOutcome(
        JSON.stringify({
          ok: true,
          result: {
            status: "completed",
            bytes: 24,
            projection: [{ path: "src/a.ts" }],
            usage: { turns: 1, executions: 1, operations: 2 },
          },
        }),
      ),
    ).toMatchObject({ status: "completed", usage: { turns: 1 } });
  });

  it("surfaces cannot-execute envelopes", () => {
    expect(
      parseProcOutcome(
        JSON.stringify({
          ok: false,
          error: {
            code: "proc_cannot_execute",
            message: "A selection rule is missing.",
          },
        }),
      ),
    ).toEqual({
      status: "cannot_execute",
      error: "A selection rule is missing.",
    });
  });
});
