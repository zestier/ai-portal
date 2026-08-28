import { describe, expect, it } from "vitest";
import {
  buildProcTools,
  validateProcRequest,
} from "../../../src/lib/server/proc/tools";

describe("proc arguments", () => {
  it("uses a flat result contract with an optional 8 KiB budget", () => {
    const [proc] = buildProcTools({
      conversationId: 1,
      frontierModel: "test/model",
      capabilities: new Map(),
      facadeCapabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
    });
    const parameters = proc.parameters as { required: string[] };

    expect(parameters.required).toEqual([
      "summary",
      "procedure",
      "result_contract",
    ]);
    expect(
      proc.argsSchema?.parse({
        summary: "Find owners",
        procedure: "Search and reduce the matches.",
        result_contract: "Paths and line ranges.",
      }),
    ).toMatchObject({ max_result_bytes: 8192 });
  });
});

describe("validateProcRequest", () => {
  it("rejects multi-file raw corpus return procedures", () => {
    expect(
      validateProcRequest({
        contract: "Return the full content of src/a.ts and src/b.ts.",
        procedure:
          "Read src/a.ts fully. Read src/b.ts fully. Return raw file contents verbatim.",
      }),
    ).toContain("bounded derived result");
  });

  it("allows bounded evidence extraction and a single intentional full file", () => {
    expect(
      validateProcRequest({
        contract: "Return paths, line ranges, purposes, and bounded excerpts.",
        procedure:
          "Search src/a.ts and src/b.ts, read enclosing definitions, and omit unrelated code.",
      }),
    ).toBeNull();
    expect(
      validateProcRequest({
        contract: "Return the full content of src/generated.json.",
        procedure: "Read src/generated.json fully and return it.",
      }),
    ).toBeNull();
  });
});
