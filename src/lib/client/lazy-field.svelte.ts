// Reactive, record-keyed view over the lazy-field fetch memo.
//
// Every piece of state here is keyed by (conversation, kind, record id) and
// lives at module scope, never on a component instance. That matters: the
// transcript's `{#each}` blocks are keyed by index, so a single ToolCall /
// DiffView instance can be re-bound to a *different* record as a list changes
// shape. Instance-local "the text I fetched" state would then render one
// record's args or diff under another record's identity — visible as a wrong
// summary line, and dangerous in the rerun confirmation, which shows the user
// the arguments they are approving.
//
// Storage is bounded the same way the underlying fetch memo is: by the life of
// the page, holding only fields the user actually opened.

import { fetchLazyField, peekLazyField, lazyFieldUrl, type LazyFieldKind } from './lazy-field';

const values = $state<Record<string, string>>({});
const loading = $state<Record<string, boolean>>({});
const errors = $state<Record<string, string>>({});

export interface LazyFieldState {
	/** Fetched text, or null if it hasn't been loaded (or failed). */
	value: string | null;
	loading: boolean;
	error: string | null;
}

const IDLE: LazyFieldState = { value: null, loading: false, error: null };

export function lazyFieldState(
	conversationId: string | undefined,
	kind: LazyFieldKind,
	recordId: number | string
): LazyFieldState {
	if (!conversationId) return IDLE;
	const key = lazyFieldUrl(conversationId, kind, recordId);
	// Seed from the fetch memo so a record another component already loaded is
	// rendered immediately rather than re-requested.
	const value = values[key] ?? peekLazyField(conversationId, kind, recordId);
	return {
		value,
		loading: loading[key] === true,
		error: errors[key] ?? null
	};
}

export async function loadLazyField(
	conversationId: string | undefined,
	kind: LazyFieldKind,
	recordId: number | string
): Promise<void> {
	if (!conversationId) return;
	const key = lazyFieldUrl(conversationId, kind, recordId);
	delete errors[key];
	loading[key] = true;
	try {
		// No early-return when a request for this key is already in flight:
		// `fetchLazyField` de-duplicates and hands back the SAME promise, so a
		// second caller genuinely awaits the first fetch. That matters because
		// the rerun confirmation does `await loadLazyField(...)` and then insists
		// on having the arguments — returning early there would report a bogus
		// "could not load" while the request was about to succeed.
		values[key] = await fetchLazyField(conversationId, kind, recordId);
	} catch (e) {
		errors[key] = e instanceof Error ? e.message : String(e);
	} finally {
		delete loading[key];
	}
}

/**
 * Load a field once, unless it is already present, in flight, or has failed —
 * a failure must stay put so the user sees a retryable error instead of a
 * silent request loop.
 */
export function ensureLazyField(
	conversationId: string | undefined,
	kind: LazyFieldKind,
	recordId: number | string
): void {
	const state = lazyFieldState(conversationId, kind, recordId);
	if (state.value !== null || state.loading || state.error !== null) return;
	void loadLazyField(conversationId, kind, recordId);
}
