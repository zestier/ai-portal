import { describe, it, expect } from "vitest";
import {
  atomWorkerPrompt,
  isSubagentToolCall,
  procWorkerPrompt,
  selectSubagentChildren,
  MAX_SUBAGENT_NESTING_DEPTH,
  resolveWorkerPrompt,
  SUBAGENT_TOOL,
} from "../../src/lib/client/subagent-display";
import type {
  ToolCallRecord,
  ReasoningBlockRecord,
  FileEditRecord,
} from "../../src/lib/types";

const x = (id: number): string => `X${id}`;
const M1 = "M1";

function tool(
  id: number,
  parentToolCallId: number | null,
  name = "bash",
): ToolCallRecord {
  return {
    id: x(id),
    messageId: M1,
    tool: name,
    argsJson: "{}",
    resultJson: null,
    status: "ok",
    startedAt: 0,
    endedAt: 1,
    textOffset: null,
    parentToolCallId: parentToolCallId === null ? null : x(parentToolCallId),
  };
}

function reasoning(
  id: number,
  parentToolCallId: number | null,
): ReasoningBlockRecord {
  return {
    id,
    messageId: M1,
    segmentIndex: 0,
    text: "thinking",
    kind: "reasoning",
    textOffset: null,
    startedAt: 0,
    durationMs: 1,
    parentToolCallId: parentToolCallId === null ? null : x(parentToolCallId),
  };
}

function edit(id: number, parentToolCallId: number | null): FileEditRecord {
  return {
    id,
    messageId: M1,
    path: "a.ts",
    diff: "",
    createdAt: 0,
    textOffset: null,
    parentToolCallId: parentToolCallId === null ? null : x(parentToolCallId),
  };
}

describe("isSubagentToolCall", () => {
  it("identifies task calls, which render as sub-agent cards", () => {
    expect(isSubagentToolCall(tool(1, null, SUBAGENT_TOOL))).toBe(true);
    expect(isSubagentToolCall(tool(2, null, "resolve"))).toBe(true);
    expect(isSubagentToolCall(tool(3, null, "resume"))).toBe(true);
    expect(isSubagentToolCall(tool(4, null, "proc"))).toBe(true);
    expect(isSubagentToolCall(tool(5, null, "atom"))).toBe(true);
  });

  it("rejects ordinary tool calls", () => {
    expect(isSubagentToolCall(tool(1, null, "bash"))).toBe(false);
    // Near-miss names must not be treated as sub-agents.
    expect(isSubagentToolCall(tool(2, null, "tasks"))).toBe(false);
  });
});

describe("procWorkerPrompt", () => {
  it("shows the exact result requirements and procedure supplied to proc", () => {
    expect(
      procWorkerPrompt({
        summary: "Find owners",
        procedure: "grep, group, read context",
        result_requirements: "Return paths and ranges",
        max_result_bytes: 4096,
      }),
    ).toBe(
      JSON.stringify(
        {
          summary: "Find owners",
          procedure: "grep, group, read context",
          result_requirements: "Return paths and ranges",
          max_result_bytes: 4096,
        },
        null,
        2,
      ),
    );
  });
});

describe("atomWorkerPrompt", () => {
  it("shows the exact atom source and projection policy", () => {
    expect(
      atomWorkerPrompt({
        summary: "Read matching definitions",
        source: "return state.RES_matches.map(readDefinition);",
        output: { mode: "shape", max_bytes: 2048, store: true },
      }),
    ).toContain("return state.RES_matches.map(readDefinition);");
  });
});

describe("resolveWorkerPrompt", () => {
  it("reproduces the structured user message sent to the semantic worker", () => {
    expect(
      resolveWorkerPrompt({
        summary: "Remove obsolete terminology",
        intent: "Remove every instance of foo",
        constraints: ["Do not alter generated files"],
        completion: ["grep finds no matches"],
      }),
    ).toBe(
      JSON.stringify({
        intent: "Remove every instance of foo",
        constraints: ["Do not alter generated files"],
        completion: ["grep finds no matches"],
      }),
    );
  });

  it("uses the worker defaults for omitted optional fields", () => {
    expect(resolveWorkerPrompt({ intent: "Find the owner" })).toBe(
      JSON.stringify({
        intent: "Find the owner",
        constraints: [],
        completion: [],
      }),
    );
  });
});

describe("selectSubagentChildren", () => {
  it("selects only direct children across all three pools", () => {
    const pools = {
      tools: [tool(1, 100), tool(2, 101), tool(3, null)],
      reasoning: [reasoning(1, 100), reasoning(2, null)],
      edits: [edit(1, 100), edit(2, 101)],
    };
    const children = selectSubagentChildren(pools, x(100));
    expect(children.tools.map((t) => t.id)).toEqual(["X1"]);
    expect(children.reasoning.map((r) => r.id)).toEqual([1]);
    expect(children.edits.map((e) => e.id)).toEqual([1]);
  });

  it("excludes grandchildren, which belong to the nested task call instead", () => {
    // outer(100) -> inner(10, task) -> grandchild(11)
    const pools = {
      tools: [tool(10, 100, SUBAGENT_TOOL), tool(11, 10), tool(12, 100)],
    };
    const outer = selectSubagentChildren(pools, x(100));
    expect(outer.tools.map((t) => t.id)).toEqual(["X10", "X12"]);

    // The grandchild is reachable one level down — the regression this
    // guards is it being dropped from the UI entirely.
    const inner = selectSubagentChildren(pools, x(10));
    expect(inner.tools.map((t) => t.id)).toEqual(["X11"]);
  });

  it("drops a self-referential row so a card cannot contain itself", () => {
    const pools = { tools: [tool(99, 99)] };
    expect(selectSubagentChildren(pools, x(99)).tools).toEqual([]);
  });

  it("treats missing pools as empty rather than throwing", () => {
    expect(selectSubagentChildren({}, x(100))).toEqual({
      tools: [],
      reasoning: [],
      edits: [],
    });
  });

  it("returns nothing for an id with no children", () => {
    const pools = { tools: [tool(1, 100)] };
    expect(selectSubagentChildren(pools, x(999)).tools).toEqual([]);
  });
});

describe("MAX_SUBAGENT_NESTING_DEPTH", () => {
  it("allows real nesting while still terminating a cyclic parent chain", () => {
    // Must exceed 1 or the recursion this cap guards would never happen;
    // kept small so a pathological chain cannot hang the tab.
    expect(MAX_SUBAGENT_NESTING_DEPTH).toBeGreaterThan(1);
    expect(MAX_SUBAGENT_NESTING_DEPTH).toBeLessThanOrEqual(8);
  });
});
