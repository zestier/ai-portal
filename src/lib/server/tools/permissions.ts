import type {
  ApprovalMode,
  PermissionPolicy,
  PortalEvent,
  SessionMode,
} from "$lib/types";
import type { PortalTool } from "./types";
import { buildCapabilitiesTool } from "./permissions/capabilities";
import { buildForceRetryTool } from "./permissions/force-retry";
import { buildGrantRequestTool } from "./permissions/grant-request";

export * from "./permissions/capabilities";
export * from "./permissions/grant-request";
export * from "./permissions/force-retry";

export interface BuildPermissionToolsOpts {
  userId: number;
  conversationId: number;
  policy: PermissionPolicy;
  getMode: () => SessionMode;
  getApprovalMode: () => ApprovalMode;
  /** Pushes an event into the active turn's stream. Required so the
   * grant-request tool can raise a human permission dialog. */
  emit: (ev: PortalEvent) => void;
  /**
   * Resolves a denied tool name (a portal tool name as the PreToolUse hook
   * reports it — `bash`, `read`, `git_status`, …) to the portal tool
   * whose handler owns the call. When it resolves, a `force_retry_tool`
   * approval executes the originally captured tool + args directly and
   * returns the underlying `ToolResult`, instead of marking the token
   * approved for a re-issued call. Null for unresolvable tools keeps the
   * approve-then-retry flow. Providers build it from their portal tool set;
   * the catalog stub omits it (direct execution is a runtime concern).
   */
  resolvePortalTool?: (name: string) => PortalTool | null;
}

export function buildPermissionTools(
  opts: BuildPermissionToolsOpts,
): PortalTool[] {
  return [
    buildCapabilitiesTool(opts),
    buildGrantRequestTool(opts),
    buildForceRetryTool(opts),
  ];
}
