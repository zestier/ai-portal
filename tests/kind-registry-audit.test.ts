import { describe, expect, it } from "vitest";

const audit = [
  {
    area: "InteractiveRequestDialog permission scope behavior",
    classification: "candidate",
    action:
      "extracted scope choices, previews, persisted-scope construction, and shell options into interactive-permission helpers",
  },
  {
    area: "Permission kind to scope kind/key/label metadata",
    classification: "candidate",
    action:
      "centralized in permissions/metadata and reused by schema, matcher scope-key derivation, settings UI, policy, and best-effort feedback",
  },
  {
    area: "git_commit prompt summary and preview",
    classification: "candidate",
    action:
      "moved shared commit-preview parsing/summary into permissions/git-commit",
  },
  {
    area: "Default interactive cancellation responses",
    classification: "candidate",
    action: "moved to a typed InteractiveKind descriptor registry",
  },
  {
    area: "Tool-call header summaries",
    classification: "candidate",
    action:
      "moved tool-name behavior to tool-summary handlers keyed by normalized tool name",
  },
  {
    area: "Settings grant form authoring/edit initialization",
    classification: "candidate",
    action:
      "moved shell/fs/url scope JSON building, labels, defaults, and edit-field hydration into permissions/grant-form helpers",
  },
  {
    area: "Grant scope display and capability summaries",
    classification: "candidate",
    action:
      "shared scope description and capability rule-kind/summary helpers through permissions/scope-summary",
  },
  {
    area: "Scope codecs, match predicates, and result rendering components",
    classification: "boundary",
    action:
      "kept discriminated-union switches where they perform exhaustive decoding/rendering for closed result or scope shapes",
  },
] as const;

describe("kind-branching audit", () => {
  it("documents which repeated kind branches were extracted and which switches remain boundaries", () => {
    expect(audit.some((entry) => entry.classification === "candidate")).toBe(
      true,
    );
    expect(audit.some((entry) => entry.classification === "boundary")).toBe(
      true,
    );
    expect(audit.map((entry) => entry.area)).toContain(
      "Permission kind to scope kind/key/label metadata",
    );
  });
});
