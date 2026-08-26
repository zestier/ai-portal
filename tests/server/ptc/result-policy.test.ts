import { describe, expect, it } from "vitest";
import { projectProgramResult } from "../../../src/lib/server/ptc/result-policy";

describe("program result policy", () => {
  it("returns complete results unchanged within the declared byte budget", () => {
    const text = `${JSON.stringify({ answer: 42 }, null, 2)}\n\nOperations: 3`;
    expect(projectProgramResult({ answer: 42 }, 3, 1024, "reject")).toEqual({
      ok: true,
      text,
      originalBytes: Buffer.byteLength(text),
      lossy: false,
    });
  });

  it("rejects oversized output with measured and declared sizes", () => {
    const projection = projectProgramResult(
      "x".repeat(2000),
      0,
      1024,
      "reject",
    );
    expect(projection).toMatchObject({ ok: false, originalBytes: 2015 });
    if (projection.ok) throw new Error("expected rejection");
    expect(projection.message).toContain("2015 bytes");
    expect(projection.message).toContain("maximum is 1024 bytes");
    expect(projection.message).toContain("Reduce or aggregate");
  });

  it.each([
    ["head", "BEGIN", "END", true, false],
    ["tail", "BEGIN", "END", false, true],
    ["truncate-middle", "BEGIN", "END", true, true],
  ] as const)(
    "%s stays within the byte budget and preserves the intended edge",
    (overflow, head, tail, keepsHead, keepsTail) => {
      const value = `${head}${"x".repeat(2000)}${tail}`;
      const projection = projectProgramResult(value, 1, 1024, overflow);
      expect(projection.ok).toBe(true);
      if (!projection.ok) throw new Error("expected lossy result");
      expect(Buffer.byteLength(projection.text)).toBeLessThanOrEqual(1024);
      expect(projection.lossy).toBe(true);
      expect(projection.text.includes(head)).toBe(keepsHead);
      expect(projection.text.includes(tail)).toBe(keepsTail);
      expect(projection.text).toContain("original model output was");
    },
  );

  it("structure summarizes collection shape without duplicating a compact summary", () => {
    const value = Array.from({ length: 200 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      content: "x".repeat(100),
    }));
    const projection = projectProgramResult(value, 200, 1024, "structure");
    expect(projection.ok).toBe(true);
    if (!projection.ok) throw new Error("expected structural result");
    expect(Buffer.byteLength(projection.text)).toBeLessThanOrEqual(1024);
    expect(projection.text).toContain("$: array(200)");
    expect(projection.text).toContain("188 more item(s)");
    expect(projection.text.match(/\$: array\(200\)/g)).toHaveLength(1);
    expect(projection.text).not.toContain("x".repeat(100));
  });

  it("never splits multibyte characters while enforcing bytes", () => {
    const projection = projectProgramResult(
      "🙂".repeat(600),
      0,
      1024,
      "truncate-middle",
    );
    expect(projection.ok).toBe(true);
    if (!projection.ok) throw new Error("expected truncated result");
    expect(Buffer.byteLength(projection.text)).toBeLessThanOrEqual(1024);
    expect(projection.text).not.toContain("�");
  });
});
