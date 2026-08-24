// Assembles the portal tool set for a pi session, mirroring catalog.ts's
// grouped builder invocation (the two must not drift: any builder or opts a
// new tool needs is declared here exactly as the catalog declares it).
//
// Returns the pi `customTools` (every portal tool adapted through
// `portalToolToPiTool`, filtered to the enabled groups) plus a name -> tool
// index the permission gate consults for `derivePermissionRequest` /
// `permissionBehavior` / unknown-tool lookups.

import type {
  ApprovalMode,
  MemoryMode,
  PermissionPolicy,
  PortalEvent,
  SessionMode,
} from "$lib/types";
import { sanitizeDisabledToolGroups } from "$lib/tools/groups";
import { PORTAL_TOOL_GROUPS, type PortalToolGroupId } from "$lib/tools/groups";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { portalToolToPiTool } from "../pi/tools";
import {
  buildCreateDirectoryTools,
  buildMoveTools,
  buildTrashTools,
} from "./filesystem";
import { buildEditFileTools } from "./edit-file";
import { buildMultiEditTools } from "./multi-edit";
import { buildGitTools } from "./git";
import { buildGrepTools } from "./grep";
import { buildFindTools } from "./find";
import { buildLsTools } from "./ls";
import { buildMemoryTools } from "./memory";
import { buildPermissionTools } from "./permissions";
import { buildPromptTemplateTools } from "./prompt-templates";
import { buildReadTools } from "./read";
import { buildShellTools } from "./shell";
import { buildTicketTools } from "./tickets";
import { buildWorktreeTools } from "./worktree";
import { buildAskUserTool } from "./ask-user";
import type { PortalTool } from "./types";

export interface AssemblePiToolsOptions {
  cwd: string;
  userId: number;
  conversationId: number;
  workspaceKey?: string;
  policy: PermissionPolicy;
  /** Live session mode; the permission tools surface it in `permission_capabilities`. */
  getMode: () => SessionMode;
  /** Live approval mode; read per call so a mid-turn PATCH takes effect. */
  getApprovalMode: () => ApprovalMode;
  /** Pushes an event into the active turn's stream (interactive prompts). */
  emit: (ev: PortalEvent) => void;
  /** Portal tool groups disabled for this conversation. */
  disabledToolGroups?: string[];
  memoryMode?: MemoryMode;
  globalMemoryEnabled?: boolean;
  /** Maps an SDK tool id to the portal id used by persisted events. */
  resolveToolCallId?: (sdkId: string) => string;
}

export interface AssembledPiTools {
  customTools: ToolDefinition[];
  portalToolsByName: Map<string, PortalTool>;
}

export interface AssembledPortalTools {
  tools: PortalTool[];
  byName: Map<string, PortalTool>;
}

export function assemblePortalTools(
  opts: AssemblePiToolsOptions,
): AssembledPortalTools {
  const disabled = new Set(sanitizeDisabledToolGroups(opts.disabledToolGroups));
  const { userId, conversationId } = opts;
  const toolCtx: {
    userId: number;
    conversationId: number;
    workspaceKey?: string;
  } = {
    userId,
    conversationId,
  };
  if (opts.workspaceKey !== undefined) toolCtx.workspaceKey = opts.workspaceKey;
  const byName = new Map<string, PortalTool>();

  // Build every group eagerly (builders only close over context — no IO until
  // a handler runs), then filter by the enabled groups.
  const grouped: Record<PortalToolGroupId, PortalTool[]> = {
    shell: buildShellTools(opts.cwd),
    git: buildGitTools(opts.cwd, toolCtx),
    filesystem: [
      ...buildCreateDirectoryTools(opts.cwd, toolCtx),
      ...buildMoveTools(opts.cwd, toolCtx),
      ...buildTrashTools(opts.cwd, toolCtx),
      ...buildReadTools(opts.cwd, toolCtx),
      ...buildMultiEditTools(opts.cwd, toolCtx),
      ...buildEditFileTools(opts.cwd, toolCtx),
      ...buildGrepTools(opts.cwd, toolCtx),
      ...buildLsTools(opts.cwd, toolCtx),
      ...buildFindTools(opts.cwd, toolCtx),
    ],
    worktree: buildWorktreeTools({ userId, conversationId }),
    tickets: buildTicketTools({
      userId,
      workspaceKey: opts.workspaceKey ?? "",
      conversationId,
    }),
    permissions: buildPermissionTools({
      userId,
      conversationId,
      policy: opts.policy,
      getMode: opts.getMode,
      getApprovalMode: opts.getApprovalMode,
      emit: opts.emit,
      resolvePortalTool: (name) => byName.get(name) ?? null,
    }),
    // buildMemoryTools returns [] when mode is 'off' (the default), so
    // omitting memoryMode keeps the group empty unless a mode was requested.
    memory: buildMemoryTools({
      userId,
      conversationId,
      mode: opts.memoryMode ?? "off",
      ...(opts.globalMemoryEnabled !== undefined
        ? { globalMemoryEnabled: opts.globalMemoryEnabled }
        : {}),
    }),
    "prompt-templates": buildPromptTemplateTools({ userId }),
    interaction: [
      buildAskUserTool({ userId, conversationId, emit: opts.emit }),
    ],
  };

  const tools: PortalTool[] = [];
  for (const group of PORTAL_TOOL_GROUPS) {
    if (disabled.has(group.id)) continue;
    for (const tool of grouped[group.id]) {
      byName.set(tool.name, tool);
      tools.push(tool);
    }
  }
  return { tools, byName };
}

export function assemblePiTools(
  opts: AssemblePiToolsOptions,
): AssembledPiTools {
  const { tools, byName } = assemblePortalTools(opts);
  return {
    customTools: tools.map((tool) =>
      portalToolToPiTool(tool, opts.resolveToolCallId),
    ),
    portalToolsByName: byName,
  };
}
