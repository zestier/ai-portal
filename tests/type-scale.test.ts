import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...svelteFiles(full));
    } else if (entry.endsWith(".svelte")) {
      out.push(full);
    }
  }
  return out;
}

// Capture the value of every `font-size:` declaration found inside a <style> block.
const STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const FONT_SIZE_DECL = /font-size\s*:\s*([^;}{]+)/gi;

// A value is allowed when it routes through the shared type scale (a CSS var) or
// uses a non-numeric keyword (inherit, etc.). Raw px/em/rem/% literals are banned —
// they bypass the --fs-* tokens defined in src/app.css.
function isAllowedFontSize(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("var(")) return true;
  return !/[0-9]/.test(trimmed);
}

describe("type scale adoption", () => {
  test("component <style> blocks never hard-code raw font-size values", () => {
    const offenders: string[] = [];

    for (const file of svelteFiles(srcDir)) {
      const source = readFileSync(file, "utf8");
      let styleMatch: RegExpExecArray | null;
      STYLE_BLOCK.lastIndex = 0;
      while ((styleMatch = STYLE_BLOCK.exec(source))) {
        const css = styleMatch[1];
        let declMatch: RegExpExecArray | null;
        FONT_SIZE_DECL.lastIndex = 0;
        while ((declMatch = FONT_SIZE_DECL.exec(css))) {
          const value = declMatch[1];
          if (!isAllowedFontSize(value)) {
            const rel = file.slice(srcDir.length + 1);
            offenders.push(`${rel}: font-size: ${value.trim()}`);
          }
        }
      }
    }

    expect(
      offenders,
      `Use a --fs-* token from src/app.css instead of a raw font-size:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
