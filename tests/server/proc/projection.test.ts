import { describe, expect, it } from "vitest";
import {
  projectProcValue,
  projectProcWorkerValue,
} from "../../../src/lib/server/proc/projection";

describe("projectProcValue", () => {
  it("rejects oversized model-bound values without embedding their payload", () => {
    const payload = "context-spike-marker".repeat(24_000);
    let message = "";

    try {
      projectProcValue(payload, {
        mode: "exact",
        maxBytes: 12 * 1024,
        store: true,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("transport limit 12288B");
    expect(message).toContain("Derive required fields");
    expect(message).toContain("never paginate");
    expect(message).not.toContain("context-spike-marker");
    expect(Buffer.byteLength(message)).toBeLessThan(200);
  });
});

describe("projectProcWorkerValue", () => {
  it("falls back from an oversized value to a compact shape within the same budget", () => {
    const projection = projectProcWorkerValue(
      [{ path: "src/a.ts", content: "x".repeat(4096) }],
      "value",
      64,
    );

    expect(projection).toMatchObject({
      kind: "shape",
      reason: "value_exceeded_limit",
      truncated: true,
    });
    expect(projection.projection).toContain("array(1) of object");
    expect(projection.projectionBytes).toBeLessThanOrEqual(64);
  });

  it("applies the requested budget directly to compact shape feedback", () => {
    const projection = projectProcWorkerValue(
      { alpha: { beta: { gamma: "x" } }, delta: 1 },
      "shape",
      40,
    );

    expect(projection.kind).toBe("shape");
    expect(projection.projectionBytes).toBeLessThanOrEqual(40);
    expect(projection.truncated).toBe(true);
  });

  it("ignores the budget when no worker view is requested", () => {
    expect(projectProcWorkerValue({ hidden: true }, "none", 32)).toEqual({
      kind: "none",
      projectionBytes: 0,
      truncated: false,
    });
  });

  it("allows an empty budget for shape or value feedback", () => {
    expect(projectProcWorkerValue({ hidden: true }, "shape", 0)).toMatchObject({
      kind: "shape",
      projection: "",
      projectionBytes: 0,
      truncated: true,
    });
    expect(projectProcWorkerValue({ hidden: true }, "value", 0)).toMatchObject({
      kind: "shape",
      reason: "value_exceeded_limit",
      projection: "",
      projectionBytes: 0,
      truncated: true,
    });
  });
});
