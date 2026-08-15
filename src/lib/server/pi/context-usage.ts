// Maps pi's `AgentSession.getContextUsage()` (`ContextUsage`) to a portal
// `context.usage` PortalEvent so the existing persistence / SSE / UI pipeline
// lights up unchanged. pi exposes only tokens / contextWindow / percent — no
// per-category breakdown, so the simple meter fields are all we carry.
//
// Returns `null` when the snapshot is not actionable (tokens unknown right
// after compaction, or no positive context window) so the caller skips the
// emission and the meter keeps its last value.

import type { ContextUsage } from '@earendil-works/pi-coding-agent';
import type { PortalEvent } from '$lib/types';

export function piContextUsageToEvent(usage: ContextUsage): PortalEvent | null {
	if (usage.tokens === null || usage.contextWindow <= 0) return null;
	return {
		type: 'context.usage',
		currentTokens: usage.tokens,
		tokenLimit: usage.contextWindow,
		// Client falls back to computing pct from current/tokenLimit when absent.
		...(usage.percent !== null ? { percentage: usage.percent } : {})
	};
}
