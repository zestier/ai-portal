// Maps pi `AgentSessionEvent`s to portal `PortalEvent`s so the pi session can
// reuse the turn-runner's existing dispatch / persistence / SSE pipeline
// unchanged (see runtime/turn-runner.ts).
//
// The mapper carries the per-turn reasoning-segment state: pi streams thinking
// as one block per content index, and we keep each burst a single segment
// closed at `thinking_end` / `message_end`, mirroring the pi provider's
// burst-close semantics so think/text interleaving survives.

import { ulid } from "ulid";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PortalEvent } from "$lib/types";
import { toolCallId } from "$lib/ids";
import { serializeEnvelope, type ToolResult } from "../tools/types";
import { mintToolCallId } from "../db/repos/messages";

const TOOL_SUMMARY_MAX = 200;

export class PiEventMapper {
  readonly messageId: string;
  // Open reasoning bursts keyed by pi's content index (one per thinking block).
  private reasoningSegments = new Map<
    number,
    { segmentId: string; startedAt: number }
  >();
  // pi tool calls carry SDK-string ids; the portal persists numeric tool_calls
  // ids. Map each SDK id to a minted numeric id (stable across the call's
  // start/update/end events so the client and DB correlate them as one call),
  // exposed to the turn stream as its opaque X-handle.
  private toolCallIds = new Map<string, number>();
  private messageEnded = false;
  private emittedError = false;

  constructor(messageId: string) {
    this.messageId = messageId;
  }

  /** True once a stream-level error event has been emitted (abort or failure). */
  get hasError(): boolean {
    return this.emittedError;
  }

  /** True once pi's `message_end` for this turn has been seen. */
  get ended(): boolean {
    return this.messageEnded;
  }

  /** Mint-or-lookup the numeric portal tool-call id for an SDK tool call id. */
  private toolCallIdFor(sdkId: string): string {
    const existing = this.toolCallIds.get(sdkId);
    if (existing !== undefined) return toolCallId.encode(existing);
    const minted = mintToolCallId();
    this.toolCallIds.set(sdkId, minted);
    return toolCallId.encode(minted);
  }

  map(event: AgentSessionEvent): PortalEvent[] {
    switch (event.type) {
      case "message_start":
        // pi echoes the prompt as a `role: 'user'` message_start/message_end
        // pair before the assistant reply; the portal already persists the
        // user message, so only assistant messages map to the turn stream.
        if (event.message.role !== "assistant") return [];
        return [
          {
            type: "message.start",
            messageId: this.messageId,
            role: "assistant",
          },
        ];
      case "message_update":
        return this.mapMessageUpdate(event.assistantMessageEvent);
      case "message_end":
        if (event.message.role !== "assistant") return [];
        this.messageEnded = true;
        return [{ type: "message.end", messageId: this.messageId }];
      case "tool_execution_start":
        return [
          {
            type: "tool.call",
            toolCallId: this.toolCallIdFor(event.toolCallId),
            tool: event.toolName,
            args: event.args,
            messageId: this.messageId,
          },
        ];
      case "tool_execution_update":
        // Live partial output from the portal tool's stream (see tools.ts):
        // `partial()` → tool.partial_output, `progress()` → tool.progress.
        return mapToolUpdate(event, this.toolCallIdFor(event.toolCallId));
      case "tool_execution_end":
        return mapToolResult(event, this.toolCallIdFor(event.toolCallId));
      default:
        // agent_start / agent_end / turn_start / turn_end / queue_update
        // etc. carry nothing the portal renders; agent_end terminates the
        // send() stream (handled in session.ts), the rest is noise.
        return [];
    }
  }

  // Close any reasoning bursts left open when the run ends (abort, stream
  // error) so the persisted assistant message has no dangling segments.
  closeReasoning(): PortalEvent[] {
    const out: PortalEvent[] = [];
    for (const [contentIndex, seg] of this.reasoningSegments) {
      out.push({
        type: "message.reasoning.end",
        messageId: this.messageId,
        segmentId: seg.segmentId,
        durationMs: Date.now() - seg.startedAt,
      });
      this.reasoningSegments.delete(contentIndex);
    }
    return out;
  }

  private mapMessageUpdate(event: {
    type: string;
    contentIndex?: number;
    delta?: string;
    error?: { errorMessage?: string };
  }): PortalEvent[] {
    switch (event.type) {
      case "text_delta":
        return [
          {
            type: "message.delta",
            messageId: this.messageId,
            text: event.delta ?? "",
          },
        ];
      case "thinking_delta": {
        const contentIndex = event.contentIndex ?? 0;
        let seg = this.reasoningSegments.get(contentIndex);
        if (!seg) {
          seg = { segmentId: ulid(), startedAt: Date.now() };
          this.reasoningSegments.set(contentIndex, seg);
        }
        return [
          {
            type: "message.reasoning",
            messageId: this.messageId,
            segmentId: seg.segmentId,
            text: event.delta ?? "",
          },
        ];
      }
      case "thinking_end": {
        const contentIndex = event.contentIndex ?? 0;
        const seg = this.reasoningSegments.get(contentIndex);
        this.reasoningSegments.delete(contentIndex);
        if (!seg) return [];
        return [
          {
            type: "message.reasoning.end",
            messageId: this.messageId,
            segmentId: seg.segmentId,
            durationMs: Date.now() - seg.startedAt,
          },
        ];
      }
      case "error":
        this.emittedError = true;
        return [
          {
            type: "error",
            code: "pi_stream_error",
            message: event.error?.errorMessage ?? "pi stream error",
          },
        ];
      default:
        // text_start / text_end / thinking_start / toolcall_* carry no
        // renderable delta.
        return [];
    }
  }
}

// Partial/progress deltas: a portal tool streams via `onUpdate` with details
// `{ portalStream: 'progress' | 'partial' }` (see tools.ts); map by that.
function mapToolUpdate(
  event: { toolCallId: string; partialResult: unknown },
  toolCallId: string,
): PortalEvent[] {
  const { partialResult } = event;
  const details = isRecord(partialResult) ? partialResult.details : undefined;
  if (isRecord(details) && details.portalStream === "progress") {
    return [
      {
        type: "tool.progress",
        toolCallId,
        message: contentText(partialResult),
      },
    ];
  }
  return [
    {
      type: "tool.partial_output",
      toolCallId,
      output: contentText(partialResult),
    },
  ];
}

// Final result: when the tool returned a portal envelope (details.ok boolean),
// surface the serialized envelope as `output` for the client timeline and
// derive `ok` from it; otherwise fall back to pi's error flag (denied / non
// portal tools).
function mapToolResult(
  event: { toolCallId: string; result: unknown; isError: boolean },
  toolCallId: string,
): PortalEvent[] {
  const { result } = event;
  const details = isRecord(result) ? result.details : undefined;
  if (isRecord(details) && typeof details.ok === "boolean") {
    return [
      {
        type: "tool.result",
        toolCallId,
        ok: details.ok,
        summary: toolResultSummary(result),
        output: serializeEnvelope(details as unknown as ToolResult),
      },
    ];
  }
  return [
    {
      type: "tool.result",
      toolCallId,
      ok: !event.isError,
      summary: toolResultSummary(result),
    },
  ];
}

// Concatenated text of an AgentToolResult's content parts (the portal adapter
// always puts the streamed text first), for partial/progress events.
function contentText(result: unknown): string {
  const content = isRecord(result) ? result.content : undefined;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : "",
    )
    .join("")
    .trim();
}

function toolResultSummary(result: unknown): string {
  const content = isRecord(result) ? result.content : undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "string"
          ? part
          : isRecord(part) && typeof part.text === "string"
            ? part.text
            : "",
      )
      .join("\n")
      .replace(/\s+/g, " ")
      .trim();
    if (text)
      return text.length > TOOL_SUMMARY_MAX
        ? `${text.slice(0, TOOL_SUMMARY_MAX - 3)}...`
        : text;
  }
  return "(empty result)";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
