// Per-turn "portal context" block prepended to the user's message before
// it's handed to the provider. Scope is deliberately narrow: only the
// genuinely *per-turn*, self-teaching reminder that the agent runs through a
// permission gateway and that reject `feedback` strings are the authoritative
// source of "why was that denied / what should I do instead". Re-asserting this
// each turn is worthwhile because rejections happen mid-turn; the deny
// `feedback` then self-teaches without us enumerating any grants.
//
// Standing, always-on guidance (structured-tool/git-tool preferences, ticket
// workflow, permission-grant policy) does NOT live here — it's delivered once
// per session through each provider's native system prompt channel. See
// `PORTAL_SYSTEM_GUIDANCE` in `system-guidance.ts`. Keeping it out of the
// prelude avoids re-paying those tokens on every turn.
//
// IMPORTANT: nothing here is authoritative. Allow/deny decisions are
// enforced by the matcher in `permissions/matcher.ts`.

export const PORTAL_PRELUDE = [
  "[Portal context — auto-injected; not authored by the user]",
  "Tool calls run through a permission gateway. On reject, the `feedback` string is",
  "authoritative — read it and adapt.",
  "[/Portal context]",
].join("\n");
