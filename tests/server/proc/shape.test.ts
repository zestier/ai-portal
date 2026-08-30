import { describe, expect, it } from "vitest";
import { projectShape } from "../../../src/lib/server/proc/shape";

describe("projectShape", () => {
  it("describes empty arrays without a speculative item type", () => {
    expect(projectShape([], 1024)).toEqual({
      text: "array(0)",
      bytes: 8,
      truncated: false,
    });
  });

  it("aggressively merges compatible object variants with optional fields", () => {
    const projection = projectShape(
      [
        { path: "a.ts", line: 1, text: "a" },
        { path: "b.ts", error: "unreadable" },
        { path: "c.ts", line: 3 },
      ],
      4096,
    );
    expect(projection.text).toBe(
      "array(3) of object { error?: string, line?: integer, path: string, text?: string }",
    );
    expect(projection.truncated).toBe(false);
  });

  it("is invariant to object key and array item order", () => {
    const left = projectShape(
      [
        { alpha: 1, beta: "x" },
        { alpha: 2, gamma: true },
      ],
      4096,
    );
    const right = projectShape(
      [
        { gamma: false, alpha: 4 },
        { beta: "y", alpha: 3 },
      ],
      4096,
    );
    expect(left.text).toBe(right.text);
  });

  it("merges integers into number while preserving incompatible unions", () => {
    expect(projectShape([1, 2.5, null, "x"], 4096).text).toBe(
      "array(4) of null | number | string",
    );
  });

  it("compacts deterministically within the UTF-8 byte budget", () => {
    const projection = projectShape(
      {
        alpha: { deeply: { nested: { value: "x" } } },
        beta: { deeply: { nested: { value: "y" } } },
      },
      48,
    );
    expect(projection.bytes).toBeLessThanOrEqual(48);
    expect(projection.truncated).toBe(true);
    expect(Buffer.byteLength(projection.text)).toBe(projection.bytes);
  });

  it("rejects non-JSON values and cycles", () => {
    expect(() => projectShape({ value: undefined }, 1024)).toThrow(
      "Non-JSON result",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => projectShape(cyclic, 1024)).toThrow("cycles");
  });
});
