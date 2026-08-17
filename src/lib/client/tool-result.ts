// Decodes the `resultJson` field on a ToolCallRecord into a normalized
// list of typed blocks the UI can render. Two families of shapes occur:
//
//   - Portal tools: the serialized `{ ok, summary?, result? | error }`
//     envelope (persisted as the boundary's `fullContent`). `decodeEnvelope`
//     unwraps it and surfaces the inner payload as raw text/JSON.
//   - Native SDK tools: the pi runtime's `tool.execution_complete`
//     `result` object, shape `{ content, detailedContent?, contents?:
//     ContentBlock[] }`, where ContentBlock is a typed union (text / terminal
//     / image / audio / resource_link / resource).
//
// Older shapes (plain string, raw error object) also occur — we normalize them
// all into a Block[].

import {
  parseEnvelopeJson,
  deriveToolResultViews,
} from "$lib/tool-result-views";

export type ResultBlock =
  | { kind: "text"; text: string }
  | {
      kind: "terminal";
      text: string;
      exitCode?: number | undefined;
      cwd?: string | undefined;
    }
  | { kind: "image"; data?: string; mimeType: string; src?: string }
  | { kind: "audio"; data: string; mimeType: string }
  | {
      kind: "resource_link";
      name: string;
      uri: string;
      description?: string | undefined;
    }
  | {
      kind: "resource";
      uri: string;
      mimeType?: string | undefined;
      text?: string | undefined;
    };

export interface DecodedResult {
  blocks: ResultBlock[];
  // Best-effort plain text fallback (used as the body of a Raw
  // disclosure, or when nothing structured is available).
  fallbackText: string | null;
  // Reserved framework next-step nudge carried on a successful envelope.
  // Rendered as a muted note by the generic tool-result path in
  // ToolCall.svelte. (Git cards read the hint off the envelope themselves via
  // parseGitToolResult, so they don't go through this field.)
  followUpHint?: string | undefined;
  // Best-effort exact text that was fed back to the model on the next turn,
  // recomputed from the persisted envelope with the same pure projection the
  // server uses — present for portal envelopes and plain strings, undefined
  // for other shapes (native SDK `{content, …}` records, invalid JSON, null).
  modelText?: string | undefined;
}

const markdownResultTools = new Set([
  "ask_user",
  "read_agent",
  "report_intent",
  "task_complete",
]);

export function shouldRenderToolResultAsMarkdown(tool: string): boolean {
  return markdownResultTools.has(tool.toLowerCase());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function decodeContents(arr: unknown[]): ResultBlock[] {
  const out: ResultBlock[] = [];
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const t = item.type;
    if (t === "text" && typeof item.text === "string") {
      out.push({ kind: "text", text: item.text });
    } else if (t === "terminal" && typeof item.text === "string") {
      out.push({
        kind: "terminal",
        text: item.text,
        exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
        cwd: typeof item.cwd === "string" ? item.cwd : undefined,
      });
    } else if (
      t === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      out.push({ kind: "image", data: item.data, mimeType: item.mimeType });
    } else if (
      t === "audio" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      out.push({ kind: "audio", data: item.data, mimeType: item.mimeType });
    } else if (
      t === "resource_link" &&
      typeof item.name === "string" &&
      typeof item.uri === "string"
    ) {
      out.push({
        kind: "resource_link",
        name: item.name,
        uri: item.uri,
        description:
          typeof item.description === "string" ? item.description : undefined,
      });
    } else if (t === "resource" && isRecord(item.resource)) {
      const r = item.resource;
      if (typeof r.uri === "string") {
        out.push({
          kind: "resource",
          uri: r.uri,
          mimeType: typeof r.mimeType === "string" ? r.mimeType : undefined,
          text: typeof r.text === "string" ? r.text : undefined,
        });
      }
    }
  }
  return out;
}

// Map a tool's own rendered views (text/image content blocks) to ResultBlocks.
// Persisted data is untrusted: unknown/malformed entries are skipped. Text views
// render as `<pre><code>`, image views render zoomable.
function viewBlocks(views: unknown[]): ResultBlock[] {
  const out: ResultBlock[] = [];
  for (const item of views) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      out.push({ kind: "text", text: item.text });
    } else if (
      item.type === "image" &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    ) {
      out.push({ kind: "image", data: item.data, mimeType: item.mimeType });
    }
  }
  return out;
}

export function decodeToolResult(resultJson: string | null): DecodedResult {
  if (!resultJson) return { blocks: [], fallbackText: null };
  let v: unknown;
  try {
    v = JSON.parse(resultJson);
  } catch {
    return {
      blocks: [{ kind: "text", text: resultJson }],
      fallbackText: resultJson,
    };
  }
  if (typeof v === "string") {
    return {
      blocks: [{ kind: "text", text: v }],
      fallbackText: v,
      modelText: v,
    };
  }
  if (!isRecord(v)) {
    const txt = JSON.stringify(v, null, 2);
    return { blocks: [{ kind: "text", text: txt }], fallbackText: txt };
  }
  const envelope = decodeEnvelope(v);
  if (envelope) {
    const parsed = parseEnvelopeJson(resultJson);
    if (parsed) envelope.modelText = deriveToolResultViews(parsed).modelText;
    return envelope;
  }
  if (Array.isArray(v.contents) && v.contents.length > 0) {
    const blocks = decodeContents(v.contents);
    if (blocks.length > 0) {
      const fallback =
        (typeof v.detailedContent === "string" && v.detailedContent) ||
        (typeof v.content === "string" && v.content) ||
        null;
      return { blocks, fallbackText: fallback };
    }
  }
  const text =
    (typeof v.detailedContent === "string" && v.detailedContent) ||
    (typeof v.content === "string" && v.content) ||
    null;
  if (text) return { blocks: [{ kind: "text", text }], fallbackText: text };
  const txt = JSON.stringify(v, null, 2);
  return { blocks: [{ kind: "text", text: txt }], fallbackText: txt };
}

// Decode the structured tool-result envelope (`{ ok, summary?, result? | error }`)
// emitted by portal tools. Returns null when the record isn't an envelope so
// SDK-native result shapes keep their existing handling. The `fallbackText`
// carries the inner payload (raw string or pretty JSON) so downstream parsers
// like `parseGitToolResult` can read a tool's domain data.
function decodeEnvelope(v: Record<string, unknown>): DecodedResult | null {
  if (typeof v.ok !== "boolean") return null;
  if (v.ok === false) {
    if (!isRecord(v.error)) return null;
    const message =
      typeof v.error.message === "string"
        ? v.error.message
        : typeof v.summary === "string"
          ? v.summary
          : JSON.stringify(v.error, null, 2);
    return { blocks: [{ kind: "text", text: message }], fallbackText: message };
  }
  const result = v.result;
  const followUpHint =
    typeof v.followUpHint === "string" ? v.followUpHint : undefined;
  const withHint = (decoded: DecodedResult): DecodedResult =>
    followUpHint === undefined ? decoded : { ...decoded, followUpHint };
  if (result === undefined) {
    const text =
      typeof v.summary === "string" && v.summary ? v.summary : "(ok)";
    return withHint({ blocks: [{ kind: "text", text }], fallbackText: text });
  }
  if (typeof result === "string") {
    return withHint({
      blocks: [{ kind: "text", text: result }],
      fallbackText: result,
    });
  }
  const txt = JSON.stringify(result, null, 2);
  // The tool's own rendered views (read text/images, grep, bash, …) win over
  // dumping the payload as JSON. `fallbackText` stays the JSON so the Raw
  // disclosure and downstream consumers are byte-identical.
  const blocks =
    Array.isArray(v.views) && v.views.length > 0 ? viewBlocks(v.views) : [];
  if (blocks.length > 0) return withHint({ blocks, fallbackText: txt });
  return withHint({ blocks: [{ kind: "text", text: txt }], fallbackText: txt });
}
