import type { SidebarTicket } from '$lib/types';

export const SIDEBAR_STORAGE_KEY = 'sidebarOpen';
export const SIDEBAR_DESKTOP_MIN_WIDTH = 769;
export const SIDEBAR_MOBILE_MAX_WIDTH = 768;

export interface SidebarEnv {
	getStored: () => string | null;
	isDesktop: () => boolean;
}

/**
 * Resolve the initial `sidebarOpen` value on page load.
 * Prefers a persisted user choice; otherwise defaults to open on desktop
 * and closed on mobile so the sidebar never overlays content on reload.
 */
export function resolveInitialSidebarOpen(env: SidebarEnv): boolean {
	const stored = env.getStored();
	if (stored === 'true') return true;
	if (stored === 'false') return false;
	return env.isDesktop();
}

/**
 * Order sidebar tickets ready-before-blocked within the already-fetched window.
 * A ticket is "blocked" when it has at least one open prerequisite
 * (`blockers.length > 0`). Ready tickets sort ahead of blocked ones; the
 * existing order (most-recently-updated first) is preserved within each group
 * via a stable partition. Does not pull in tickets outside the given list.
 */
export function orderSidebarTickets<T extends Pick<SidebarTicket, 'blockers'>>(tickets: T[]): T[] {
	const ready: T[] = [];
	const blocked: T[] = [];
	for (const ticket of tickets) {
		if (ticket.blockers.length > 0) blocked.push(ticket);
		else ready.push(ticket);
	}
	return [...ready, ...blocked];
}
