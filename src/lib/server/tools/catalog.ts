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

import type { PortalToolGroupId } from '$lib/tools/groups';
import { PORTAL_TOOL_GROUPS } from '$lib/tools/groups';
import type { PortalToolCatalogEntry } from '$lib/tools/catalog-types';
import type { PortalTool } from './types';
import { buildGitTools } from './git';
import { buildCreateDirectoryTools } from './create-directory';
import { buildMoveTools } from './move';
import { buildTrashTools } from './trash';
import { buildReadFileTools } from './read-file';
import { buildWorktreeTools } from './worktree';
import { buildTicketTools } from './tickets';
import { buildPermissionTools } from './permissions';
import { buildMemoryTools } from './memory';
import { buildPromptTemplateTools } from './prompt-templates';
import { buildShellTools } from './shell';
import { buildApplyPatchTools } from './apply-patch';
import { buildGrepTools } from './grep';

export type { PortalToolCatalogEntry };

const STUB = {
	userId: 'catalog',
	conversationId: 'catalog',
	workspaceKey: 'catalog',
	cwd: '/'
};

function groupedTools(): Record<PortalToolGroupId, PortalTool[]> {
	return {
		shell: buildShellTools(STUB.cwd),
		git: buildGitTools(STUB.cwd, { userId: STUB.userId, conversationId: STUB.conversationId }),
		filesystem: [
			...buildCreateDirectoryTools(STUB.cwd, {
				userId: STUB.userId,
				conversationId: STUB.conversationId
			}),
			...buildMoveTools(STUB.cwd, {
				userId: STUB.userId,
				conversationId: STUB.conversationId
			}),
			...buildTrashTools(STUB.cwd, {
				userId: STUB.userId,
				conversationId: STUB.conversationId
			}),
			...buildReadFileTools(STUB.cwd, {
				userId: STUB.userId,
				conversationId: STUB.conversationId
			}),
			...buildApplyPatchTools(STUB.cwd, {
				userId: STUB.userId,
				conversationId: STUB.conversationId
			}),
			...buildGrepTools(STUB.cwd, {
				userId: STUB.userId,
				conversationId: STUB.conversationId
			})
		],
		worktree: buildWorktreeTools({ userId: STUB.userId, conversationId: STUB.conversationId }),
		tickets: buildTicketTools({
			userId: STUB.userId,
			workspaceKey: STUB.workspaceKey,
			conversationId: STUB.conversationId
		}),
		permissions: buildPermissionTools({
			userId: STUB.userId,
			conversationId: STUB.conversationId,
			policy: 'prompt',
			getMode: () => 'interactive',
			getApprovalMode: () => 'ask',
			emit: () => {}
		}),
		// The widest memory configuration, so the catalog lists every memory tool
		// a conversation could expose rather than the subset this user enabled.
		memory: buildMemoryTools({
			userId: STUB.userId,
			conversationId: STUB.conversationId,
			mode: 'strict',
			globalMemoryEnabled: true
		}),
		'prompt-templates': buildPromptTemplateTools({ userId: STUB.userId })
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
				permissionBehavior: tool.permissionBehavior ?? 'normal',
				filesystemDerived: typeof tool.derivePermissionRequest === 'function'
			});
		}
	}
	return entries;
}
