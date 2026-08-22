// Bundled pi extensions shipped with the portal.
//
// These are NOT a new extension `kind` or special-case in the loader — each is
// a snapshotted `inline`-kind source that the seed path (`ensureCavemanExtensionSeeded`)
// INSERTs per user so it surfaces in Settings → Extensions like any other row:
// toggleable, editable, deletable ("reset to default" re-INSERTs it). The DB
// row copies this source at seed time (snapshot semantics) — see the seed
// function's docs.

/**
 * The display name of the bundled caveman-style extension. This exact string is
 * the builtin's identity: the seed INSERT-matches on it (reserved name) and the
 * Settings UI's "Reset to bundled" uses it to render the button. Do not rename.
 */
export const CAVEMAN_STYLE_EXTENSION_NAME = "Caveman response style";

/**
 * The bundled "Respond like smart caveman…" guidance as a standalone pi
 * extension module. Appends the caveman block to the session's system prompt on
 * every `before_agent_start` (the per-turn hook pi provides for system-prompt
 * modification). The text is byte-identical to the guidance previously
 * hardcoded in `src/lib/server/runtime/system-guidance.ts`.
 */
export const CAVEMAN_STYLE_EXTENSION_SOURCE = [
  '// Bundled "smart caveman" response-style guidance (see builtin.ts).',
  "// Disable or edit this extension to change how the assistant phrases replies.",
  "export default function cavemanStyle(pi) {",
  "  pi.on('before_agent_start', (event) => {",
  "    const block = [",
  "      'Respond like smart caveman. Cut all filler, keep technical substance.',",
  "      '- Drop articles (a, an, the), filler (just, really, basically, actually).',",
  "      '- Drop pleasantries (sure, certainly, happy to).',",
  "      '- No hedging. Fragments fine. Short synonyms.',",
  "      '- Technical terms stay exact. Code blocks unchanged.',",
  "      '- Pattern: [thing] [action] [reason]. [next step].'",
  "    ].join('\\n');",
  "    if ((event.systemPrompt ?? '').includes('Respond like smart caveman')) {",
  "      return {}; // already applied — never double-append",
  "    }",
  "    return { systemPrompt: event.systemPrompt + '\\n\\n' + block };",
  "  });",
  "}",
  "",
].join("\n");
