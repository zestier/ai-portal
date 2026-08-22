// Enumerates every portal-injected tool the providers can assemble, together
// with the facts that decide whether a `custom-tool` permission grant can ever
// apply to it. The settings grant form uses this to offer real tool names and
// to warn about names where a grant would silently never fire.
//
// The catalog is DERIVED, not hand-maintained: each builder is invoked with
// inert stub context so a new tool (or a changed `permissionBehavior`) shows up
// here without anyone remembering to update a list. Builders only close over
// their context — no IO happens until a tool's handler runs — so constructing
// them off a real session is safe.

import type { PortalToolGroupId } from "$lib/tools/groups";
import { PORTAL_TOOL_GROUPS } from "$lib/tools/groups";
import type { PortalToolCatalogEntry } from "$lib/tools/catalog-types";
import type { PortalTool } from "./types";
import { buildGitTools } from "./git";
import {
  buildCreateDirectoryTools,
  buildMoveTools,
  buildTrashTools,
} from "./filesystem";
import { buildReadTools } from "./read";
import { buildWorktreeTools } from "./worktree";
import { buildTicketTools } from "./tickets";
import { buildPermissionTools } from "./permissions";
import { buildMemoryTools } from "./memory";
import { buildPromptTemplateTools } from "./prompt-templates";
import { buildShellTools } from "./shell";
import { buildMultiEditTools } from "./multi-edit";
import { buildGrepTools } from "./grep";
import { buildEditFileTools } from "./edit-file";
import { buildLsTools } from "./ls";
import { buildFindTools } from "./find";
import { buildAskUserTool } from "./ask-user";

export type { PortalToolCatalogEntry };

const STUB = {
  userId: 1,
  conversationId: 1,
  cwd: "/",
};
const STUB_CTX = {
  userId: STUB.userId,
  conversationId: STUB.conversationId,
  workspaceKey: "catalog",
};

function groupedTools(): Record<PortalToolGroupId, PortalTool[]> {
  return {
    shell: buildShellTools(STUB.cwd),
    git: buildGitTools(STUB.cwd, STUB_CTX),
    filesystem: [
      ...buildCreateDirectoryTools(STUB.cwd, STUB_CTX),
      ...buildMoveTools(STUB.cwd, STUB_CTX),
      ...buildTrashTools(STUB.cwd, STUB_CTX),
      ...buildReadTools(STUB.cwd, STUB_CTX),
      ...buildMultiEditTools(STUB.cwd, STUB_CTX),
      ...buildEditFileTools(STUB.cwd, STUB_CTX),
      ...buildGrepTools(STUB.cwd, STUB_CTX),
      ...buildLsTools(STUB.cwd, STUB_CTX),
      ...buildFindTools(STUB.cwd, STUB_CTX),
    ],
    worktree: buildWorktreeTools({
      userId: STUB.userId,
      conversationId: STUB.conversationId,
    }),
    tickets: buildTicketTools({
      userId: STUB.userId,
      workspaceKey: "catalog",
      conversationId: STUB.conversationId,
    }),
    permissions: buildPermissionTools({
      userId: STUB.userId,
      conversationId: STUB.conversationId,
      policy: "prompt",
      getMode: () => "interactive",
      getApprovalMode: () => "ask",
      emit: () => {},
    }),
    // The widest memory configuration, so the catalog lists every memory tool
    // a conversation could expose rather than the subset this user enabled.
    memory: buildMemoryTools({
      userId: STUB.userId,
      conversationId: STUB.conversationId,
      mode: "strict",
      globalMemoryEnabled: true,
    }),
    "prompt-templates": buildPromptTemplateTools({ userId: STUB.userId }),
    interaction: [
      buildAskUserTool({
        userId: STUB.userId,
        conversationId: STUB.conversationId,
        emit: () => {},
      }),
    ],
  };
}

/** Every portal tool name, in tool-group order then declaration order. */
export function portalToolCatalog(): PortalToolCatalogEntry[] {
  const grouped = groupedTools();
  const entries: PortalToolCatalogEntry[] = [];
  for (const group of PORTAL_TOOL_GROUPS) {
    for (const tool of grouped[group.id]) {
      entries.push({
        name: tool.name,
        group: group.id,
        permissionBehavior: tool.permissionBehavior ?? "normal",
        filesystemDerived: typeof tool.derivePermissionRequest === "function",
      });
    }
  }
  return entries;
}
