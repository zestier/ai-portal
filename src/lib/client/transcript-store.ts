// Client-side transcript store for the backend-projected transcript.
//
// The page `load` and `GET /api/conversations/[id]` ship a bounded projection
// (a hydrated tail + an index of older messages; see
// `src/lib/server/present/transcript.ts`). This module turns that into the
// sparse state the chat renders from:
//
//   - `entries` — every message in order as an index entry (id/role/status/
//     preview/record descriptors). The index rows and the windowed renderer
//     read from here; the entries also hold the "demoted" view of any message
//     whose full body isn't currently cached.
//   - `bodies` — hydrated `DisplayMessage`s, keyed by id, LRU-capped. The
//     streaming tail (live SSE) is always hydrated; older messages hydrate on
//     demand via `GET /api/conversations/[id]/messages/[messageId]` and can be
//     evicted back to index rows.
//
// The store is deliberately a plain module of pure functions over a
// `TranscriptState` snapshot — the component wraps the snapshot in `$state`
// for reactivity and calls these to mutate it. This keeps the logic unit
// testable without the Svelte compiler.
//
// Messages are immutable except inline-edit/regenerate, so once an older body
// is hydrated it stays correct until a truncation (`truncateAfter`) or a
// refresh that reports a smaller conversation.
//
// `bodies` is a plain object, NOT a `Map`: Svelte 5's `$state` deep proxy
// wraps plain objects and arrays, but returns `Map`/`Set` instances raw, so
// an in-place mutation of a value stored in a `$state` Map never invalidates
// any reactive reads (the streamed `message.delta` content updates would not
// re-render until some unrelated tracked state changed — the live-streaming
// regression this structure guards against). Keyed by `String(id)`.

import type { TranscriptIndexEntry, TranscriptProjection } from "$lib/types";
import type { DisplayId, DisplayMessage } from "./display-message";
import { summarizeToolCall } from "$lib/tool-summary";

/**
 * One message in the client's transcript index. Server index entries carry
 * INTEGER ids; live/optimistic messages (local-/err- bubbles, the thinking
 * placeholder) widen to `DisplayId`.
 */
export type TranscriptEntry = Omit<TranscriptIndexEntry, "id"> & {
  id: DisplayId;
};

export interface TranscriptState {
  /** Every message in the loaded window, in transcript order. */
  entries: TranscriptEntry[];
  /** Hydrated bodies keyed by message id — a plain object (not a Map) so
   * Svelte's deep proxy wraps each body and in-place content mutations are
   * reactive (see the module comment). */
  bodies: Record<string, DisplayMessage>;
  /** True when index pages older than `entries[0]` remain on the server. */
  hasMoreOlder: boolean;
}

export function emptyState(): TranscriptState {
  return { entries: [], bodies: {}, hasMoreOlder: false };
}

// ---------------------------------------------------------------------------
// Client-side projection helpers (mirror the server's, for live messages that
// stream in without a server summary).
// ---------------------------------------------------------------------------

function clientPreview(
  content: string | null,
  maxChars: number,
): string | null {
  if (!content) return null;
  const oneLine = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (oneLine.length === 0) return null;
  if (oneLine.length <= maxChars) return oneLine;
  const cut = oneLine.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const end = lastSpace > maxChars * 0.6 ? lastSpace : maxChars;
  return `${cut.slice(0, end).replace(/[,\s]+$/, "")}…`;
}

// A live-streamed tool call has no server summary; derive one the same way the
// server does (shared `summarizeToolCall`) so a demoted row stays accurate.
export function entryFromMessage(m: DisplayMessage): TranscriptEntry {
  const records: TranscriptIndexEntry["records"] = [];
  for (const t of m.toolCalls ?? []) {
    records.push({
      kind: "tool",
      id: t.id,
      tool: t.tool,
      status: t.status,
      textOffset: t.textOffset,
      parentToolCallId: t.parentToolCallId,
      summary: summarizeToolCall(t.tool, t.argsJson) ?? t.tool,
      ...(t.meta ? { meta: t.meta } : {}),
    });
  }
  for (const e of m.fileEdits ?? []) {
    records.push({
      kind: "edit",
      id: e.id,
      path: e.path,
      textOffset: e.textOffset,
      parentToolCallId: e.parentToolCallId,
      summary: e.summary ?? e.path,
    });
  }
  for (const r of m.reasoningBlocks ?? []) {
    const preview = clientPreview(r.text, 120);
    records.push({
      kind: "reasoning",
      id: r.id,
      reasoningKind: r.kind,
      textOffset: r.textOffset,
      durationMs: r.durationMs,
      parentToolCallId: r.parentToolCallId,
      summary:
        r.summary ??
        (r.kind === "content" ? (preview ?? "(content)") : "Thinking…"),
    });
  }
  return {
    id: m.id,
    role: m.role,
    status: m.status,
    errorCode: m.errorCode,
    createdAt: m.createdAt,
    preview: clientPreview(m.content, 300),
    records,
  };
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

/** Seed from a server projection (page load or full refresh). */
export function initState(p: TranscriptProjection): TranscriptState {
  const bodies: Record<string, DisplayMessage> = {};
  for (const m of p.tail) {
    bodies[String(m.id)] = m as DisplayMessage;
  }
  return {
    entries: [
      ...p.index.map((e) => ({ ...e })),
      ...p.tail.map(entryFromMessage),
    ],
    bodies,
    hasMoreOlder: p.hasMoreOlder,
  };
}

/** Append a live message (SSE `message.start`, optimistic user bubble, error). */
export function appendMessage(
  state: TranscriptState,
  body: DisplayMessage,
): void {
  state.entries.push(entryFromMessage(body));
  state.bodies[String(body.id)] = body;
}

/**
 * Apply `fn` to a message's hydrated body. Returns true when the body was
 * present (so callers know an in-place mutation happened); when the body is
 * absent the entry is left to be re-fetched on next hydration and the event
 * must not crash.
 */
export function applyToMessage(
  state: TranscriptState,
  id: DisplayId,
  fn: (m: DisplayMessage) => void,
): boolean {
  const body = state.bodies[String(id)];
  if (!body) return false;
  fn(body);
  syncEntry(state, id);
  return true;
}
/**
 * Store a freshly fetched body (hydration), refreshing its entry meta.
 * (Eviction order is the plain-object key order — numeric ids ascending,
 * oldest-first — which is the right policy for a transcript body cache.)
 */
export function hydrate(
  state: TranscriptState,
  id: DisplayId,
  body: DisplayMessage,
): void {
  state.bodies[String(id)] = body;
  syncEntry(state, id);
}

/** Refresh an entry's meta/descriptors from its hydrated body. */
export function syncEntry(state: TranscriptState, id: DisplayId): void {
  const body = state.bodies[String(id)];
  if (!body) return;
  const entry = state.entries.find((e) => e.id === id);
  if (!entry) return;
  entry.role = body.role;
  entry.status = body.status;
  entry.errorCode = body.errorCode;
  entry.createdAt = body.createdAt;
  const fresh = entryFromMessage(body);
  entry.preview = fresh.preview;
  entry.records = fresh.records;
}

/** Re-key a message after its optimistic string id is confirmed (POST turn). */
export function replaceId(
  state: TranscriptState,
  from: DisplayId,
  to: DisplayId,
): void {
  const entry = state.entries.find((e) => e.id === from);
  if (entry) entry.id = to;
  const body = state.bodies[String(from)];
  if (body) {
    body.id = to;
    delete state.bodies[String(from)];
    state.bodies[String(to)] = body;
  }
}

/** Remove one message (failed optimistic send rollback). */
export function removeMessage(state: TranscriptState, id: DisplayId): void {
  state.entries = state.entries.filter((e) => e.id !== id);
  delete state.bodies[String(id)];
}

/**
 * Evict least-recently-used bodies beyond `cap`, keeping `pinned` ids (the
 * streaming tail must never unmount). Returns the ids that were dropped.
 * Pinned ids are matched against `String(id)` keys (and their numeric form).
 */
export function evictLRU(
  state: TranscriptState,
  cap: number,
  pinned: Set<DisplayId>,
): DisplayId[] {
  const dropped: DisplayId[] = [];
  while (Object.keys(state.bodies).length > cap) {
    let victim: string | null = null;
    for (const key of Object.keys(state.bodies)) {
      if (pinned.has(key) || pinned.has(Number(key))) continue;
      victim = key;
      break;
    }
    if (victim === null) break; // everything is pinned
    delete state.bodies[victim];
    dropped.push(victim);
  }
  return dropped;
}

/**
 * Inline edit / regenerate: the server discarded everything after `messageId`.
 * Drop entries and bodies after it; the replacement turn streams in fresh.
 */
export function truncateAfter(state: TranscriptState, id: DisplayId): void {
  const index = state.entries.findIndex((e) => e.id === id);
  if (index < 0) {
    state.entries = [];
    state.bodies = {};
    return;
  }
  state.entries = state.entries.slice(0, index + 1);
  const kept = new Set(state.entries.map((e) => String(e.id)));
  for (const key of Object.keys(state.bodies)) {
    if (!kept.has(key)) delete state.bodies[key];
  }
}

/** Prepend an older index page (load-older). */
export function prependIndexPage(
  state: TranscriptState,
  entries: TranscriptEntry[],
  hasMore: boolean,
): void {
  // Drop duplicates defensively (a re-entrant fetch or a truncation race).
  const existing = new Set(state.entries.map((e) => e.id));
  state.entries = [
    ...entries.filter((e) => !existing.has(e.id)),
    ...state.entries,
  ];
  state.hasMoreOlder = hasMore;
}

/**
 * Refresh / stream recovery: merge the server's projection into local state.
 * The server's tail is authoritative for the newest messages; older index
 * entries and their hydrated bodies are immutable, so they're kept unless a
 * truncation happened server-side (detected by the newest message moving
 * backwards), in which case the store resets to the fresh projection.
 */
export function mergeRefresh(
  state: TranscriptState,
  p: TranscriptProjection,
): void {
  const lastLocal =
    state.entries.length > 0 ? state.entries[state.entries.length - 1] : null;
  const lastServer = p.tail.length > 0 ? p.tail[p.tail.length - 1] : null;
  const truncated =
    (lastServer === null && lastLocal !== null) ||
    (lastServer !== null &&
      lastLocal !== null &&
      Number(lastServer.id) < Number(lastLocal.id));
  if (truncated || state.entries.length === 0) {
    const fresh = initState(p);
    state.entries = fresh.entries;
    state.bodies = fresh.bodies;
    state.hasMoreOlder = fresh.hasMoreOlder;
    return;
  }
  // Replace the tail section (newest messages) in place; keep everything older.
  const tailIds = new Set<DisplayId>(p.tail.map((m) => m.id));
  state.entries = [
    ...state.entries.filter((e) => !tailIds.has(e.id)),
    ...p.tail.map(entryFromMessage),
  ];
  const newBodies: Record<string, DisplayMessage> = {};
  for (const m of p.tail) newBodies[String(m.id)] = m as DisplayMessage;
  // Keep bodies for entries that survived (they're immutable).
  for (const e of state.entries) {
    const existing = state.bodies[String(e.id)];
    if (existing && !tailIds.has(e.id)) newBodies[String(e.id)] = existing;
  }
  state.bodies = newBodies;
  state.hasMoreOlder = p.hasMoreOlder;
}
