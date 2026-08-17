// Derives a short, human-friendly title for a conversation based on the
// first user message. Pure heuristic — no model call required.
//
// Goals: keep it readable in the sidebar (~5-7 words, <= 60 chars), strip
// markdown noise, prefer the first sentence/line, and gracefully fall back
// to "New chat" if there's nothing meaningful to extract.

const MAX_LEN = 60;
const MAX_WORDS = 8;
const DEFAULT_TITLE = "New chat";

export function deriveTitle(text: string): string {
  if (!text) return DEFAULT_TITLE;

  let s = text
    // Drop fenced code blocks entirely — they rarely make good titles.
    .replace(/```[\s\S]*?```/g, " ")
    // Inline code: keep the inner text.
    .replace(/`([^`]*)`/g, "$1")
    // Images / links: keep the label, drop the URL.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Markdown emphasis/heading markers.
    .replace(/^[\s>#*\-+]+/gm, " ")
    .replace(/[*_~]+/g, "")
    // Collapse whitespace.
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return DEFAULT_TITLE;

  // Prefer the first sentence if it's reasonably short.
  const sentenceEnd = s.search(/[.!?](?:\s|$)/);
  if (sentenceEnd > 0 && sentenceEnd < MAX_LEN) {
    s = s.slice(0, sentenceEnd);
  }

  const words = s.split(" ").filter(Boolean);
  if (words.length > MAX_WORDS) {
    s = words.slice(0, MAX_WORDS).join(" ");
  }

  if (s.length > MAX_LEN) {
    s = s
      .slice(0, MAX_LEN)
      .replace(/\s+\S*$/, "")
      .trim();
  }

  // Strip trailing punctuation that looks awkward in a title.
  s = s.replace(/[\s,;:.\-–—]+$/u, "").trim();

  if (!s) return DEFAULT_TITLE;

  // Capitalize the first letter without lowercasing the rest (preserves
  // identifiers, acronyms, etc.).
  return s[0].toUpperCase() + s.slice(1);
}

export function isDefaultTitle(title: string): boolean {
  return !title || title.trim() === DEFAULT_TITLE;
}
