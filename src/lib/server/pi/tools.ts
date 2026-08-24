// Adapts a portal `PortalTool` into a pi `ToolDefinition` custom tool, so a pi
// agent session can call the full existing portal toolset (D1: override — the
// portal tools are registered in pi's `customTools` slot, the built-in
// read/bash/edit/write are turned off via `noTools: 'builtin'`).
//
// The boundary is deliberately thin: the portal tool name, description and
// handler run verbatim; only the result envelope is projected onto pi's
// `AgentToolResult` content + details channel.
//
//   content  — text comes from `deriveToolResultViews().modelText` (a tool's own
//              rendered text views win; otherwise the payload projection);
//              image views become pi image content blocks so the model sees them.
//   details  — the portal `ToolResult` envelope, verbatim. pi's mapper reads it
//              back (`details.ok`) so `ok:false` envelopes surface as failed
//              tool results — `AgentToolResult` has no error flag of its own,
//              and throwing would discard the envelope. The envelope also
//              survives end-to-end: the mapper serializes it into the portal
//              `tool.result.output`, so the client's `decodeToolResult` renders
//              the same structured card a non-pi turn would.
//
// Streaming (`partial`/`progress`) maps to pi's `onUpdate` callback with a
// details tag the mapper uses to distinguish `tool.partial_output` from
// `tool.progress`.

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  deriveToolResultViews,
  err,
  type PortalTool,
  type ToolResult,
  type ToolStreamContext,
} from "../tools/types";

// The details channel carries either a stream tag (from `onUpdate`) or the
// final portal envelope.
type PiToolDetails =
  ToolResult | { portalStream: "partial" } | { portalStream: "progress" };

export function portalToolToPiTool(
  portalTool: PortalTool,
  resolveToolCallId?: (sdkId: string) => string,
): ToolDefinition {
  const tool = {
    name: portalTool.name,
    label: portalTool.name,
    description: portalTool.description,
    // Load-bearing in-context caveats that don't belong in the (token-heavy)
    // tool `description`; pi surfaces them in the system prompt instead.
    ...(portalTool.promptSnippet !== undefined
      ? { promptSnippet: portalTool.promptSnippet }
      : {}),
    ...(portalTool.promptGuidelines !== undefined &&
    portalTool.promptGuidelines.length > 0
      ? { promptGuidelines: portalTool.promptGuidelines }
      : {}),
    // Portal tools declare plain JSON schemas; pi's `parameters` slot is
    // typed `TSchema`, so cast through unknown. Runtime validation still runs:
    // pi's validateToolArguments coerces + checks plain JSON schemas.
    parameters:
      portalTool.parameters as unknown as ToolDefinition["parameters"],
    async execute(
      sdkToolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<PiToolDetails> | undefined,
    ): Promise<AgentToolResult<PiToolDetails>> {
      const stream: ToolStreamContext = {
        signal: signal ?? new AbortController().signal,
        ...(resolveToolCallId
          ? { toolCallId: resolveToolCallId(sdkToolCallId) }
          : {}),
        partial(output) {
          onUpdate?.({
            content: [{ type: "text", text: output }],
            details: { portalStream: "partial" },
          });
        },
        progress(message) {
          onUpdate?.({
            content: [{ type: "text", text: message }],
            details: { portalStream: "progress" },
          });
        },
      };
      const envelope = await runPortalTool(portalTool, params, stream);
      return envelopeToAgentToolResult(envelope);
    },
  };
  return tool as unknown as ToolDefinition;
}

async function runPortalTool(
  portalTool: PortalTool,
  params: unknown,
  stream: ToolStreamContext,
): Promise<ToolResult> {
  try {
    return await portalTool.handler(params, stream);
  } catch (e) {
    // Handlers are supposed to return `err(...)`, but a thrown exception is
    // normalized to the same envelope at the boundary so pi sees the same
    // shape either way.
    return err(e instanceof Error ? e.message : String(e));
  }
}

function envelopeToAgentToolResult(
  envelope: ToolResult,
): AgentToolResult<PiToolDetails> {
  const content: AgentToolResult<PiToolDetails>["content"] = [];
  // Image views become image content blocks (the model sees them). Text is
  // carried by the single modelText block below, which already prefers a
  // tool's rendered text views, so text views are not emitted separately.
  if (envelope.ok) {
    for (const view of envelope.views ?? []) {
      if (view.type === "image") {
        content.push({
          type: "image",
          data: view.data,
          mimeType: view.mimeType,
        });
      }
    }
  }
  content.push({
    type: "text",
    text: deriveToolResultViews(envelope).modelText,
  });
  return { content, details: envelope };
}
