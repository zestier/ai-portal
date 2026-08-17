import { describe, it, expect } from "vitest";
import {
  sanitizeSvg,
  looksLikeSvg,
  MAX_SVG_BYTES,
} from "../../src/lib/server/svg-sanitize";
import { MAX_IMAGE_PREVIEW_BYTES } from "../../src/lib/server/image-detect";

const wrap = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">${inner}</svg>`;

describe("sanitizeSvg", () => {
  it("keeps benign SVG markup", () => {
    const svg = wrap('<rect x="0" y="0" width="10" height="10" fill="#0a0"/>');
    const out = sanitizeSvg(svg)!;
    expect(out).toContain("<svg");
    expect(out).toContain('fill="#0a0"');
    expect(out).toMatch(/<rect/);
  });

  it("strips <script> elements", () => {
    const out = sanitizeSvg(wrap("<script>alert(1)</script><rect/>"))!;
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("<rect");
  });

  it("strips an unterminated trailing <script>", () => {
    const out = sanitizeSvg(wrap("<rect/><script>while(true){}"))!;
    expect(out).not.toMatch(/<script/i);
  });

  it("removes on* event-handler attributes", () => {
    const out = sanitizeSvg(wrap("<rect onload=\"alert(1)\" onclick='x()'/>"))!;
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain("<rect");
  });

  it("drops foreignObject (embedded HTML) content", () => {
    const out = sanitizeSvg(
      wrap(
        "<foreignObject><body><img src=x onerror=alert(1)></body></foreignObject><rect/>",
      ),
    )!;
    expect(out).not.toMatch(/foreignObject/i);
    expect(out).not.toMatch(/onerror/i);
  });

  it("removes javascript: and external href/src refs but keeps fragment refs", () => {
    const out = sanitizeSvg(
      wrap(
        '<a href="javascript:alert(1)"/><a href="#ok"/><image href="http://evil/x.png"/>',
      ),
    )!;
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/http:\/\/evil/);
    expect(out).toContain("#ok");
  });

  it("strips DOCTYPE/ENTITY preludes", () => {
    const out = sanitizeSvg(
      '<!DOCTYPE svg [<!ENTITY x "boom">]>' + wrap("<rect/>"),
    )!;
    expect(out).not.toMatch(/DOCTYPE/i);
    expect(out).not.toMatch(/ENTITY/i);
  });

  it("rejects non-SVG and oversized input", () => {
    expect(sanitizeSvg("hello world")).toBeNull();
    expect(sanitizeSvg("")).toBeNull();
    expect(sanitizeSvg(wrap("x").padEnd(MAX_SVG_BYTES + 1, " "))).toBeNull();
  });

  it("accepts a Buffer", () => {
    expect(sanitizeSvg(Buffer.from(wrap("<rect/>")))).toContain("<svg");
  });
});

describe("looksLikeSvg", () => {
  it("matches an SVG head", () => {
    expect(looksLikeSvg(Buffer.from('<svg xmlns="x">'))).toBe(true);
    expect(looksLikeSvg(Buffer.from("  <?xml ?>\n<svg >"))).toBe(true);
  });
  it("matches when a long comment/prolog precedes <svg", () => {
    const prelude = '<?xml version="1.0"?>\n<!--' + "x".repeat(2000) + "-->\n";
    expect(looksLikeSvg(Buffer.from(prelude + '<svg xmlns="x">'))).toBe(true);
  });
  it("rejects non-SVG", () => {
    expect(looksLikeSvg(Buffer.from("<html>"))).toBe(false);
    expect(looksLikeSvg(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
  });
});

describe("MAX_SVG_BYTES", () => {
  it("stays in sync with the image preview ceiling", () => {
    expect(MAX_SVG_BYTES).toBe(MAX_IMAGE_PREVIEW_BYTES);
  });
});
