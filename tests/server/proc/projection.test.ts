import { describe, expect, it } from "vitest";
import { projectProcValue } from "../../../src/lib/server/proc/projection";

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

    expect(message).toContain("emergency transport guard (12288)");
    expect(message).toContain("Derive only required fields");
    expect(message).toContain("never paginate");
    expect(message).not.toContain("context-spike-marker");
    expect(Buffer.byteLength(message)).toBeLessThan(200);
  });
});
