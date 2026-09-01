import { describe, expect, it } from "vitest";
import {
  parseProcArgs,
  parseProcExecutionArgs,
  parseProcExecutionMeta,
  parseProcExecutionResult,
  procExecutionFeedbackText,
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
          result_requirements: "Paths and ranges",
        }),
      ),
    ).toMatchObject({ summary: "Map routing" });
    expect(
      parseProcMeta({
        summary: "Map routing",
        procedure: "Search then reduce",
        result_requirements: "Paths and ranges",
      }),
    ).toMatchObject({ procedure: "Search then reduce" });
    expect(
      parseProcExecutionArgs(
        JSON.stringify({
          needed_for: "Routing map",
          javascript: "return [];",
          store_into: "store.routing",
          worker_view: "value",
          worker_view_max_bytes: 256,
        }),
      ),
    ).toMatchObject({
      store_into: "store.routing",
      worker_view: "value",
      worker_view_max_bytes: 256,
    });
    expect(
      parseProcExecutionMeta({
        needed_for: "Filtered matches",
        javascript: "return [];",
        save_as: null,
      }),
    ).toMatchObject({ save_as: null });
    expect(
      parseProcExecutionArgs(
        JSON.stringify({
          needed_for: "Choose owner from exact signatures",
          javascript: "return store.candidates.slice(0, 3);",
          max_bytes: 4096,
        }),
      ),
    ).toMatchObject({ max_bytes: 4096 });
    expect(
      parseProcExecutionArgs(
        JSON.stringify({
          javascript: "return [];",
        }),
      ),
    ).toMatchObject({ javascript: "return [];" });
    expect(
      parseProcExecutionArgs(
        JSON.stringify({
          javascript: "return fs.readFile('CONTRIBUTING.md', 'utf8');",
          max_bytes: 32,
        }),
      ),
    ).toMatchObject({ max_bytes: 32 });
    expect(
      parseProcExecutionArgs(
        JSON.stringify({
          needed_for: "Which candidate satisfies the ownership rule?",
          javascript: "return [];",
        }),
      ),
    ).toMatchObject({
      needed_for: "Which candidate satisfies the ownership rule?",
      javascript: "return [];",
    });
    expect(
      parseProcExecutionArgs(
        JSON.stringify({
          needed_for: "Avoid choosing a recipient",
          javascript: "return [];",
        }),
      ),
    ).toMatchObject({
      needed_for: "Avoid choosing a recipient",
      javascript: "return [];",
    });
  });

  it("preserves the exact feedback text sent to the worker", () => {
    const feedback = '{"store_into":"store.routing","view":"value"}';
    expect(procExecutionFeedbackText(JSON.stringify(feedback))).toBe(feedback);
    expect(procExecutionFeedbackText(feedback)).toBe(feedback);
  });

  it("unwraps protocol result strings and portal envelopes", () => {
    expect(
      parseProcExecutionResult(
        JSON.stringify(
          JSON.stringify({
            save_as: "matches",
            value_bytes: 1200,
            structure: "array(20)",
            structure_bytes: 9,
          }),
        ),
      ),
    ).toMatchObject({
      save_as: "matches",
    });
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

  it("unwraps portal envelopes around worker execution feedback", () => {
    expect(
      parseProcExecutionResult(
        JSON.stringify({
          ok: true,
          result: {
            worker_view_kind: "value",
            value: { path: "src/a.ts" },
            worker_view_bytes: 18,
          },
        }),
      ),
    ).toEqual({
      worker_view_kind: "value",
      value: { path: "src/a.ts" },
      worker_view_bytes: 18,
    });
    expect(
      parseProcExecutionResult(
        JSON.stringify({
          ok: false,
          error: { message: "worker failed" },
        }),
      ),
    ).toEqual({ error: "worker failed" });
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
