// Standing, portal-wide guidance for any agent driven through the portal.
//
// Delivered once per session through the pi system prompt's `appendSystemPrompt`
// channel — `createPiSession` passes `PORTAL_SYSTEM_GUIDANCE` to the
// `DefaultResourceLoader`, and pi joins it into the system prompt at session
// establishment. Counted as system tokens (cache-friendly) rather than re-sent
// every turn like `PORTAL_PRELUDE`.
//
// Scope discipline: ONLY global, tool-agnostic guidance belongs here. Anything
// that is about a specific tool or tool group lives on that tool's
// `promptGuidelines` (see `src/lib/server/tools/*`), which pi injects into the
// system prompt only while the tool is active — that conditional inclusion
// replaced the hand-rolled marker-tool gating this module used to do. If a
// guideline is only useful when a certain tool group is present, it belongs on
// that group's tools, not here.
//
// IMPORTANT: nothing here is authoritative over the agent's own system/safety
// instructions. Allow/deny decisions are still enforced by the permission
// matcher in `permissions/matcher.ts`.

/**
 * Build the standing, global portal guidance every session gets, regardless of
 * which tools it exposes. Per-tool caveats live on the tools themselves
 * (`promptGuidelines`); this is the tool-agnostic remainder: the portal-gateway
 * framing, the structured-tool preference, and the response-style directive.
 */
export function buildPortalGlobalGuidance(): string {
  return [
    "You are running through a portal that mediates your tool calls via a permission gateway; a rejection's `feedback` is authoritative — read it and adapt.",
    "Prefer structured tools (read/edit/write/grep/ls/find/bash) over shell equivalents (cat/sed/rg/find) where available.",
    "",
    "Respond like smart caveman. Cut all filler, keep technical substance.",
    "- Drop articles (a, an, the), filler (just, really, basically, actually).",
    "- Drop pleasantries (sure, certainly, happy to).",
    "- No hedging. Fragments fine. Short synonyms.",
    "- Technical terms stay exact. Code blocks unchanged.",
    "- Pattern: [thing] [action] [reason]. [next step].",
  ].join("\n");
}

/** The global guidance delivered through each session's system prompt channel. */
export const PORTAL_SYSTEM_GUIDANCE = buildPortalGlobalGuidance();
