import { describe, expect, it } from "vitest";
import { validateProcRequest } from "../../../src/lib/server/proc/tools";

describe("validateProcRequest", () => {
  it("rejects multi-file raw corpus return procedures", () => {
    expect(
      validateProcRequest({
        goal: "Return the full content of src/a.ts and src/b.ts.",
        procedure:
          "Read src/a.ts fully. Read src/b.ts fully. Return raw file contents verbatim.",
      }),
    ).toContain("bounded derived result");
  });

  it("allows bounded evidence extraction and a single intentional full file", () => {
    expect(
      validateProcRequest({
        goal: "Return paths, line ranges, purposes, and bounded excerpts.",
        procedure:
          "Search src/a.ts and src/b.ts, read enclosing definitions, and omit unrelated code.",
      }),
    ).toBeNull();
    expect(
      validateProcRequest({
        goal: "Return the full content of src/generated.json.",
        procedure: "Read src/generated.json fully and return it.",
      }),
    ).toBeNull();
  });
});
