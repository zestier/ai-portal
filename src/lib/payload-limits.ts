// Size boundaries for "ship this field inline in the page payload" vs. "ship a
// marker and let the client fetch it on demand".
//
// Opening a long conversation used to serialize every tool call's full
// `args_json` / `result_json` and every file edit's `diff` into the page
// payload — megabytes of text for content that is collapsed by default and
// rarely read. Fields at or under these thresholds still travel inline, so the
// common case renders with zero extra requests; anything larger is replaced by
// a truncation marker and fetched from
// `/api/conversations/[id]/fields/[kind]/[recordId]` on demand.
//
// Two different bars, because the two field families are read at different
// times:
//
//   - `args_json` and `file_edits.diff` are rendered *without* an expand: the
//     collapsed tool-call summary line is derived from the args, and a file
//     edit's diff is part of the message body. Trimming those costs a visible
//     round trip, so the bar is generous.
//   - `result_json` is never rendered until the user opens the card, and it is
//     by far the largest slice of a long conversation (1.62 MB of 2.25 MB in
//     the worst real thread measured). A tight bar keeps trivial results —
//     `(ok)`, a short status line — inline while moving the bulk off the
//     page-open path.
//   - `reasoning_blocks.text` is like `result_json`: a reasoning block renders
//     COLLAPSED unless it is actively streaming, so its text is never on screen
//     when a conversation is opened. Reasoning blocks are individually small
//     (~700 B mean in the real threads measured) but numerous, so the bar has
//     to be tight to move a useful share of them off the open path. Only
//     `kind = 'reasoning'` blocks that have already closed are trimmed — a
//     sub-agent's `kind = 'content'` block is its spoken answer, rendered
//     unconditionally, and a still-open block is being streamed into right now.
//
// Measured in UTF-8 bytes, matching SQLite's `length(CAST(x AS blob))`.
export const INLINE_ARGS_MAX_BYTES = 2048;
export const INLINE_RESULT_MAX_BYTES = 512;
export const INLINE_DIFF_MAX_BYTES = 2048;
export const INLINE_REASONING_MAX_BYTES = 512;

// --- Backend-projected transcript (BFF presentation layer) ---

// --- Backend-projected transcript (BFF presentation layer) ---
//
// The conversation-open payload no longer ships the whole transcript. It
// carries a short hydrated tail plus an index of older messages (see
// `src/lib/server/present/transcript.ts`), so the page payload is *bounded
// regardless of conversation length*. These constants tune that window; the
// bench (`scripts/bench-conversation-load.mjs`) asserts the resulting payload
// size, mounted-card count and TTI.
//
// The tail messages are fully hydrated — content + records — but their
// records ship with the *initial* limits below (much tighter than
// INLINE_*_MAX_BYTES): collapsed cards render from the server-computed
// `summary` / `meta` instead of raw args, so there is no reason to push raw
// fields for the initial view. Expanding a card (or hydrating an older
// message via `/messages/[messageId]`) fetches the real field with the
// generous limits above.
export const INITIAL_INLINE_ARGS_MAX_BYTES = 128;
export const INITIAL_INLINE_RESULT_MAX_BYTES = 128;
export const INITIAL_INLINE_DIFF_MAX_BYTES = 256;
export const INITIAL_INLINE_REASONING_MAX_BYTES = 256;
// `task` args stay inline on the hydration path (they ARE the subagent card's
// identity), but on the initial page payload they are capped too — the card
// renders from `meta` (agent type / model / background id) instead.
export const INITIAL_INLINE_TASK_ARGS_MAX_BYTES = 512;

// How many newest messages arrive fully hydrated on page open. Tuned so the
// bench seed (100 msgs / 600 tools / 180 reasoning / 2.43 MB at rest) lands
// the initial payload under the ~40 KB target (D7); D3's 25/100 defaults would
// ship ~5x that on this seed, so the window is smaller and the load-older
// paging does the rest.
export const TRANSCRIPT_HYDRATED_TAIL = 6;
// How many older messages arrive as index entries alongside the tail.
export const TRANSCRIPT_INDEX_COUNT = 10;
// Batch size for `GET /api/conversations/[id]/messages?beforeId=` paging.
export const TRANSCRIPT_OLDER_PAGE_SIZE = 50;
// Preview cut for index entries (plain text, word/line boundary).
export const TRANSCRIPT_INDEX_PREVIEW_MAX_CHARS = 300;
// Client-side cap on cached hydrated bodies (LRU). Bodies beyond this are
// dropped back to index rows; re-scrolling re-hydrates on demand.
export const TRANSCRIPT_BODY_CACHE_MAX = 100;
