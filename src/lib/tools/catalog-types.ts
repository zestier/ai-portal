// Client-safe shape of the portal tool catalog. The catalog itself is built
// server-side (`$lib/server/tools/catalog.ts`) by instantiating the tool
// builders; only this type crosses into the browser bundle, so the settings
// grant form can render tool names without importing server modules.

import type { PortalToolGroupId } from './groups';

export interface PortalToolCatalogEntry {
	name: string;
	group: PortalToolGroupId;
	permissionBehavior: 'normal' | 'always-prompt' | 'never-prompt';
	/**
	 * True when the tool re-declares its permission as a filesystem request
	 * (`derivePermissionRequest`). Such a call is matched by the fs grants, so a
	 * custom-tool grant on its name never fires.
	 */
	filesystemDerived: boolean;
}

/**
 * Why a `custom-tool` grant on this tool could never take effect, or `null`
 * when a grant would work normally. Shared by the settings form so the UI can
 * warn instead of silently saving a row that never matches.
 */
export function customToolGrantCaveat(entry: PortalToolCatalogEntry): string | null {
	if (entry.permissionBehavior === 'always-prompt') {
		return 'This tool always prompts: it asks for human approval before grants are consulted, so a grant here cannot auto-approve (or auto-deny) it.';
	}
	if (entry.permissionBehavior === 'never-prompt') {
		return 'This tool never prompts — it is already auto-approved, so a grant here changes nothing.';
	}
	if (entry.filesystemDerived) {
		return 'This tool is permission-checked as a filesystem write on the path it touches, so it is governed by read/write/edit grants rather than a custom-tool grant on its name.';
	}
	return null;
}
