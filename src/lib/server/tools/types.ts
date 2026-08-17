import type { z } from "zod";
import type { ToolResult } from "$lib/tool-result-views";

// The envelope → views projection (ToolResult, ok/err, deriveToolResultViews,
// serializeEnvelope, parseEnvelopeJson, …) lives in the shared, client-safe
// module `$lib/tool-result-views` and is re-exported here so every existing
// server caller and test is untouched. The client decoder imports that module
// directly, keeping the model text and UI payload derived from ONE source.
export {
  ok,
  err,
  envelopePayloadText,
  deriveEnvelopeSummary,
  parseEnvelopeJson,
  serializeEnvelope,
  deriveToolResultViews,
  type ToolError,
  type ToolBinaryResult,
  type ToolResultView,
  type ToolResult,
  type ToolResultViews,
} from "$lib/tool-result-views";

// Optional, opt-in streaming channel handed to a PortalTool handler so it can
// surface incremental feedback while it runs. Both methods reuse the existing
// ephemeral streaming events (`tool.partial_output` / `tool.progress`) and are
// no-ops once the turn is aborted. Handlers that don't need streaming simply
// ignore `ctx`.
export interface ToolStreamContext {
  // Cumulative stdout/stderr snapshot. The client REPLACES (not appends) on each
  // call, mirroring `tool.partial_output` semantics.
  partial(output: string): void;
  // Short human-readable status line.
  progress(message: string): void;
  // Mirrors the turn's abort signal.
  readonly signal: AbortSignal;
}

// A tool's declaration that its permission check should be evaluated as a
// filesystem request on a derived path instead of the default `custom-tool`
// request. The provider/permission layer substitutes `permissionKind` (e.g.
// `write`) and `path` so the request reuses the existing fs grants/seeds — an
// in-workspace `create_directory`, for instance, is covered by the standard
// session-workspace fs-write seed without needing a bespoke per-tool seed.
export interface ToolPermissionRequest {
  permissionKind: "read" | "write" | "edit";
  // The derived filesystem target. Read by the scope-key derivation exactly
  // as a native fs request's `path` would be, so prefer an absolute,
  // symlink-resolved path so the matcher and the dialog agree on the target.
  path: string;
  // Additional fs targets that must ALSO be permitted for the same
  // invocation. The gateway evaluates `path` and every `additionalPaths`
  // entry against the user's grants + policy and combines the per-target
  // outcomes MOST-RESTRICTIVELY: a deny on any target denies the request, and
  // an auto-allow requires every target to be permitted. Used by two-path
  // tools like `move`, which must satisfy write on both source and
  // destination. A request with additional paths is never persistable from
  // the prompt (one stored scope can't capture multiple targets).
  additionalPaths?: string[];
}

export interface PortalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // Optional system-prompt contributions (pi `ToolDefinition` carries both).
  // Load-bearing usage/security caveats that must stay in-context live here
  // instead of bloating `description` (T31): `promptSnippet` is a one-line
  // "Available tools" entry; `promptGuidelines` are short guideline bullets.
  promptSnippet?: string;
  promptGuidelines?: string[];
  argsSchema?: z.ZodTypeAny;
  permissionBehavior?: "normal" | "always-prompt" | "never-prompt";
  // Optional, pure (no IO) hook: when present and it returns a request, the
  // tool's permission is evaluated as that fs request rather than the default
  // `custom-tool` request. Returning null falls back to the custom-tool
  // request. It only inspects `args` to derive the target path.
  derivePermissionRequest?(args: unknown): ToolPermissionRequest | null;
  handler(args: unknown, ctx?: ToolStreamContext): Promise<ToolResult>;
}

// Build a resolver keyed by tool name that surfaces a tool's
// `derivePermissionRequest` hook to the shared permission gateway. Returns null
// for unknown tools or tools without the hook so the gateway proceeds with the
// default custom-tool request. Mirrors `buildToolArgsValidator`.
export function buildPermissionRequestResolver(
  tools: PortalTool[],
): (toolName: string, args: unknown) => ToolPermissionRequest | null {
  const byName = new Map<string, PortalTool>();
  for (const t of tools) byName.set(t.name, t);
  return (toolName, args) => {
    const tool = byName.get(toolName);
    if (!tool?.derivePermissionRequest) return null;
    return tool.derivePermissionRequest(args);
  };
}
