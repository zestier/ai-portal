import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { render } from "svelte/server";
import { compile } from "svelte/compiler";
import RoutingEditor from "../../src/lib/components/ui/RoutingEditor.svelte";
import { buildSort } from "../../src/lib/components/ui/routing";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const componentSource = readFileSync(
  resolve(__dirname, "../../src/lib/components/ui/RoutingEditor.svelte"),
  "utf-8",
);

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

describe("RoutingEditor tag inputs (mobile keyboard)", () => {
  // The tag inputs only render once the editor is opened (`editing = true`),
  // which is set by a button click — unreachable from the SSR `render` path
  // above. The Svelte compiler natively strips the `lang="ts"` script, so
  // compile the component and assert the mobile keyboard hint is emitted in
  // the DOM render code for the tag inputs, with the Enter keydown handler
  // intact. (A live client-mount test would require jsdom + svelte browser
  // conditions; tracked as a future upgrade below.)
  // ponytail: upgrade path — jsdom + `mount` of the opened editor.
  test("tag-input fields emit enterKeyHint=enter for mobile keyboards", () => {
    const { js } = compile(componentSource, {
      generate: "client",
      filename: "RoutingEditor.svelte",
    });
    const code = js.code.toLowerCase();
    // Svelte emits HTML attribute names lowercased, so match case-insensitively.
    expect(code).toContain("enterkeyhint");
    // Enter keydown handler (addTag) must remain intact — only the hint attr
    // was added.
    expect(code).toContain("addtag");
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
