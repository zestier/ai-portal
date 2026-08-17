import { describe, it, expect } from "vitest";
import {
  deriveEnvelopeSummary,
  deriveToolResultViews,
  envelopePayloadText,
  parseEnvelopeJson,
  serializeEnvelope,
  err,
  ok,
} from "../../../src/lib/server/tools/types";

describe("deriveEnvelopeSummary", () => {
  it("prefers an explicit summary, trimmed", () => {
    expect(deriveEnvelopeSummary(ok({ results: [] }, "  3 result(s)  "))).toBe(
      "3 result(s)",
    );
  });

  it("derives a single-line snippet from an object result when no summary is set", () => {
    expect(deriveEnvelopeSummary(ok({ a: 1 }))).toBe('{"a":1}');
  });

  it("uses the raw string for a string result", () => {
    expect(deriveEnvelopeSummary(ok("plain text"))).toBe("plain text");
  });

  it("reports an empty result rather than the envelope JSON", () => {
    expect(deriveEnvelopeSummary(ok())).toBe("(empty result)");
  });

  it("derives the error message for failures", () => {
    expect(deriveEnvelopeSummary(err("nothing to commit"))).toBe(
      "nothing to commit",
    );
  });

  it("caps long payloads to a single 200-char line", () => {
    const long = "x".repeat(500);
    const summary = deriveEnvelopeSummary(ok(long));
    expect(summary.length).toBe(200);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("exposes the underlying payload text for both variants", () => {
    expect(envelopePayloadText(ok({ a: 1 }))).toBe('{"a":1}');
    expect(envelopePayloadText(err("boom"))).toBe("boom");
  });
});

describe("deriveToolResultViews", () => {
  it("hands the model a raw multi-line string with real newlines, not escaped", () => {
    const patch = "diff --git a/x b/x\n@@ -1 +1 @@\n+\tindented";
    const views = deriveToolResultViews(ok(patch));
    expect(views.modelText).toBe(patch);
    // No JSON escape sequences leaked into the model text.
    expect(views.modelText).not.toContain("\\n");
    expect(views.modelText).not.toContain("\\t");
    expect(views.modelText.split("\n")).toHaveLength(3);
  });

  it("keeps fullContent as the canonical envelope JSON for the UI", () => {
    const env = ok({ files: [{ path: "a.txt" }] });
    const views = deriveToolResultViews(env);
    expect(views.fullContent).toBe(serializeEnvelope(env));
    expect(JSON.parse(views.fullContent)).toEqual({
      ok: true,
      result: { files: [{ path: "a.txt" }] },
    });
  });

  it("gives the model the payload, not just the summary, when a tool supplies both", () => {
    // Many tools pass a short count-style summary alongside the real result
    // (e.g. memory_search, ticket_list). The model must still receive the
    // payload; the summary is only the collapsed UI/timeline line.
    const views = deriveToolResultViews(
      ok(["t1", "t2", "t3"].join("\n"), "3 ticket(s)."),
    );
    expect(views.modelText).toBe("t1\nt2\nt3");
    expect(views.summary).toBe("3 ticket(s).");
  });

  it("renders a structured payload for the model even when a summary is set", () => {
    const views = deriveToolResultViews(
      ok({ results: [{ id: "m1", text: "remembered" }] }, "1 result(s)"),
    );
    expect(views.summary).toBe("1 result(s)");
    // The actual data reaches the model, not the bare count.
    expect(views.modelText).toContain("results:");
    expect(views.modelText).toContain("id: m1");
    expect(views.modelText).toContain("text: remembered");
  });

  it("falls back to the summary when there is no meaningful payload", () => {
    // Empty-string payload would otherwise yield empty tool-message content.
    const views = deriveToolResultViews(ok("", "done"));
    expect(views.modelText).toBe("done");
  });

  it("surfaces embedded multi-line string fields readably (git_show_commit patch)", () => {
    const commit = {
      sha: "abc123",
      subject: "Fix bug",
      body: "line one\nline two",
      patch: "diff --git a/x b/x\n@@ -1 +1 @@\n+changed",
    };
    const views = deriveToolResultViews(ok(commit));
    expect(views.modelText).toContain("sha: abc123");
    expect(views.modelText).toContain("subject: Fix bug");
    // Multi-line fields rendered as real lines, not escaped one-liners.
    expect(views.modelText).toContain("  line one");
    expect(views.modelText).toContain("  line two");
    expect(views.modelText).toContain("  diff --git a/x b/x");
    expect(views.modelText).toContain("  @@ -1 +1 @@");
    expect(views.modelText).not.toContain("\\n");
  });

  it("renders arrays of objects without escaping", () => {
    const views = deriveToolResultViews(
      ok({ commits: [{ sha: "a1", subject: "first" }] }),
    );
    expect(views.modelText).toContain("commits:");
    expect(views.modelText).toContain("sha: a1");
    expect(views.modelText).toContain("subject: first");
  });

  it("renders error message (with code and details) as raw model text", () => {
    const views = deriveToolResultViews(
      err("nothing to commit", { code: "clean", details: { staged: 0 } }),
    );
    expect(views.ok).toBe(false);
    expect(views.modelText).toContain("nothing to commit (code: clean)");
    expect(views.modelText).toContain("staged: 0");
  });

  it("keeps UI-only code and details out of the model text (detailsUiOnly)", () => {
    const views = deriveToolResultViews(
      err("string to replace not found", {
        code: "edit_failed",
        details: {
          suggestion: {
            snippet: "gamma three",
            lineStart: 2,
            lineEnd: 2,
            similarity: 0.9,
          },
        },
        detailsUiOnly: true,
      }),
    );
    // The message is the complete model-facing text — no `(code: …)` suffix,
    // no rendered details block.
    expect(views.ok).toBe(false);
    expect(views.modelText).toBe("string to replace not found");
    // The envelope still carries code/details for the UI/fullContent.
    expect(JSON.parse(views.fullContent)).toMatchObject({
      ok: false,
      error: {
        code: "edit_failed",
        detailsUiOnly: true,
        details: { suggestion: { lineStart: 2 } },
      },
    });
  });

  it("reports an empty success result without leaking the envelope JSON", () => {
    const views = deriveToolResultViews(ok());
    expect(views.modelText).toBe("(no result)");
  });

  it("appends a followUpHint to the model text so the nudge stays model-visible", () => {
    // The hint is a reserved, model-visible next-step nudge (e.g. git_commit
    // reminding the agent to reconcile workspace tickets). It must reach the
    // model, not just the UI, even though it is not part of `result`.
    const views = deriveToolResultViews(
      ok({ sha: "abc123" }, "Committed abc123", {
        followUpHint: "reconcile your tickets",
      }),
    );
    expect(views.modelText).toContain("sha: abc123");
    expect(views.modelText).toContain("reconcile your tickets");
    // The collapsed UI summary stays the short headline, hint-free.
    expect(views.summary).toBe("Committed abc123");
  });

  it("appends a followUpHint even when the success payload is empty", () => {
    const views = deriveToolResultViews(
      ok(undefined, undefined, { followUpHint: "do the thing" }),
    );
    expect(views.modelText).toBe("(no result)\n\ndo the thing");
  });

  it("prefers a tool-provided rendered view over the generic projection", () => {
    const views = deriveToolResultViews(
      ok({ mode: "files_with_matches", numFiles: 2 }, "Search completed.", {
        views: [{ type: "text", text: "Found 2 files" }],
      }),
    );
    expect(views.modelText).toBe("Found 2 files");
    // The envelope (with its rendered views) stays the fullContent for the UI.
    expect(JSON.parse(views.fullContent)).toEqual({
      ok: true,
      summary: "Search completed.",
      result: { mode: "files_with_matches", numFiles: 2 },
      views: [{ type: "text", text: "Found 2 files" }],
    });
  });

  it("joins multiple text views into the model text, mirroring MCP blocks", () => {
    const views = deriveToolResultViews(
      ok({ mode: "files_with_matches", numFiles: 1 }, "Search completed.", {
        views: [
          { type: "text", text: "sample.txt" },
          { type: "text", text: "2 matches" },
        ],
      }),
    );
    expect(views.modelText).toBe("sample.txt\n\n2 matches");
  });

  it("falls back to the payload when a text view is blank", () => {
    const views = deriveToolResultViews(
      ok("real payload", "done", { views: [{ type: "text", text: "  \n" }] }),
    );
    expect(views.modelText).toBe("real payload");
  });

  it("derives text from the payload when a result carries only an image view", () => {
    const views = deriveToolResultViews(
      ok({ path: "diagram.png", width: 640 }, "Read file: diagram.png", {
        views: [{ type: "image", data: "cGFnZQ==", mimeType: "image/png" }],
      }),
    );
    expect(views.modelText).toContain("path: diagram.png");
    expect(views.modelText).toContain("width: 640");
  });

  it("still appends a followUpHint after a tool-provided rendered view", () => {
    const views = deriveToolResultViews(
      ok({ a: 1 }, "one thing", {
        views: [{ type: "text", text: "rendered" }],
        followUpHint: "next step",
      }),
    );
    expect(views.modelText).toBe("rendered\n\nnext step");
  });

  it("round-trips a tool-provided rendered view through the persisted envelope", () => {
    const env = ok({ x: 1 }, "s", {
      views: [
        { type: "text", text: "rendered text" },
        { type: "image", data: "cGFnZQ==", mimeType: "image/png" },
      ],
    });
    expect(parseEnvelopeJson(serializeEnvelope(env))).toEqual(env);
  });

  it("keeps both views derivable from one envelope (parity)", () => {
    const env = ok({ a: 1 }, "one thing");
    const views = deriveToolResultViews(env);
    expect(views.ok).toBe(env.ok);
    expect(views.summary).toBe(deriveEnvelopeSummary(env));
    expect(views.fullContent).toBe(serializeEnvelope(env));
  });
});
