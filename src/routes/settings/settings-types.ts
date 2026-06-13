export { describeGrantScope } from '$lib/permissions/scope-summary';
import type { PageData } from './$types';

export type FormResult = {
	ok?: boolean;
	error?: string;
	formId?: string;
	duplicate?: boolean;
};

export type SettingsTab = 'general' | 'prompts' | 'memory' | 'permissions' | 'activity' | 'update';

export type SettingsData = PageData['settings'];
export type ProviderStatus = PageData['providers'][number];
export type PermissionGrant = PageData['grants'][number];
export type PermissionDecision = PageData['recentDecisions'][number];
export type PromptTemplate = PageData['promptTemplates'][number];
export type CustomMemoryProfile = PageData['customMemoryProfiles'][number];

export function formatContextWindow(tokens: number | undefined): string {
	if (!tokens || !Number.isFinite(tokens)) return 'context size unknown';
	if (tokens >= 1_000_000) {
		const m = tokens / 1_000_000;
		const str = m >= 10 ? m.toFixed(0) : m.toFixed(1).replace(/\.0$/, '');
		return `${str}M ctx`;
	}
	if (tokens >= 1_000) {
		return `${Math.round(tokens / 1_000)}K ctx`;
	}
	return `${tokens} ctx`;
}

export function authLabel(a: ProviderStatus['auth']): string {
	if (!a.isAuthenticated) return 'Not signed in';
	const who = a.login ? `@${a.login}` : 'signed in';
	const via = a.authType ? ` via ${a.authType}` : '';
	return `${who}${via}`;
}

export function formatTime(ms: number): string {
	try {
		return new Date(ms).toLocaleString();
	} catch {
		return String(ms);
	}
}

export function decisionLabel(d: PermissionDecision['decision']): string {
	switch (d) {
		case 'allow-once':
			return 'Allow once';
		case 'allow-always':
			return 'Allow always';
		case 'deny':
			return 'Deny';
		case 'deny-always':
			return 'Deny always';
		case 'auto-allow':
			return 'Auto-allow';
		case 'auto-deny':
			return 'Auto-deny';
		case 'auto-prompt-required':
			return 'Auto prompt-required';
		case 'auto-cancelled':
			return 'Auto-cancelled';
		case 'auto-expired':
			return 'Auto-expired';
	}
}

export function grantScopeLabel(g: {
	conversationId: string | null;
	conversationTitle: string | null;
}) {
	if (!g.conversationId) return 'Global';
	return g.conversationTitle ?? g.conversationId;
}

export function formatExpiry(ms: number | null): string {
	if (ms == null) return 'Never';
	const delta = ms - Date.now();
	if (delta <= 0) return 'expired';
	const mins = Math.round(delta / 60_000);
	if (mins < 60) return `in ${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `in ${hours}h`;
	return `in ${Math.round(hours / 24)}d`;
}
