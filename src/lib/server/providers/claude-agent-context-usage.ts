// Single module that owns the Agent SDK `Query.getContextUsage()` control
// request. The API is EXPERIMENTAL (the SDK ships it without a stability
// guarantee — a sibling `usage_EXPERIMENTAL_MAY_CHANGE_...` is even more
// explicitly unstable), so every touch of it lives here: a method rename or
// removal degrades to "no usage" in this one file and nowhere else.

import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import type { ContextUsageCategory, ContextUsageGridRow, PortalEvent } from '$lib/types';
import { log } from '../log';

/** The subset of the SDK Query the poller needs. `getContextUsage` is optional
 * so a renamed/removed API yields `null` instead of throwing at the call site. */
export interface ContextUsageQuery {
	getContextUsage?(): Promise<unknown>;
}

/** Default `get_context_usage` timeout: the poll must never stall the turn. */
const POLL_TIMEOUT_MS = 2000;

/**
 * Poll the live SDK query for the context-window snapshot and normalize it into
 * a `context.usage` PortalEvent for the existing usage pipeline (persist + SSE
 * + meter). Returns `null` when the API is absent, malformed, or times out —
 * never throws.
 */
export async function pollContextUsage(query: ContextUsageQuery): Promise<PortalEvent | null> {
	const getContextUsage = query?.getContextUsage;
	if (typeof getContextUsage !== 'function') return null;
	let raw: SDKControlGetContextUsageResponse;
	try {
		raw = (await withTimeout(
			getContextUsage.call(query),
			POLL_TIMEOUT_MS
		)) as SDKControlGetContextUsageResponse;
	} catch (err) {
		log.warn('claude_agent.context_usage_poll_failed', { err: String(err) });
		return null;
	}
	if (!isUsageResponse(raw)) return null;
	return normalizeEvent(raw);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('getContextUsage timed out')), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

function isUsageResponse(value: unknown): value is SDKControlGetContextUsageResponse {
	if (typeof value !== 'object' || value === null) return false;
	const r = value as Record<string, unknown>;
	return typeof r.totalTokens === 'number' && typeof r.maxTokens === 'number';
}

function normalizeEvent(raw: SDKControlGetContextUsageResponse): PortalEvent {
	const categories: ContextUsageCategory[] = (raw.categories ?? []).map((c) => ({
		name: c.name,
		tokens: c.tokens,
		color: c.color,
		...(c.isDeferred !== undefined ? { isDeferred: c.isDeferred } : {})
	}));
	const gridRows: ContextUsageGridRow[][] = (raw.gridRows ?? []).map((row) =>
		row.map((sq) => ({
			color: sq.color,
			isFilled: sq.isFilled,
			categoryName: sq.categoryName,
			tokens: sq.tokens,
			percentage: sq.percentage,
			squareFullness: sq.squareFullness
		}))
	);
	const percentage =
		typeof raw.percentage === 'number'
			? raw.percentage
			: raw.maxTokens > 0
				? (raw.totalTokens / raw.maxTokens) * 100
				: 0;
	const systemTokens = categoryTokens(categories, /system/i);
	const conversationTokens = categoryTokens(categories, /message/i);
	const toolDefinitionTokens = categoryTokens(categories, /tool/i);
	return {
		type: 'context.usage',
		currentTokens: raw.totalTokens,
		tokenLimit: raw.maxTokens,
		messagesLength: 0,
		...(systemTokens !== null ? { systemTokens } : {}),
		...(conversationTokens !== null ? { conversationTokens } : {}),
		...(toolDefinitionTokens !== null ? { toolDefinitionsTokens: toolDefinitionTokens } : {}),
		percentage,
		categories,
		gridRows,
		...(raw.model ? { model: raw.model } : {})
	};
}

function categoryTokens(categories: ContextUsageCategory[], pattern: RegExp): number | null {
	const match = categories.find((c) => pattern.test(c.name));
	return match ? match.tokens : null;
}
