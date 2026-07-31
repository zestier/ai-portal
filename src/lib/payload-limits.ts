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
