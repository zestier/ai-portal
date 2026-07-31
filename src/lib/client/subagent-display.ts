import type { ToolCallRecord } from '$lib/types';

export type SubagentArgs = {
	name?: string;
	description?: string;
	agent_type?: string;
	model?: string;
	mode?: string;
	prompt?: string;
};

export type SubagentDisplayState = {
	pending: boolean;
	isBackgroundLaunch: boolean;
	statusClass: 'pending' | 'ok' | 'error' | 'denied' | 'background';
	statusLabel: string;
	lifecycleText: string | null;
	resultText: string | null;
	backgroundAgentId: string | null;
	/**
	 * Final, settled duration of the run, available once the agent has
	 * completed (`backgroundAgentEndedAt - backgroundAgentStartedAt`, or
	 * `endedAt - startedAt`). `null` while still running.
	 */
	elapsedMs: number | null;
	/**
	 * Whether the agent is still in progress and the elapsed counter should
	 * tick live. True only when a usable start timestamp (`elapsedStartMs`) is
	 * available; if the start time is briefly absent we report `false` so the
	 * UI shows no label rather than a misleading ~0s value.
	 */
	running: boolean;
	/**
	 * The agent's real start timestamp to tick a live elapsed counter from
	 * while `running`. `backgroundAgentStartedAt` for background launches,
	 * `startedAt` for pending synchronous subagents, else `null`.
	 */
	elapsedStartMs: number | null;
};

/** Presentation metadata for a subagent card, keyed off its `agent_type`. */
export type SubagentPresentation = {
	/** Emoji shown in the card header. */
	icon: string;
	/**
	 * Whether the card auto-expands while the agent is running. Most subagents
	 * do (so the user sees live activity); background actors like the memory
	 * extractor stay collapsed by default to avoid distracting from the main
	 * reply. The user can always expand manually.
	 */
	autoExpandWhilePending: boolean;
};

const DEFAULT_PRESENTATION: SubagentPresentation = {
	icon: '🤖',
	autoExpandWhilePending: true
};

// Per-`agent_type` presentation overrides. Add an entry here to give a special
// agent its own icon rather than threading another conditional through the
// component. Anything not listed falls back to DEFAULT_PRESENTATION.
const AGENT_PRESENTATION: Record<string, SubagentPresentation> = {
	// Background memory extractor reuses the subagent card but is a distinct
	// actor, so it gets its own icon and stays collapsed by default.
	'memory-extractor': { icon: '🧠', autoExpandWhilePending: false }
};

export function getSubagentPresentation(agentType: string | undefined): SubagentPresentation {
	if (agentType && Object.prototype.hasOwnProperty.call(AGENT_PRESENTATION, agentType)) {
		return AGENT_PRESENTATION[agentType];
	}
	return DEFAULT_PRESENTATION;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v != null && typeof v === 'object' && !Array.isArray(v);
}

export function parseSubagentArgs(json: string | null): SubagentArgs {
	if (json === null) return {};
	try {
		const v = JSON.parse(json);
		return isRecord(v) ? (v as SubagentArgs) : {};
	} catch {
		return {};
	}
}

export function extractSubagentResultText(resultJson: string | null): string | null {
	if (!resultJson) return null;
	try {
		const v = JSON.parse(resultJson);
		if (typeof v === 'string') return v;
		if (isRecord(v)) {
			for (const key of ['content', 'result', 'text', 'output', 'response', 'summary']) {
				const candidate = v[key];
				if (typeof candidate === 'string' && candidate.length > 0) return candidate;
			}
			if (Array.isArray(v.content)) {
				const parts = v.content
					.map((p) =>
						isRecord(p) && typeof p.text === 'string'
							? p.text
							: isRecord(p) && 'text' in p
								? String(p.text)
								: ''
					)
					.filter(Boolean);
				if (parts.length > 0) return parts.join('\n\n');
			}
		}
		return null;
	} catch {
		return resultJson;
	}
}

function parseResult(resultJson: string | null): unknown {
	if (!resultJson) return null;
	try {
		return JSON.parse(resultJson);
	} catch {
		return resultJson;
	}
}

function cleanAgentId(id: string): string {
	return id.replace(/[.,;:)]+$/, '');
}

function findAgentId(value: unknown): string | null {
	if (typeof value === 'string') {
		const match =
			value.match(/\bagent[_ -]?id\b\s*[:=]\s*`?([A-Za-z0-9_.:-]+)`?/i) ??
			value.match(
				/\bread_agent\b(?:\s+(?:with|for|using|agent|id|agent_id))*\s+`?([A-Za-z0-9_.:-]+)`?/i
			);
		return match?.[1] ? cleanAgentId(match[1]) : null;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const id = findAgentId(item);
			if (id) return id;
		}
		return null;
	}
	if (!isRecord(value)) return null;

	for (const key of ['agent_id', 'agentId', 'agentID']) {
		const candidate = value[key];
		if (typeof candidate === 'string' && candidate.length > 0) return cleanAgentId(candidate);
	}

	for (const key of ['id', 'content', 'result', 'text', 'output', 'response', 'summary']) {
		const candidate = value[key];
		if (typeof candidate === 'string' && candidate.length > 0) {
			if (key === 'id') return cleanAgentId(candidate);
			const id = findAgentId(candidate);
			if (id) return id;
		} else if (candidate != null && typeof candidate === 'object') {
			const id = findAgentId(candidate);
			if (id) return id;
		}
	}

	return null;
}

export function getBackgroundAgentId(resultJson: string | null): string | null {
	return findAgentId(parseResult(resultJson));
}

function backgroundElapsedMs(toolCall: ToolCallRecord): number | null {
	const start = toolCall.backgroundAgentStartedAt;
	if (start == null) return null;
	const end = toolCall.backgroundAgentEndedAt;
	if (end == null) return null;
	return Math.max(0, end - start);
}

function toolElapsedMs(toolCall: ToolCallRecord): number | null {
	return toolCall.endedAt != null ? Math.max(0, toolCall.endedAt - toolCall.startedAt) : null;
}

export function getSubagentDisplayState(toolCall: ToolCallRecord): SubagentDisplayState {
	const args = parseSubagentArgs(toolCall.argsJson);
	const isBackgroundLaunch = args.mode === 'background' && toolCall.status === 'ok';
	const pending = toolCall.status === 'pending';
	const backgroundAgentId = toolCall.backgroundAgentId ?? getBackgroundAgentId(toolCall.resultJson);

	if (isBackgroundLaunch) {
		const completed = toolCall.backgroundAgentStatus === 'completed';
		const failed = toolCall.backgroundAgentStatus === 'failed';
		// In progress while the lifecycle is neither completed nor failed. Only
		// treat it as "running" (i.e. eligible for a live counter) once a real
		// start timestamp is present; otherwise fall back to no label rather
		// than the launch tool-call's ~0s duration.
		const inProgress = !completed && !failed;
		const elapsedStartMs = inProgress ? (toolCall.backgroundAgentStartedAt ?? null) : null;
		return {
			pending,
			isBackgroundLaunch,
			statusClass: completed ? 'ok' : failed ? 'error' : 'background',
			statusLabel: completed ? 'completed' : failed ? 'failed' : 'launched',
			lifecycleText: completed
				? 'Background agent completed.'
				: failed
					? 'Background agent failed.'
					: 'Background agent launched.',
			resultText: extractSubagentResultText(toolCall.resultJson),
			backgroundAgentId,
			elapsedMs: backgroundElapsedMs(toolCall) ?? toolElapsedMs(toolCall),
			running: elapsedStartMs != null,
			elapsedStartMs
		};
	}

	return {
		pending,
		isBackgroundLaunch,
		statusClass: toolCall.status,
		statusLabel:
			toolCall.status === 'ok'
				? 'completed'
				: toolCall.status === 'error'
					? 'failed'
					: toolCall.status === 'denied'
						? 'denied'
						: 'running…',
		lifecycleText: null,
		resultText: extractSubagentResultText(toolCall.resultJson),
		backgroundAgentId: null,
		elapsedMs: toolElapsedMs(toolCall),
		// A pending synchronous subagent ticks from its launch start time.
		running: pending,
		elapsedStartMs: pending ? toolCall.startedAt : null
	};
}
