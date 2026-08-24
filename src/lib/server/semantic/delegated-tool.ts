import { toolCallId as toolCodec } from "$lib/ids";
import type { PortalEvent } from "$lib/types";
import { mintToolCallId } from "$lib/server/db/repos/messages";
import type { PiPermissionResolver } from "$lib/server/pi/session";
import {
  deriveToolResultViews,
  serializeEnvelope,
  type PortalTool,
  type ToolResult,
} from "$lib/server/tools/types";
import { validatePortalToolArgs } from "$lib/server/tools/schema-error";

export interface DelegatedToolOptions {
  parentToolCallId: number;
  capabilities: ReadonlyMap<string, PortalTool>;
  permissionResolver: PiPermissionResolver;
  emit: (event: PortalEvent) => void;
  signal: AbortSignal;
}

export async function executeDelegatedTool(
  opts: DelegatedToolOptions,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const tool = opts.capabilities.get(name);
  const childId = toolCodec.encode(mintToolCallId());
  const parentId = toolCodec.encode(opts.parentToolCallId);
  opts.emit({
    type: "tool.call",
    toolCallId: childId,
    tool: name,
    args,
    parentToolCallId: parentId,
  });
  if (!tool) {
    return finish(opts.emit, childId, parentId, {
      ok: false,
      error: { message: `Unknown delegated tool: ${name}` },
    });
  }
  const validation = validatePortalToolArgs(tool, args);
  if (!validation.ok) {
    return finish(opts.emit, childId, parentId, {
      ok: false,
      error: { message: validation.feedback },
    });
  }
  const permission = await opts.permissionResolver(
    name,
    asRecord(args),
    childId,
  );
  if (!permission.allow) {
    return finish(opts.emit, childId, parentId, {
      ok: false,
      error: { message: permission.reason ?? "Permission denied." },
    });
  }
  let result: ToolResult;
  try {
    result = await tool.handler(args, {
      signal: opts.signal,
      toolCallId: childId,
      partial: (output) =>
        opts.emit({
          type: "tool.partial_output",
          toolCallId: childId,
          output,
          parentToolCallId: parentId,
        }),
      progress: (message) =>
        opts.emit({
          type: "tool.progress",
          toolCallId: childId,
          message,
          parentToolCallId: parentId,
        }),
    });
  } catch (error) {
    result = {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  return finish(opts.emit, childId, parentId, result);
}

function finish(
  emit: (event: PortalEvent) => void,
  childId: string,
  parentId: string,
  result: ToolResult,
): ToolResult {
  emit({
    type: "tool.result",
    toolCallId: childId,
    ok: result.ok,
    summary: result.ok
      ? deriveToolResultViews(result).summary
      : result.error.message,
    output: serializeEnvelope(result),
    parentToolCallId: parentId,
  });
  if (result.ok && isRecord(result.result)) {
    const path = result.result.filePath;
    const gitDiff = result.result.gitDiff;
    if (
      typeof path === "string" &&
      isRecord(gitDiff) &&
      typeof gitDiff.diff === "string"
    ) {
      emit({
        type: "file.edit",
        path,
        diff: gitDiff.diff,
        parentToolCallId: parentId,
      });
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
