import { describe, expect, test } from "vitest";
import { render } from "svelte/server";
import RoutingEditor from "../../src/lib/components/ui/RoutingEditor.svelte";
import { buildSort } from "../../src/lib/components/ui/routing";

function textOf(body: string): string {
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("RoutingEditor compat read-back", () => {
  test("summary reflects a saved routing object passed as initial", () => {
    const body = render(RoutingEditor, {
      props: {
        initial: { order: ["anthropic"], allow_fallbacks: true },
        onSave: () => {},
      },
    }).body;
    expect(textOf(body)).toContain("1 ordered");
    expect(textOf(body)).toContain("fallbacks on");
    expect(textOf(body)).not.toContain("not configured");
  });
});

describe("buildSort", () => {
  test("omits a blank sort at provider level", () => {
    expect(buildSort("", "inherit")).toBeUndefined();
  });

  test("preserves a blank sort to clear a model's inherited sort order", () => {
    expect(buildSort("", "inherit", true)).toEqual({});
  });

  test("preserves a partition while omitting a blank sort order", () => {
    expect(buildSort("", "model")).toEqual({ partition: "model" });
  });
});
