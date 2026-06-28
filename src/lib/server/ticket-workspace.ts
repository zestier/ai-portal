import { error } from '@sveltejs/kit';
import * as settings from '$lib/server/db/repos/settings';
import { conversationWorkspaceRoot, resolveWorkspaceRoot } from '$lib/server/files';
import { resolveAndValidate } from '$lib/server/workdir';

export function defaultTicketWorkspace(userId: string): string {
	const userSettings = settings.get(userId) ?? settings.defaults();
	// Route the stored per-user default through conversationWorkspaceRoot so a
	// stale/out-of-allowlist defaultWorkdir folds back to PROJECT_ROOT (same
	// containment guard the conversation file/git endpoints get).
	return conversationWorkspaceRoot(userSettings.defaultWorkdir ?? null);
}

export function ticketWorkspaceFromConversation(workdir: string): string {
	return conversationWorkspaceRoot(workdir);
}

export function ticketWorkspaceFromInput(input: string | undefined, userId: string): string {
	if (!input) return defaultTicketWorkspace(userId);
	const resolved = resolveAndValidate(input);
	if (!resolved.ok) throw error(400, resolved.reason);
	return resolveWorkspaceRoot(resolved.path);
}
