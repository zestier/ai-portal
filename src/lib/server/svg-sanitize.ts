// Server-side SVG hardening for inline rendering.
//
// SVG is active content: it can carry <script>, on* event handlers, and external
// references (foreignObject HTML, <image href=http://…>, xlink, CSS url()) that
// turn an "image" into an XSS / SSRF / tracking vector. We render SVGs via <img>
// with a `default-src 'none'; sandbox` CSP + nosniff (scripts inert, subresources
// blocked), but a user may also open the raw bytes directly in a new tab — so the
// bytes themselves must be safe. This module is the at-rest defense: DOMPurify's
// SVG profile (over a jsdom DOM) strips scripts, handlers, and external refs, so a
// sanitized SVG is safe to store, serve, and open directly regardless of surface.
//
// DOMPurify (not a regex) is the parser-faithful, maintained choice; it needs a
// DOM, so we run it against a single shared jsdom window.

import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

// Mirror MAX_IMAGE_PREVIEW_BYTES (1.5MB): large enough for real icons/diagrams,
// small enough that the parse/sanitize pass stays cheap. Larger SVGs are
// rejected. Kept in sync with MAX_IMAGE_PREVIEW_BYTES by the test suite.
export const MAX_SVG_BYTES = 1.5 * 1024 * 1024;

const SVG_ROOT_RE = /<svg[\s>]/i;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

// One window/purify instance for the process; SVG sanitization is stateless.
// It is dedicated to SVG — the external-ref hook below would also fire on any
// other markup, so do not reuse this instance for general HTML sanitization.
const purify = createDOMPurify(
  new JSDOM("").window as unknown as Parameters<typeof createDOMPurify>[0],
);

// DOMPurify's SVG profile keeps <image href="http://…">/<use xlink:href> with
// external URLs, which trigger network fetches (tracking / SSRF-lite) even when
// scripts are inert. Drop any href/xlink:href/src that isn't a same-document
// fragment or an inline data:image — belt-and-suspenders with the serve-time
// CSP, and what makes a directly-opened SVG safe.
purify.addHook("uponSanitizeAttribute", (_node, data) => {
  const name = data.attrName;
  if (name !== "href" && name !== "xlink:href" && name !== "src") return;
  const v = (data.attrValue || "").trim().toLowerCase();
  if (v.startsWith("#") || v.startsWith("data:image/")) return;
  data.keepAttr = false;
});

/**
 * Harden raw SVG text. Returns sanitized SVG markup, or null when the input is
 * empty, too large, or doesn't look like / doesn't survive as an SVG document.
 * Uses DOMPurify's SVG profile: scripts, event handlers, foreignObject, and
 * external/javascript refs are removed. Synchronous and safe to run per-serve.
 */
export function sanitizeSvg(input: string | Buffer): string | null {
  const text = typeof input === "string" ? input : input.toString("utf-8");
  if (text.length === 0 || Buffer.byteLength(text, "utf-8") > MAX_SVG_BYTES)
    return null;
  if (!SVG_ROOT_RE.test(text)) return null;
  const clean = purify.sanitize(text, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignObject"],
    ADD_ATTR: ["viewBox", "xmlns", "preserveAspectRatio"],
  });
  if (!clean || !SVG_ROOT_RE.test(clean)) return null;
  return clean;
}

/** True when bytes look like an SVG document (cheap, head-only sniff). */
export function looksLikeSvg(head: Uint8Array): boolean {
  // Scan a generous head and ignore comments so a large XML prolog or
  // leading comment block before <svg> doesn't hide the root element.
  const s = Buffer.from(head.subarray(0, 8192))
    .toString("utf-8")
    .replace(COMMENT_RE, "");
  return SVG_ROOT_RE.test(s);
}
