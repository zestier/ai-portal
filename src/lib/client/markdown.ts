// Client-side markdown rendering with sanitization.

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

// ADD_ATTR allow-lists target/rel globally for every element, so restrict them
// to anchors: strip target/rel from non-anchor elements, and harden anchors that
// open in a new context with rel="noopener noreferrer".
function restrictTargetRelToAnchors(node: Node): void {
  const el = node as Element;
  if (typeof el.tagName !== "string") return;
  if (el.tagName !== "A") {
    el.removeAttribute("target");
    el.removeAttribute("rel");
  } else if (el.hasAttribute("target")) {
    el.setAttribute("rel", "noopener noreferrer");
  }
}

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  // Scope the hook to this sanitize call rather than mutating the shared
  // DOMPurify singleton for the whole app; remove it afterward so other
  // callers are unaffected.
  DOMPurify.addHook("afterSanitizeAttributes", restrictTargetRelToAnchors);
  try {
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target", "rel"],
    });
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}
