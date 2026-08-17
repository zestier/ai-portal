import { describe, it, expect } from "vitest";
import {
  THEME_ACCENT_IDS,
  faviconDataUri,
  normalizeThemeAccent,
  themeAccentHex,
  type ThemeAccent,
} from "../src/lib/types";

describe("theme accents", () => {
  it("normalizes unknown/empty accents to default", () => {
    expect(normalizeThemeAccent(undefined)).toBe("default");
    expect(normalizeThemeAccent(null)).toBe("default");
    expect(normalizeThemeAccent("")).toBe("default");
    expect(normalizeThemeAccent("not-a-color")).toBe("default");
    expect(normalizeThemeAccent("violet")).toBe("violet");
  });

  it("exposes a hex for every accent id", () => {
    for (const id of THEME_ACCENT_IDS) {
      expect(themeAccentHex(id)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("default accent hex matches the favicon/source-of-truth blue", () => {
    expect(themeAccentHex("default")).toBe("#1f6feb");
  });

  it("renders a data:image/svg+xml favicon tinted with the accent hex", () => {
    for (const id of THEME_ACCENT_IDS) {
      const uri = faviconDataUri(id);
      expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
      // The colour is URL-encoded in the data URI (# -> %23).
      const decoded = decodeURIComponent(
        uri.slice("data:image/svg+xml,".length),
      );
      expect(decoded).toContain(`fill="${themeAccentHex(id)}"`);
      expect(decoded).toContain("<svg");
    }
  });

  it("falls back to the default hex for an out-of-range accent", () => {
    expect(themeAccentHex("bogus" as ThemeAccent)).toBe("#1f6feb");
  });
});
