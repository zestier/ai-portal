// Backend-projected transcript (BFF presentation layer).
//
// Long conversations ship as a compact, ready-to-render *projection* instead
// of raw rows. The server shapes raw rows into:
//
//   - a short hydrated tail (full message bodies, records trimmed to
//     markers) — `projectTranscript().tail`;
//   - an index of older messages: per message a plain-text preview plus
//     per-record descriptors (tool `summary` / edit path+diffstat / reasoning
//     duration+preview) — `projectTranscript().index`, paged by
//     `projectIndexPage()`;
//   - single-message bodies for on-demand hydration —
//     `projectMessageForOwner()`.
//
// Summaries are computed here at read time from the stored rows (local
// SQLite reads are cheap; the *wire* payload shrinks). The client stops
// deriving collapsed summaries from raw `args_json` / diffs / reasoning text
// and only fetches individual large fields (`/fields/...`) or full message
// bodies (`/messages/[messageId]`) as late as possible.
//
// No args/results/diffs/reasoning text ships in the initial list payload:
// `tail` records are trimmed with the tight INITIAL_* limits below (collapsed
// cards render from `summary` / `meta`), and index entries carry descriptors
// only. The hydration path applies the generous INLINE_*_MAX_BYTES limits so
// a hydrated message behaves like today's trimmed page payload.

import type {
  FileEditRecord,
  Message,
  ReasoningBlockRecord,
  ToolCallRecord,
  TranscriptIndexEntry,
  TranscriptProjection,
  TranscriptRecordDescriptor,
} from "$lib/types";
import { conversationId as convCodec, messageId as msgCodec } from "$lib/ids";
import { summarizeToolCall } from "$lib/tool-summary";
import * as messagesRepo from "$lib/server/db/repos/messages";
import {
  INITIAL_INLINE_ARGS_MAX_BYTES,
  INITIAL_INLINE_DIFF_MAX_BYTES,
  INITIAL_INLINE_REASONING_MAX_BYTES,
  INITIAL_INLINE_RESULT_MAX_BYTES,
  INITIAL_INLINE_TASK_ARGS_MAX_BYTES,
  INLINE_ARGS_MAX_BYTES,
  INLINE_DIFF_MAX_BYTES,
  INLINE_REASONING_MAX_BYTES,
  INLINE_RESULT_MAX_BYTES,
  TRANSCRIPT_HYDRATED_TAIL,
  TRANSCRIPT_INDEX_COUNT,
  TRANSCRIPT_INDEX_PREVIEW_MAX_CHARS,
} from "$lib/payload-limits";

// ---------------------------------------------------------------------------
// Trim rules
// ---------------------------------------------------------------------------

interface TrimRules {
  /** Non-task args cap (bytes); larger → marker + lazy fetch. */
  args: number;
  /** `task` args cap; `null` = always inline (their args ARE the card). */
  taskArgs: number | null;
  result: number;
  diff: number;
  /** Closed `kind='reasoning'` block text cap. */
  reasoning: number;
}

// The conversation-open payload: collapsed cards render from server-computed
// summaries, so almost nothing ships inline. `task` args get their own (still
// tight) cap — the card renders from `meta` instead.
const INITIAL_RULES: TrimRules = {
  args: INITIAL_INLINE_ARGS_MAX_BYTES,
  taskArgs: INITIAL_INLINE_TASK_ARGS_MAX_BYTES,
  result: INITIAL_INLINE_RESULT_MAX_BYTES,
  diff: INITIAL_INLINE_DIFF_MAX_BYTES,
  reasoning: INITIAL_INLINE_REASONING_MAX_BYTES,
};

// The on-demand hydration path: generous inline limits, `task` args always
// inline (they ARE the subagent card's identity), matching the pre-projection
// page payload exactly.
const HYDRATION_RULES: TrimRules = {
  args: INLINE_ARGS_MAX_BYTES,
  taskArgs: null,
  result: INLINE_RESULT_MAX_BYTES,
  diff: INLINE_DIFF_MAX_BYTES,
  reasoning: INLINE_REASONING_MAX_BYTES,
};

function bytesOf(s: string): number {
  return new TextEncoder().encode(s).length;
}

function trimmed(
  value: string | null,
  limit: number,
  alwaysInline: boolean,
): { value: string | null; truncated: boolean; bytes: number } {
  if (value === null) return { value: null, truncated: false, bytes: 0 };
  const bytes = bytesOf(value);
  if (alwaysInline || bytes <= limit) return { value, truncated: false, bytes };
  return { value: null, truncated: true, bytes };
}

// ---------------------------------------------------------------------------
// Plain-text previews
// ---------------------------------------------------------------------------

// A cheap plain-text projection of markdown content: strip fences, inline
// code, images, links, headings and emphasis markers, then collapse
// whitespace. Kept deliberately simple — it only feeds collapsed previews.
function plainTextOf(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Cut `text` to `maxChars` on a word boundary (append '…'). `maxChars` of 0
// or less yields null (empty/absent content).
export function previewCut(
  text: string | null,
  maxChars: number,
): string | null {
  if (!text) return null;
  const oneLine = plainTextOf(text);
  if (oneLine.length === 0) return null;
  if (oneLine.length <= maxChars) return oneLine;
  const cut = oneLine.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  const end = lastSpace > maxChars * 0.6 ? lastSpace : maxChars;
  return `${cut.slice(0, end).replace(/[,\s]+$/, "")}…`;
}

// ---------------------------------------------------------------------------
// Record summaries
// ---------------------------------------------------------------------------

function formatDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100)) / 10}s`;
  return `${Math.round(ms / 1000)}s`;
}

// `+N −M` diffstat from a unified diff string (lines that begin with
// `+`/`-`, excluding the `+++`/`---` file headers).
function diffStat(diff: string): string | null {
  let added = 0;
  let removed = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  if (added === 0 && removed === 0) return null;
  return `${added > 0 ? `+${added}` : ""}${added > 0 && removed > 0 ? " " : ""}${
    removed > 0 ? `−${removed}` : ""
  }`;
}

function subagentMeta(tc: ToolCallRecord): Record<string, unknown> | undefined {
  const tool = tc.tool.toLowerCase();
  if (tool !== "task" && tool !== "proc") return undefined;
  const meta: Record<string, unknown> = {};
  if (tc.backgroundAgentId) meta.agentId = tc.backgroundAgentId;
  if (tc.backgroundAgentStatus)
    meta.backgroundAgentStatus = tc.backgroundAgentStatus;
  try {
    const args = tc.argsJson
      ? (JSON.parse(tc.argsJson) as Record<string, unknown>)
      : null;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      for (const key of [
        "agent_type",
        "model",
        "mode",
        "description",
        "name",
        "summary",
        "goal",
        "procedure",
      ] as const) {
        const v = args[key];
        if (typeof v === "string" && v.length > 0) meta[key] = v;
      }
    }
  } catch {
    /* non-JSON args: keep lifecycle-only meta */
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

// Collapsed-line summary for a tool call, preferring the shared tool-summary
// derivation and falling back to the subagent headline for `task` calls.
function toolSummary(tc: ToolCallRecord): string {
  const fromArgs = summarizeToolCall(tc.tool, tc.argsJson);
  if (fromArgs) return fromArgs;
  const meta = subagentMeta(tc);
  const headline =
    typeof meta?.description === "string" && meta.description.length > 0
      ? meta.description
      : typeof meta?.name === "string" && meta.name.length > 0
        ? meta.name
        : null;
  return headline ?? tc.tool;
}

function editSummary(e: FileEditRecord): string {
  const stat = e.diff ? diffStat(e.diff) : null;
  return stat ? `${e.path} (${stat})` : e.path;
}

function reasoningSummary(r: ReasoningBlockRecord): string {
  const preview = previewCut(r.text, 120);
  if (r.kind === "content") return preview ?? "(content)";
  const duration = formatDuration(r.durationMs);
  return (
    [duration ? `Thought for ${duration}` : null, preview]
      .filter(Boolean)
      .join(" · ") || "Thinking…"
  );
}

// ---------------------------------------------------------------------------
// Record shaping
// ---------------------------------------------------------------------------

// Trim one record's large field(s) per `rules` and attach the server-computed
// summary. Returns a fresh record (inputs are never mutated).
function projectTool(t: ToolCallRecord, rules: TrimRules): ToolCallRecord {
  const subagentArgs =
    t.tool.toLowerCase() === "task" || t.tool.toLowerCase() === "proc";
  const argsInline = rules.taskArgs === null && subagentArgs;
  const args = trimmed(t.argsJson, rules.args, argsInline);
  const result = trimmed(t.resultJson, rules.result, false);
  const meta = subagentMeta(t);
  return {
    ...t,
    argsJson: args.value,
    ...(args.truncated
      ? { argsTruncated: true as const, argsBytes: args.bytes }
      : {}),
    resultJson: result.value,
    ...(result.truncated
      ? { resultTruncated: true as const, resultBytes: result.bytes }
      : {}),
    summary: toolSummary(t),
    ...(meta ? { meta } : {}),
  };
}

function projectEdit(e: FileEditRecord, rules: TrimRules): FileEditRecord {
  const diff = trimmed(e.diff, rules.diff, false);
  return {
    ...e,
    diff: diff.value,
    ...(diff.truncated
      ? { diffTruncated: true as const, diffBytes: diff.bytes }
      : {}),
    summary: editSummary(e),
  };
}

function projectReasoning(
  r: ReasoningBlockRecord,
  rules: TrimRules,
): ReasoningBlockRecord {
  // `content` (a sub-agent's spoken answer) and still-open blocks render
  // unconditionally, so they never trim — mirroring the SQL carve-out.
  const alwaysInline = r.kind === "content" || r.durationMs == null;
  const text = trimmed(r.text, rules.reasoning, alwaysInline);
  return {
    ...r,
    text: text.value,
    ...(text.truncated
      ? { textTruncated: true as const, textBytes: text.bytes }
      : {}),
    summary: reasoningSummary(r),
  };
}

// Project a raw message (content + records) into a wire-ready hydrated body.
export function projectMessageBody(msg: Message, rules: TrimRules): Message {
  return {
    ...msg,
    toolCalls: (msg.toolCalls ?? []).map((t) => projectTool(t, rules)),
    fileEdits: (msg.fileEdits ?? []).map((e) => projectEdit(e, rules)),
    reasoningBlocks: (msg.reasoningBlocks ?? []).map((r) =>
      projectReasoning(r, rules),
    ),
  };
}

// ---------------------------------------------------------------------------
// Index entries
// ---------------------------------------------------------------------------

function toolDescriptor(t: ToolCallRecord): TranscriptRecordDescriptor {
  const meta = subagentMeta(t);
  return {
    kind: "tool",
    id: t.id,
    tool: t.tool,
    status: t.status,
    textOffset: t.textOffset,
    parentToolCallId: t.parentToolCallId,
    summary: toolSummary(t),
    ...(meta ? { meta } : {}),
  };
}

function editDescriptor(e: FileEditRecord): TranscriptRecordDescriptor {
  return {
    kind: "edit",
    id: e.id,
    path: e.path,
    textOffset: e.textOffset,
    parentToolCallId: e.parentToolCallId,
    summary: editSummary(e),
  };
}

function reasoningDescriptor(
  r: ReasoningBlockRecord,
): TranscriptRecordDescriptor {
  return {
    kind: "reasoning",
    id: r.id,
    reasoningKind: r.kind,
    textOffset: r.textOffset,
    durationMs: r.durationMs,
    parentToolCallId: r.parentToolCallId,
    summary: reasoningSummary(r),
  };
}

// Record descriptors in the same order the client interleaves parts after
// hydration: ascending `textOffset` (null offsets trail, in
// reasoning→tools→edits order), tie-broken by wall-clock timestamp.
function recordDescriptors(msg: Message): TranscriptRecordDescriptor[] {
  type Anchor = { offset: number; ts: number; d: TranscriptRecordDescriptor };
  const anchors: Anchor[] = [];
  const trailing: TranscriptRecordDescriptor[] = [];
  for (const r of msg.reasoningBlocks ?? []) {
    const d = reasoningDescriptor(r);
    if (r.textOffset == null) trailing.push(d);
    else
      anchors.push({
        offset: Math.min(r.textOffset, msg.content.length),
        ts: r.startedAt,
        d,
      });
  }
  for (const t of msg.toolCalls ?? []) {
    const d = toolDescriptor(t);
    if (t.textOffset == null) trailing.push(d);
    else
      anchors.push({
        offset: Math.min(t.textOffset, msg.content.length),
        ts: t.startedAt,
        d,
      });
  }
  for (const e of msg.fileEdits ?? []) {
    const d = editDescriptor(e);
    if (e.textOffset == null) trailing.push(d);
    else
      anchors.push({
        offset: Math.min(e.textOffset, msg.content.length),
        ts: e.createdAt,
        d,
      });
  }
  anchors.sort((a, b) => a.offset - b.offset || a.ts - b.ts);
  return [...anchors.map((a) => a.d), ...trailing];
}

function indexEntryOf(msg: Message): TranscriptIndexEntry {
  return {
    id: msg.id,
    role: msg.role,
    status: msg.status,
    errorCode: msg.errorCode,
    createdAt: msg.createdAt,
    preview: previewCut(msg.content, TRANSCRIPT_INDEX_PREVIEW_MAX_CHARS),
    records: recordDescriptors(msg),
  };
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * The conversation-open projection: `tail` = newest TRANSCRIPT_HYDRATED_TAIL
 * messages (full bodies, trimmed to the tight INITIAL_* limits) and `index` =
 * the next TRANSCRIPT_INDEX_COUNT older messages as index entries, with
 * `hasMoreOlder` telling the client whether a paging endpoint has more.
 * Bounded regardless of conversation length.
 */
export function projectTranscript(
  conversationId: string | number,
): TranscriptProjection {
  const intConv =
    typeof conversationId === "number"
      ? conversationId
      : convCodec.parse(conversationId);
  const tail = messagesRepo.listRecent(intConv, TRANSCRIPT_HYDRATED_TAIL);
  if (tail.length === 0) return { tail: [], index: [], hasMoreOlder: false };
  const tailOldestId = msgCodec.parse(tail[0].id);
  const page = messagesRepo.listIndexPage(
    intConv,
    tailOldestId,
    TRANSCRIPT_INDEX_COUNT,
  );
  return {
    tail: tail.map((m) => projectMessageBody(m, INITIAL_RULES)),
    index: page.messages.map(indexEntryOf),
    hasMoreOlder: page.hasMore,
  };
}

/** Index-only page of messages older than `beforeId` (the load-older path). */
export function projectIndexPage(
  conversationId: string | number,
  beforeId: number,
  limit: number,
): { entries: TranscriptIndexEntry[]; hasMore: boolean } {
  const page = messagesRepo.listIndexPage(
    typeof conversationId === "number"
      ? conversationId
      : convCodec.parse(conversationId),
    beforeId,
    limit,
  );
  return { entries: page.messages.map(indexEntryOf), hasMore: page.hasMore };
}

/**
 * Full body of one message (content + records trimmed to the generous
 * INLINE_* limits) for on-demand hydration. `null` when the message doesn't
 * exist in this conversation — the route turns that into a 404 without
 * leaking existence.
 */
export function projectMessageForOwner(
  conversationId: string | number,
  messageId: number,
): Message | null {
  const msg = messagesRepo.getMessage(
    typeof conversationId === "number"
      ? conversationId
      : convCodec.parse(conversationId),
    messageId,
  );
  if (!msg) return null;
  return projectMessageBody(msg, HYDRATION_RULES);
}
