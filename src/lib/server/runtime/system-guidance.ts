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
 * framing and the structured-tool preference.
 *
 * The former response-style directive ("Respond like smart caveman…") moved to
 * a bundled, operator-managed extension (see `extensions/builtin.ts`) — it now
 * ships as an enabled `inline` extension row seeded per user, one toggle away
 * in Settings → Extensions.
 */
export function buildPortalGlobalGuidance(): string {
  return [
    "Portal mediates tool calls through a permission gateway. Rejection `feedback` is authoritative; read and adapt.",
    "Prefer structured tools (read/edit/write/grep/ls/find/bash) over shell equivalents (cat/sed/rg/find).",
  ].join("\n");
}

/** The global guidance delivered through each session's system prompt channel. */
export const PORTAL_SYSTEM_GUIDANCE = buildPortalGlobalGuidance();

/** Stable semantic-mode suffix. Dynamic task and transaction data never belong here. */
export const SEMANTIC_SYSTEM_GUIDANCE = [
  "You have proc and ask_user; no direct workspace tools.",
  "You own diagnosis, method, relevance criteria, and consequential decisions. Proc executes specified procedures, not open-ended investigations.",
  "If proc needs an instruction or human decision, resolve it here, using ask_user if needed, then call proc again.",
].join("\n");
