import { describe, expect, it } from "vitest";
import {
  buildProcTools,
  validateProcRequest,
} from "../../../src/lib/server/proc/tools";

describe("proc arguments", () => {
  it("uses an exact result contract without advertising a byte target", () => {
    const [proc] = buildProcTools({
      conversationId: 1,
      primaryModel: "test/model",
      capabilities: new Map(),
      facadeCapabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
    });
    const parameters = proc.parameters as {
      required: string[];
      properties: Record<string, unknown>;
    };

    expect(parameters.required).toEqual([
      "summary",
      "procedure",
      "result_requirements",
    ]);
    expect(
      proc.argsSchema?.parse({
        summary: "Find owners",
        procedure: "Search and reduce the matches.",
        result_requirements: "Paths and line ranges.",
      }),
    ).not.toHaveProperty("max_result_bytes");
    expect(proc.parameters.properties).not.toHaveProperty("max_result_bytes");
  });
});

describe("validateProcRequest", () => {
  it("rejects multi-file raw corpus return procedures", () => {
    expect(
      validateProcRequest({
        requirements: "Return the full content of src/a.ts and src/b.ts.",
        procedure:
          "Read src/a.ts fully. Read src/b.ts fully. Return raw file contents verbatim.",
      }),
    ).toContain("exact derived result");
  });

  it("allows bounded evidence extraction and a single intentional full file", () => {
    expect(
      validateProcRequest({
        requirements:
          "Return paths, line ranges, purposes, and bounded excerpts.",
        procedure:
          "Search src/a.ts and src/b.ts, read enclosing definitions, and omit unrelated code.",
      }),
    ).toBeNull();
    expect(
      validateProcRequest({
        requirements: "Return the full content of src/generated.json.",
        procedure: "Read src/generated.json fully and return it.",
      }),
    ).toBeNull();
  });

  it("rejects model-side browsing of matches and paged corpora", () => {
    expect(
      validateProcRequest({
        requirements: "Return all relevant context from the search results.",
        procedure: "Search the repository and return the matches.",
      }),
    ).toContain("reduces candidate corpora in JavaScript");
    expect(
      validateProcRequest({
        requirements: "Show batches of candidates for review.",
        procedure: "Return pages of candidate files until they are exhausted.",
      }),
    ).toContain("never page them for model browsing");
  });
});
