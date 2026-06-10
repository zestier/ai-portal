import { z } from 'zod';
import * as memoryRepo from '$lib/server/db/repos/memory';
import * as messages from '$lib/server/db/repos/messages';
import { getMemoryProfile } from './profiles';
import type { MemoryMode, Message } from '$lib/types';

export interface MemoryEntityIndexEntry {
	entityId: string;
	entityKey: string;
	entityType: string;
	displayName: string;
	status: string;
	factCount: number;
}

export interface MemoryAutoSearchHit {
	itemType: string;
	itemId: string;
	text: string;
	score: number;
}

export interface TurnMemoryPacket {
	mode: MemoryMode;
	instructions: string;
	summary: string;
	decisions: memoryRepo.MemoryDecision[];
	openLoops: memoryRepo.MemoryOpenLoop[];
	facts: memoryRepo.MemoryFact[];
	/**
	 * Per-session directives (standing rules) — facts with predicate
	 * `directive`. Held separately from `facts` so they can be rendered verbatim
	 * in an always-on header block and are never elided by the token budget.
	 */
	directives: memoryRepo.MemoryFact[];
	entities: memoryRepo.MemoryEntity[];
	recentEvents: memoryRepo.MemoryEvent[];
	/** Compact, always-present index of every queryable entity key. */
	entityIndex: MemoryEntityIndexEntry[];
	/** Server-side memory_search hits for the current turn (retrieval-augmented). */
	autoSearchHits: MemoryAutoSearchHit[];
	/** The turn query used to relevance-rank this packet, when conditioned. */
	relevanceQuery: string | null;
	/** id -> entityKey for every entity, so rendering preserves keys even when
	 *  an entity's full summary is dropped from the budgeted packet. */
	entityKeyById: Record<string, string>;
	toolGuidance: {
		mandatory: boolean;
		availableTools: string[];
		recallTriggers: string[];
	};
}

export interface MemoryPatchProposal {
	entities?: Array<{
		entityKey: string;
		entityType: string;
		displayName: string;
		summary?: string;
		metadata?: unknown;
	}>;
	events?: Array<{
		eventType: string;
		summary: string;
		payload?: unknown;
		visibility?: string;
		confidence?: number;
		entityKey?: string;
	}>;
	facts?: Array<{
		entityKey?: string;
		predicate: string;
		value?: unknown;
		visibility?: string;
		confidence?: number;
	}>;
	/**
	 * Legacy, read-only: no current write path emits decisions (the `decision`
	 * fact kind was retired). Kept so existing stored decisions still render and
	 * so `commitPatch` stays tolerant of any historical patch that carries them.
	 */
	decisions?: Array<{
		subject: string;
		decision: string;
		rationale?: string;
	}>;
	openLoops?: Array<{
		loopType: string;
		title: string;
		description?: string;
		priority?: number;
		relatedEntityKeys?: string[];
	}>;
	/**
	 * Resolutions for *existing* open loops the latest turn closed, answered, or
	 * abandoned — e.g. the user picked one of several offered options, so the
	 * unchosen ones should be dropped rather than left lingering. Without this
	 * the extraction pipeline is append-only and superseded loops accumulate,
	 * crowding the packet budget. `id` is an existing open-loop id (retrieve via
	 * memory_get_open_loops); `resolved` = completed/answered, `dropped` =
	 * abandoned/superseded.
	 */
	resolveOpenLoops?: Array<{
		id: string;
		status: 'resolved' | 'dropped';
		reason?: string;
	}>;
	/**
	 * Ids of existing open loops the extractor is explicitly keeping alive this
	 * turn. Not a commit action — `commitPatch` ignores it. It feeds open-loop
	 * liveness (see {@link ageOpenLoops}): a loop that was presented to the
	 * extractor but appears in neither `keepOpenLoops` nor `resolveOpenLoops`
	 * accrues idle turns and is eventually auto-dropped, so dead threads stop
	 * accumulating without the model having to notice their absence.
	 */
	keepOpenLoops?: string[];
}

export interface CommitMemoryPatchInput {
	conversationId: string;
	mode?: MemoryMode;
	turnId?: string | null;
	sourceMessageId?: string | null;
	patch: MemoryPatchProposal;
	summary?: string;
}

export function isEnabled(mode: MemoryMode): boolean {
	return mode !== 'off';
}

/**
 * Reserved fact predicate for per-session directives (standing rules): durable,
 * forward-looking behavioral instructions the user gives mid-session ("always do
 * X", "from now on Y", "never Z"). Stored as facts so they inherit pinning,
 * search, supersede semantics, and the patch/commit pipeline — but they are
 * forced pinned on commit and rendered verbatim in their own always-on packet
 * block, exempt from the token budget. Distinct from the story `world_rule`
 * primitive (in-fiction world state) and the permissions system's auto-allow
 * "rules".
 */
export const DIRECTIVE_PREDICATE = 'directive';

/**
 * Safety cap on how many standing directives are loaded and rendered into the
 * always-on, budget-exempt block. Directives bypass the token budget, so an
 * unbounded set could crowd out the rest of the packet; if a conversation
 * somehow exceeds this, the most recent directives win (newest are the ones the
 * user most recently asserted) and a truncation note is emitted.
 */
export const MAX_DIRECTIVES = 50;

export function isDirectivePredicate(predicate: string): boolean {
	return predicate.trim().toLowerCase() === DIRECTIVE_PREDICATE;
}

export interface BuildInitialPacketOptions {
	globalMemoryEnabled?: boolean;
	/** Current turn text (user message + recent transcript) used to relevance-rank. */
	query?: string;
	/** Token budget for the variable portion of the packet. */
	tokenBudget?: number;
}

const PACKET_TOKEN_BUDGETS: Record<MemoryMode, number> = {
	off: 0,
	lightweight: 900,
	project: 1200,
	story: 1400,
	strict: 2000
};

const AUTO_SEARCH_LIMIT = 8;

/**
 * Entity key for the per-conversation catch-all that anchors facts which the
 * extractor emitted without a specific referent. Keeping these on a real entity
 * (instead of a NULL entity_id) means every fact groups under some entity when
 * injected, which is far more coherent than a flat detached blob.
 */
const SESSION_ENTITY_KEY = 'session.context';

/**
 * Derive a sensible entityType and human display name from a namespaced entity
 * key like `character.mara` or `object.attic_key`. Used when a fact references
 * a key that has no entity yet, so we can mint one rather than drop the link.
 */
function deriveEntityFromKey(key: string): { entityType: string; displayName: string } {
	const segments = key.split(/[.:/]/).filter(Boolean);
	const entityType = segments.length > 1 ? segments[0] : 'concept';
	const tail = segments.at(-1) ?? key;
	const displayName =
		tail
			.split(/[_\-\s]+/)
			.filter(Boolean)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ') || key;
	return { entityType, displayName };
}

function packetTokenBudget(mode: MemoryMode): number {
	return PACKET_TOKEN_BUDGETS[mode] ?? 1200;
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Salience for facts: pinned facts dominate, then confidence and recency. Lets
 * the injector rank by durable importance instead of bare updated_at.
 */
function factSalience(fact: memoryRepo.MemoryFact): number {
	const pinned = fact.pinned ? 1_000_000 : 0;
	const recency = fact.updatedAt / 1e13;
	return pinned + fact.confidence + recency;
}

function relevanceRank(score: number | undefined, salience: number): number {
	// Relevance dominates when present; salience breaks ties / orders unmatched.
	return (score ?? 0) * 1000 + salience;
}

export function buildInitialPacket(
	conversationId: string,
	mode: MemoryMode,
	opts: BuildInitialPacketOptions = {}
): TurnMemoryPacket {
	const strict = mode === 'strict';
	const query = (opts.query ?? '').trim();
	const budget = opts.tokenBudget ?? packetTokenBudget(mode);

	const entityPool = memoryRepo.listEntities(conversationId, { limit: 500 });
	const allFacts = memoryRepo.listFacts(conversationId, { limit: strict ? 400 : 200 });
	// Directives are loaded in full (up to a safety cap) and held apart so every
	// active standing rule is always injected, regardless of how many other facts
	// exist or where they fall in the relevance-ranked fact pool. listFacts orders
	// by updated_at DESC, so capping the load keeps the most recently asserted
	// directives if a pathological conversation exceeds MAX_DIRECTIVES.
	const directives = memoryRepo
		.listFacts(conversationId, { predicate: DIRECTIVE_PREDICATE, limit: MAX_DIRECTIVES })
		.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
	const factPool = allFacts.filter((fact) => !isDirectivePredicate(fact.predicate));
	const eventPool = memoryRepo.listEvents(conversationId, { limit: strict ? 200 : 100 });
	const decisions = memoryRepo.listDecisions(conversationId, { limit: 40 });
	const openLoops = memoryRepo.listOpenLoops(conversationId, { limit: strict ? 80 : 40 });

	const entityKeyById: Record<string, string> = {};
	for (const entity of entityPool) entityKeyById[entity.id] = entity.entityKey;
	const keyOf = (id: string | null): string | null => (id ? (entityKeyById[id] ?? null) : null);
	const factCounts = memoryRepo.entityFactCounts(conversationId);

	// One search per turn powers both relevance ranking and the auto-search
	// section: scores rank the pools, the top hits are injected verbatim.
	const searchHits = query
		? memoryRepo.search(conversationId, { query, limit: Math.max(AUTO_SEARCH_LIMIT, 300) })
		: [];
	const scores = new Map<string, number>();
	for (const hit of searchHits) {
		scores.set(hit.itemId, Math.max(scores.get(hit.itemId) ?? 0, hit.score ?? 0));
	}

	const rankedFacts = [...factPool].sort(
		(a, b) =>
			relevanceRank(scores.get(b.id), factSalience(b)) -
			relevanceRank(scores.get(a.id), factSalience(a))
	);
	const rankedEvents = [...eventPool].sort(
		(a, b) =>
			relevanceRank(scores.get(b.id), b.createdAt / 1e13) -
			relevanceRank(scores.get(a.id), a.createdAt / 1e13)
	);
	const rankedEntities = [...entityPool].sort(
		(a, b) =>
			relevanceRank(scores.get(b.id), b.updatedAt / 1e13) -
			relevanceRank(scores.get(a.id), a.updatedAt / 1e13)
	);

	// Always-present, compact entity-key index. Bounded by its own count cap
	// (not the body token budget) so agent-driven recall can always target every
	// entity by name even when individual fact bodies are dropped from the packet.
	const entityIndex: MemoryEntityIndexEntry[] = rankedEntities
		.slice(0, strict ? 200 : 120)
		.map((entity) => ({
			entityId: entity.id,
			entityKey: entity.entityKey,
			entityType: entity.entityType,
			displayName: entity.displayName,
			status: entity.status,
			factCount: factCounts.get(entity.id) ?? 0
		}));

	// Decisions and open loops are cheap, high-value continuity: always pinned.
	// The token budget is spent on the growing body content — relevance-ranked
	// facts and events plus entity summaries — so the packet stays bounded
	// regardless of how much total memory exists.
	let spent = 0;

	const factCap = strict ? 120 : 60;
	const facts: memoryRepo.MemoryFact[] = [];
	for (const fact of rankedFacts) {
		if (facts.length >= factCap) break;
		const cost = estimateTokens(factLine(fact, keyOf));
		if (fact.pinned || spent + cost <= budget) {
			facts.push(fact);
			spent += cost;
		}
	}

	const eventCap = strict ? 50 : 20;
	const recentEvents: memoryRepo.MemoryEvent[] = [];
	for (const event of rankedEvents) {
		if (recentEvents.length >= eventCap) break;
		const cost = estimateTokens(eventLine(event, keyOf));
		if (spent + cost <= budget) {
			recentEvents.push(event);
			spent += cost;
		}
	}

	const entityCap = strict ? 80 : 40;
	const entities: memoryRepo.MemoryEntity[] = [];
	for (const entity of rankedEntities) {
		if (entities.length >= entityCap) break;
		const cost = estimateTokens(entityLine(entity));
		if (spent + cost <= budget) {
			entities.push(entity);
			spent += cost;
		}
	}

	const autoSearchHits: MemoryAutoSearchHit[] = searchHits
		.slice(0, AUTO_SEARCH_LIMIT)
		.map((hit) => ({
			itemType: hit.itemType,
			itemId: hit.itemId,
			text: hit.text,
			score: hit.score ?? 0
		}));

	return {
		mode,
		instructions: memoryInstructions(mode),
		summary: summarizePacket({ entities, facts, decisions, openLoops, recentEvents, directives }),
		entities,
		facts,
		directives,
		decisions,
		openLoops,
		recentEvents,
		entityIndex,
		autoSearchHits,
		relevanceQuery: query || null,
		entityKeyById,
		toolGuidance: {
			mandatory: true,
			availableTools: [
				'memory_search',
				'memory_get_entity',
				'memory_get_open_loops',
				'memory_get_recent_events',
				'memory_transcript_lookup',
				'memory_query_timeline',
				'memory_query_clues',
				'memory_get_character_knowledge',
				'memory_check_claims',
				...(opts.globalMemoryEnabled ? ['memory_global_remember', 'memory_global_search'] : [])
			],
			recallTriggers: [
				'user asks about earlier details',
				'claim depends on prior state not in the packet',
				'object, task, file, clue, decision, or promise changes state',
				'answer refers to previous commands, failures, or design decisions',
				'story answer depends on character, location, inventory, or world rules',
				'strict answer depends on timeline, clue, secret, or visibility boundaries'
			]
		}
	};
}

export function buildPromptWithMemory(params: {
	conversationId: string;
	mode: MemoryMode;
	userMsg: Message;
	includeRecentTranscript?: boolean;
	globalMemoryEnabled?: boolean;
	extractorPresent?: boolean;
}): string {
	const recent = params.includeRecentTranscript
		? recentTranscript(params.conversationId, params.userMsg.id, 6)
		: '';
	// Condition selection (and the auto-search prestep) on the current turn.
	const query = [params.userMsg.content, recent].filter(Boolean).join('\n').trim();
	const packet = buildInitialPacket(params.conversationId, params.mode, {
		globalMemoryEnabled: params.globalMemoryEnabled,
		query
	});
	const writeGuidance = params.extractorPresent
		? 'A dedicated memory extractor reviews every turn after you respond and records durable memory on your behalf. You have no direct memory-write tool — do not attempt to write memory yourself. Concentrate on answering well and querying the recall tools as needed, and let the extractor capture what to remember.'
		: 'Durable memory is captured automatically after each turn; you have no direct memory-write tool. Concentrate on answering well and use the recall tools to pull in anything you need.';
	return [
		'<portal_memory_mode>',
		renderMemoryPacket(packet),
		'</portal_memory_mode>',
		'',
		'You are running in a fresh model context for this request. Durable session memory, not hidden chat context, is the source of continuity.',
		'The packet above is a deliberately small, turn-relevant slice of durable memory selected for your current question — it is not the whole memory store. Treat it as a starting index, not the full picture.',
		'The entity index lists every entity you can query by name even when its details were not injected. Auto-retrieved memory below was pulled by searching your current message.',
		'Whenever the answer could depend on details that are missing from or only partially covered by the packet, proactively query the memory tools (memory_search, memory_get_entity, memory_get_open_loops, memory_get_recent_events, and the others) to pull in more before you respond. Prefer querying too often over assuming; querying is cheap, inventing details is not.',
		'Do not invent older details when memory returns unknown.',
		writeGuidance,
		recent ? `\n<recent_transcript>\n${recent}\n</recent_transcript>\n` : '',
		'Final user message:',
		params.userMsg.content
	].join('\n');
}

export function validatePatch(
	patch: MemoryPatchProposal,
	opts: { conversationId?: string; mode?: MemoryMode } = {}
): {
	ok: boolean;
	issues: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>;
} {
	const issues: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }> =
		[];
	for (const fact of patch.facts ?? []) {
		if (fact.value === undefined) {
			issues.push({
				severity: 'error',
				code: 'fact_value_missing',
				message: `Fact "${fact.predicate}" is missing a value.`
			});
		}
		if (isDirectivePredicate(fact.predicate)) {
			const text = typeof fact.value === 'string' ? fact.value.trim() : '';
			if (!text || text.length < 3) {
				issues.push({
					severity: 'error',
					code: 'directive_value_invalid',
					message:
						'Directive facts must store the standing instruction as a non-empty string (at least 3 characters).'
				});
			}
		}
	}
	for (const loop of patch.openLoops ?? []) {
		if (loop.title.trim().length < 3) {
			issues.push({
				severity: 'error',
				code: 'open_loop_title_too_short',
				message: 'Open loop titles must be at least 3 characters.'
			});
		}
	}
	if (opts.conversationId) {
		const seenResolutionIds = new Set<string>();
		for (const resolution of patch.resolveOpenLoops ?? []) {
			// A resolution may reference a loop by its stable key or its raw id;
			// resolve to the canonical id so dedupe and existence checks agree
			// regardless of which form the model used.
			const loopId = memoryRepo.resolveOpenLoopId(opts.conversationId, resolution.id);
			const existing = loopId ? memoryRepo.getOpenLoop(opts.conversationId, loopId) : null;
			const dedupeKey = loopId ?? resolution.id;
			if (seenResolutionIds.has(dedupeKey)) {
				issues.push({
					severity: 'warning',
					code: 'open_loop_resolution_duplicate',
					message: `Open loop ${resolution.id} is resolved more than once in this patch.`
				});
				continue;
			}
			seenResolutionIds.add(dedupeKey);
			if (!existing) {
				// Likely a hallucinated or already-deleted reference; the commit is
				// a no-op, so warn rather than block the rest of the patch.
				issues.push({
					severity: 'warning',
					code: 'open_loop_resolution_unknown_id',
					message: `Open loop ${resolution.id} to resolve was not found; ignoring.`
				});
			} else if (existing.status !== 'open') {
				issues.push({
					severity: 'info',
					code: 'open_loop_resolution_not_open',
					message: `Open loop ${resolution.id} is already "${existing.status}"; re-resolving as "${resolution.status}".`
				});
			}
		}
	}
	if (opts.mode === 'project') {
		for (const fact of patch.facts ?? []) {
			if (/^(file|repo|test|command)[._-]/i.test(fact.predicate)) {
				issues.push({
					severity: 'warning',
					code: 'project_fact_must_be_historical',
					message: `Project fact "${fact.predicate}" should be treated as historical until revalidated against current tools or files.`
				});
			}
		}
	}
	if ((opts.mode === 'story' || opts.mode === 'strict') && opts.conversationId) {
		for (const fact of patch.facts ?? []) {
			if (!fact.entityKey || fact.predicate !== 'location' || fact.value === undefined) continue;
			const entity = memoryRepo.getEntity(opts.conversationId, fact.entityKey);
			if (!entity) continue;
			const existing = memoryRepo
				.listFacts(opts.conversationId, {
					entityId: entity.id,
					predicate: 'location',
					limit: 10
				})
				.find((row) => JSON.stringify(row.value) !== JSON.stringify(fact.value));
			if (existing) {
				issues.push({
					severity: opts.mode === 'strict' ? 'error' : 'warning',
					code: 'location_conflict',
					message: `New location for ${fact.entityKey} conflicts with active location fact ${existing.id}.`
				});
			}
		}
	}
	if (opts.mode === 'strict') {
		for (const fact of patch.facts ?? []) {
			if ((fact.confidence ?? 1) < 0.8) {
				issues.push({
					severity: 'warning',
					code: 'strict_low_confidence_fact',
					message: `Strict mode fact "${fact.predicate}" has confidence below 0.8.`
				});
			}
			if (fact.predicate.startsWith('knowledge:')) {
				const subject = fact.predicate.slice('knowledge:'.length);
				if (!fact.entityKey) {
					issues.push({
						severity: 'error',
						code: 'strict_knowledge_without_entity',
						message: `Strict mode knowledge fact "${fact.predicate}" must identify the character entity that holds the knowledge.`
					});
				} else if (subject && subject !== fact.entityKey) {
					issues.push({
						severity: 'error',
						code: 'strict_knowledge_entity_mismatch',
						message: `Strict mode knowledge fact "${fact.predicate}" is attached to ${fact.entityKey}, not ${subject}.`
					});
				}
			}
			if (fact.predicate === 'clue' && !hasObjectStringFields(fact.value, ['id', 'status'])) {
				issues.push({
					severity: 'error',
					code: 'strict_clue_shape_invalid',
					message: 'Strict mode clue facts must store an object with string id and status fields.'
				});
			}
			if (isSecretPredicate(fact.predicate) && !isHiddenVisibility(fact.visibility)) {
				issues.push({
					severity: 'error',
					code: 'strict_secret_visibility_required',
					message: `Strict mode secret fact "${fact.predicate}" must use hidden/private/gm visibility.`
				});
			}
		}
		for (const event of patch.events ?? []) {
			if (['timeline', 'alibi', 'clue_revealed'].includes(event.eventType) && !event.entityKey) {
				issues.push({
					severity: 'warning',
					code: 'strict_event_without_entity',
					message: `Strict mode ${event.eventType} events should identify a related entity.`
				});
			}
			if ((event.confidence ?? 1) < 0.8) {
				issues.push({
					severity: 'warning',
					code: 'strict_low_confidence_event',
					message: `Strict mode event "${event.eventType}" has confidence below 0.8.`
				});
			}
		}
		for (const loop of patch.openLoops ?? []) {
			if (loop.loopType === 'clue' && !loop.description?.trim()) {
				issues.push({
					severity: 'warning',
					code: 'strict_clue_loop_missing_description',
					message: `Strict mode clue loop "${loop.title}" should include the clue detail in its description.`
				});
			}
		}
		issues.push(...solveStrictContinuity(patch, opts.conversationId));
	}
	return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
}

export function solveStrictContinuity(
	patch: MemoryPatchProposal,
	conversationId?: string
): Array<{ severity: 'warning' | 'error'; code: string; message: string }> {
	const issues: Array<{ severity: 'warning' | 'error'; code: string; message: string }> = [];
	const seen = new Map<string, { location: string; summary: string }>();
	for (const event of patch.events ?? []) {
		if (!isTimelineEvent(event.eventType)) continue;
		const point = timelinePoint(event.payload);
		if (!event.entityKey || !point) continue;
		const key = `${event.entityKey}\u0000${point.at}`;
		const existing = seen.get(key);
		if (existing && existing.location !== point.location) {
			issues.push({
				severity: 'error',
				code: 'strict_timeline_location_conflict',
				message: `${event.entityKey} has conflicting locations at ${point.at}: ${existing.location} and ${point.location}.`
			});
		} else {
			seen.set(key, { location: point.location, summary: event.summary });
		}
		if (conversationId) {
			const entity = memoryRepo.getEntity(conversationId, event.entityKey);
			if (!entity) continue;
			const conflict = memoryRepo
				.listEvents(conversationId, { entityId: entity.id, limit: 200 })
				.find((row) => {
					if (!isTimelineEvent(row.eventType)) return false;
					const prior = timelinePoint(row.payload);
					return prior?.at === point.at && prior.location !== point.location;
				});
			if (conflict) {
				issues.push({
					severity: 'error',
					code: 'strict_timeline_existing_conflict',
					message: `${event.entityKey} conflicts with existing timeline event ${conflict.id} at ${point.at}.`
				});
			}
		}
	}
	return issues;
}

function hasObjectStringFields(value: unknown, fields: string[]): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return fields.every(
		(field) => typeof record[field] === 'string' && record[field].trim().length > 0
	);
}

function isTimelineEvent(eventType: string): boolean {
	return eventType === 'timeline' || eventType === 'alibi' || eventType === 'location';
}

function timelinePoint(payload: unknown): { at: string; location: string } | null {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
	const record = payload as Record<string, unknown>;
	const at =
		typeof record.at === 'string' ? record.at : typeof record.time === 'string' ? record.time : '';
	const location =
		typeof record.location === 'string'
			? record.location
			: typeof record.place === 'string'
				? record.place
				: '';
	if (!at.trim() || !location.trim()) return null;
	return { at: at.trim(), location: location.trim() };
}

function isSecretPredicate(predicate: string): boolean {
	return /(^|[:._-])(secret|gm_secret|hidden|private)([:._-]|$)/i.test(predicate);
}

export function isHiddenVisibility(visibility: string | undefined): boolean {
	return visibility === 'hidden' || visibility === 'private' || visibility === 'gm';
}

export function commitPatch(
	input: CommitMemoryPatchInput,
	extractor?: {
		extractorKind?: string;
		extractorModel?: string;
		extractorConfidence?: number;
		extractorDiagnostics?: unknown;
	}
): {
	patch: memoryRepo.MemoryPatch;
	counts: {
		entities: number;
		events: number;
		facts: number;
		decisions: number;
		openLoops: number;
		resolvedOpenLoops: number;
		issues: number;
	};
} {
	const validation = validatePatch(input.patch, {
		conversationId: input.conversationId,
		mode: input.mode
	});
	const status = validation.ok ? 'committed' : 'needs_review';
	const patchRecord = memoryRepo.createPatch(input.conversationId, {
		turnId: input.turnId ?? null,
		sourceMessageId: input.sourceMessageId ?? null,
		status,
		summary: input.summary ?? summarizePatch(input.patch),
		rawPatch: input.patch,
		validationResult: {
			...validation,
			extractor: extractor ?? null
		},
		extractorKind: extractor?.extractorKind,
		extractorModel: extractor?.extractorModel,
		extractorConfidence: extractor?.extractorConfidence,
		extractorDiagnostics: extractor?.extractorDiagnostics,
		committedAt: validation.ok ? Date.now() : null
	});
	for (const issue of validation.issues) {
		memoryRepo.addIssue(input.conversationId, { patchId: patchRecord.id, ...issue });
	}
	if (!validation.ok) {
		return {
			patch: patchRecord,
			counts: {
				entities: 0,
				events: 0,
				facts: 0,
				decisions: 0,
				openLoops: 0,
				resolvedOpenLoops: 0,
				issues: validation.issues.length
			}
		};
	}

	const entityIdsByKey = new Map<string, string>();
	for (const entity of input.patch.entities ?? []) {
		const row = memoryRepo.upsertEntity(input.conversationId, {
			...entity,
			sourceMessageId: input.sourceMessageId ?? null,
			turnId: input.turnId ?? null
		});
		entityIdsByKey.set(entity.entityKey, row.id);
		memoryRepo.recordPatchItem(input.conversationId, {
			patchId: patchRecord.id,
			itemType: 'entity',
			itemId: row.id,
			action: 'create'
		});
	}
	for (const key of collectEntityKeys(input.patch)) {
		if (!entityIdsByKey.has(key)) {
			const existing = memoryRepo.getEntity(input.conversationId, key);
			if (existing) entityIdsByKey.set(key, existing.id);
		}
	}

	let eventCount = 0;
	for (const event of input.patch.events ?? []) {
		const row = memoryRepo.addEvent(input.conversationId, {
			turnId: input.turnId,
			eventType: event.eventType,
			summary: event.summary,
			payload: event.payload,
			visibility: event.visibility,
			confidence: event.confidence,
			sourceMessageId: input.sourceMessageId ?? null,
			targetEntityId: event.entityKey ? (entityIdsByKey.get(event.entityKey) ?? null) : null
		});
		memoryRepo.recordPatchItem(input.conversationId, {
			patchId: patchRecord.id,
			itemType: 'event',
			itemId: row.id,
			action: 'create'
		});
		eventCount++;
	}

	// Facts are always anchored to an entity so memory stays organized and
	// injects coherently. A referenced-but-unknown key mints a minimal entity
	// from the key itself; a fact with no key at all is attached to the
	// per-conversation session entity (created lazily, only when needed).
	// Record a freshly minted entity as a patch item so it participates in
	// revert/review just like an explicitly-declared entity. Pre-existing
	// entities are reused silently and must NOT be recorded, or reverting this
	// patch would delete an entity that other patches rely on.
	const recordMintedEntity = (entityId: string) => {
		memoryRepo.recordPatchItem(input.conversationId, {
			patchId: patchRecord.id,
			itemType: 'entity',
			itemId: entityId,
			action: 'create'
		});
	};
	let sessionEntityId: string | null = null;
	const ensureSessionEntity = (): string => {
		if (sessionEntityId) return sessionEntityId;
		const cached = entityIdsByKey.get(SESSION_ENTITY_KEY);
		if (cached) {
			sessionEntityId = cached;
			return cached;
		}
		const existing = memoryRepo.getEntity(input.conversationId, SESSION_ENTITY_KEY);
		if (existing) {
			entityIdsByKey.set(SESSION_ENTITY_KEY, existing.id);
			sessionEntityId = existing.id;
			return existing.id;
		}
		const row = memoryRepo.upsertEntity(input.conversationId, {
			entityKey: SESSION_ENTITY_KEY,
			entityType: 'session',
			displayName: 'Session',
			summary: 'Catch-all for session-scoped facts not tied to a specific entity.',
			sourceMessageId: input.sourceMessageId ?? null,
			turnId: input.turnId ?? null
		});
		entityIdsByKey.set(SESSION_ENTITY_KEY, row.id);
		sessionEntityId = row.id;
		recordMintedEntity(row.id);
		return row.id;
	};
	const ensureEntityForKey = (key: string): string => {
		const known = entityIdsByKey.get(key);
		if (known) return known;
		// Reaching here means the key was absent from input.patch.entities and
		// from the DB (collectEntityKeys already resolved existing keys above),
		// so this is a genuinely new entity.
		const { entityType, displayName } = deriveEntityFromKey(key);
		const row = memoryRepo.upsertEntity(input.conversationId, {
			entityKey: key,
			entityType,
			displayName,
			sourceMessageId: input.sourceMessageId ?? null,
			turnId: input.turnId ?? null
		});
		entityIdsByKey.set(key, row.id);
		recordMintedEntity(row.id);
		return row.id;
	};

	let factCount = 0;
	for (const fact of input.patch.facts ?? []) {
		const entityId = fact.entityKey ? ensureEntityForKey(fact.entityKey) : ensureSessionEntity();
		// Directives are always-on standing rules: force them pinned so they
		// inherit the never-dropped guarantee in the packet builder, and store the
		// predicate in its canonical form so the (case-sensitive) directive load
		// query, the case-insensitive fact-pool filter, and consolidation grouping
		// all agree. Without normalizing, a "Directive"/" directive" predicate
		// would be excluded from the generic facts list yet missed by the directive
		// query — silently dropped from the packet.
		const isDirective = isDirectivePredicate(fact.predicate);
		const predicate = isDirective ? DIRECTIVE_PREDICATE : fact.predicate;
		const pinned = isDirective ? true : undefined;
		const row = memoryRepo.addFact(input.conversationId, {
			entityId,
			predicate,
			value: fact.value,
			visibility: fact.visibility,
			confidence: fact.confidence,
			pinned,
			sourceMessageId: input.sourceMessageId ?? null
		});
		memoryRepo.recordPatchItem(input.conversationId, {
			patchId: patchRecord.id,
			itemType: 'fact',
			itemId: row.id,
			action: 'create'
		});
		factCount++;
	}

	// Legacy decisions: retained so a historical patch carrying them still
	// commits, but no current extractor or heuristic emits this kind.
	for (const decision of input.patch.decisions ?? []) {
		const row = memoryRepo.addDecision(input.conversationId, {
			...decision,
			sourceMessageId: input.sourceMessageId ?? null
		});
		memoryRepo.recordPatchItem(input.conversationId, {
			patchId: patchRecord.id,
			itemType: 'decision',
			itemId: row.id,
			action: 'create'
		});
	}
	for (const loop of input.patch.openLoops ?? []) {
		const row = memoryRepo.addOpenLoop(input.conversationId, {
			loopType: loop.loopType,
			title: loop.title,
			description: loop.description,
			priority: loop.priority,
			relatedEntityIds: (loop.relatedEntityKeys ?? [])
				.map((key) => entityIdsByKey.get(key))
				.filter((id): id is string => !!id),
			sourceMessageId: input.sourceMessageId ?? null
		});
		memoryRepo.recordPatchItem(input.conversationId, {
			patchId: patchRecord.id,
			itemType: 'open_loop',
			itemId: row.id,
			action: 'create'
		});
	}
	let resolvedOpenLoops = 0;
	for (const resolution of input.patch.resolveOpenLoops ?? []) {
		// Accept either the stable loop key or the raw id; resolve to canonical id.
		const loopId = memoryRepo.resolveOpenLoopId(input.conversationId, resolution.id);
		const existing = loopId ? memoryRepo.getOpenLoop(input.conversationId, loopId) : null;
		// Skip unknown references (already warned in validation) so a hallucinated
		// id doesn't abort the rest of the commit.
		if (!loopId || !existing) continue;
		// Re-resolving an already-closed loop to the same status is a no-op:
		// skip it so we don't append the reason again (unbounded description
		// growth) or record a duplicate 'resolve' audit item across turns.
		if (existing.status !== 'open' && existing.status === resolution.status) continue;
		// Only annotate the description on the first resolution (while the loop
		// is still open). A later status change updates status only, again to
		// avoid the description growing without bound.
		const description =
			existing.status === 'open' && resolution.reason?.trim()
				? `${existing.description}${existing.description ? '\n' : ''}[${resolution.status}] ${resolution.reason.trim()}`
				: existing.description;
		const updated = memoryRepo.updateOpenLoop(input.conversationId, loopId, {
			status: resolution.status,
			description
		});
		if (!updated) continue;
		resolvedOpenLoops += 1;
		memoryRepo.recordPatchItem(input.conversationId, {
			patchId: patchRecord.id,
			itemType: 'open_loop',
			itemId: loopId,
			action: 'resolve'
		});
	}

	return {
		patch: patchRecord,
		counts: {
			entities: input.patch.entities?.length ?? 0,
			events: eventCount,
			facts: factCount,
			decisions: input.patch.decisions?.length ?? 0,
			openLoops: input.patch.openLoops?.length ?? 0,
			resolvedOpenLoops,
			issues: validation.issues.length
		}
	};
}

export interface AgeOpenLoopsResult {
	/** Ids of loops auto-dropped this turn because they aged out. */
	dropped: string[];
}

/**
 * Open-loop liveness ("touch-to-keep"). LLMs reliably notice what is present but
 * are poor at noticing what is *absent*, which is why open loops historically
 * accumulate forever — closing one requires spotting that a thread is no longer
 * live. This inverts the burden: every model-backed extraction the model lists
 * the loops that are still live (`keptLoopIds`); a loop that was presented to
 * the extractor but is neither kept nor closed accrues an idle turn, and once it
 * has been ignored for `baseThreshold + max(0, priority)` consecutive passes it
 * is auto-dropped.
 *
 * Only loops in `presentedLoopIds` are eligible — a loop the extractor never saw
 * (e.g. beyond the packet's open-loop cap) is never silently culled. The whole
 * mechanism is event-sourced (see `memoryRepo.recordOpenLoopLiveness`): the idle
 * counter and auto-drop are derived by replaying the liveness events, so
 * fork/rewind reconstruct them faithfully, and the drop is audited and
 * reversible like any other memory mutation.
 */
export function ageOpenLoops(
	conversationId: string,
	opts: {
		presentedLoopIds: Iterable<string>;
		keptLoopIds?: Iterable<string>;
		baseThreshold: number;
		sourceMessageId?: string | null;
		turnId?: string | null;
	}
): AgeOpenLoopsResult {
	return memoryRepo.recordOpenLoopLiveness(conversationId, {
		presentedLoopIds: [...opts.presentedLoopIds],
		keptLoopIds: opts.keptLoopIds ? [...opts.keptLoopIds] : [],
		baseThreshold: opts.baseThreshold,
		sourceMessageId: opts.sourceMessageId,
		turnId: opts.turnId
	});
}

export function extractHeuristicPatch(params: {
	userMsg: Message;
	assistantContent: string;
	mode: MemoryMode;
}): MemoryPatchProposal {
	const combined = `${params.userMsg.content}\n\n${params.assistantContent}`.trim();
	const patch: MemoryPatchProposal = { events: [], facts: [], openLoops: [] };
	if (!combined) return patch;

	if (/\b(todo|follow[- ]?up|open question|remember to|next step)\b/i.test(combined)) {
		patch.openLoops?.push({
			loopType: params.mode === 'project' ? 'project_task' : 'follow_up',
			title: cleanSentence(params.userMsg.content).slice(0, 160),
			description: 'Heuristically extracted as an unresolved loop from the latest turn.',
			priority: 0
		});
	}

	if (params.mode === 'story' || params.mode === 'strict') {
		const nameMatch = combined.match(/\b(character|npc|person)\s+([A-Z][A-Za-z0-9_-]{1,40})\b/);
		if (nameMatch) {
			const entityKey = `character.${nameMatch[2].toLowerCase()}`;
			patch.entities?.push({
				entityKey,
				entityType: 'character',
				displayName: nameMatch[2],
				summary: 'Mentioned in the story session.'
			});
			patch.facts?.push({
				entityKey,
				predicate: 'mentioned',
				value: true,
				confidence: 0.55
			});
		}
	}

	patch.events?.push({
		eventType: 'turn_observed',
		summary: cleanSentence(params.userMsg.content).slice(0, 240),
		payload: { mode: params.mode },
		confidence: 1
	});

	return patch;
}

/**
 * The write model the extractor (and any direct caller) speaks. Deliberately
 * narrowed to the two concepts that actually exist — `entities` (the durable
 * referents) and `facts` (everything you record about them) — plus
 * `closeLoops` for retiring existing threads.
 *
 * Every item in `facts` is a discriminated union on a REQUIRED `kind`, with no
 * default and no fallback: the model must explicitly decide what each thing is
 * before it can be written. `directive`, `decision`, `open_loop`, and `event`
 * are no longer separate top-level arrays nor magic predicates — they are fact
 * kinds. This is the single change that makes mis-filing (the classic "a
 * directive came out as a fact / decision / nothing at all") structurally hard:
 * there is exactly one place to put a thing, and you cannot put it there
 * without naming its kind.
 */
const PatchEntitySchema = z.object({
	entityKey: z.string().min(1).max(200),
	entityType: z.string().min(1).max(80),
	displayName: z.string().min(1).max(200),
	summary: z.string().max(4000).optional(),
	metadata: z.unknown().optional()
});

const PatchFactItemSchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('attribute'),
		entityKey: z.string().min(1).max(200).optional(),
		predicate: z.string().min(1).max(100),
		value: z.custom<unknown>((value) => value !== undefined, {
			message: 'value is required'
		}),
		visibility: z.string().min(1).max(100).optional(),
		confidence: z.number().min(0).max(1).optional()
	}),
	z.object({
		kind: z.literal('directive'),
		rule: z.string().trim().min(3).max(4000),
		entityKey: z.string().min(1).max(200).optional()
	}),
	z.object({
		kind: z.literal('open_loop'),
		loopType: z.string().min(1).max(100),
		title: z.string().min(1).max(200),
		description: z.string().max(8000).optional(),
		priority: z.number().int().min(-100).max(100).optional(),
		relatedEntityKeys: z.array(z.string().min(1).max(200)).max(50).optional()
	}),
	z.object({
		kind: z.literal('event'),
		eventType: z.string().min(1).max(100),
		summary: z.string().min(1).max(4000),
		entityKey: z.string().min(1).max(200).optional(),
		payload: z.unknown().optional(),
		visibility: z.string().min(1).max(100).optional(),
		confidence: z.number().min(0).max(1).optional()
	})
]);

const PatchCloseLoopSchema = z.object({
	id: z.string().min(1).max(200),
	status: z.enum(['resolved', 'dropped']),
	reason: z.string().max(2000).optional()
});

export type MemoryPatchFactItem = z.infer<typeof PatchFactItemSchema>;

export interface MemoryPatchInput {
	entities?: z.infer<typeof PatchEntitySchema>[];
	facts?: MemoryPatchFactItem[];
	closeLoops?: z.infer<typeof PatchCloseLoopSchema>[];
	keepOpenLoops?: string[];
}

/**
 * Fan the unified `facts[]` (discriminated on `kind`) back out into the
 * internal, table-shaped {@link MemoryPatchProposal} that `validatePatch` and
 * `commitPatch` already understand. Storage, the inspector, and the editable
 * `memory/[kind]` routes are unchanged — only the model-facing write shape is
 * unified. A `directive` becomes a pinned fact with the reserved
 * `directive` predicate, exactly as before.
 */
export function normalizeMemoryPatchInput(input: MemoryPatchInput): MemoryPatchProposal {
	const proposal: MemoryPatchProposal = {};
	if (input.entities?.length) proposal.entities = input.entities;

	const facts: NonNullable<MemoryPatchProposal['facts']> = [];
	const events: NonNullable<MemoryPatchProposal['events']> = [];
	const openLoops: NonNullable<MemoryPatchProposal['openLoops']> = [];

	for (const item of input.facts ?? []) {
		switch (item.kind) {
			case 'attribute':
				facts.push({
					entityKey: item.entityKey,
					predicate: item.predicate,
					value: item.value,
					visibility: item.visibility,
					confidence: item.confidence
				});
				break;
			case 'directive':
				facts.push({
					entityKey: item.entityKey,
					predicate: DIRECTIVE_PREDICATE,
					value: item.rule
				});
				break;
			case 'open_loop':
				openLoops.push({
					loopType: item.loopType,
					title: item.title,
					description: item.description,
					priority: item.priority,
					relatedEntityKeys: item.relatedEntityKeys
				});
				break;
			case 'event':
				events.push({
					eventType: item.eventType,
					summary: item.summary,
					entityKey: item.entityKey,
					payload: item.payload,
					visibility: item.visibility,
					confidence: item.confidence
				});
				break;
		}
	}

	if (facts.length) proposal.facts = facts;
	if (events.length) proposal.events = events;
	if (openLoops.length) proposal.openLoops = openLoops;
	if (input.closeLoops?.length) proposal.resolveOpenLoops = input.closeLoops;
	if (input.keepOpenLoops?.length) proposal.keepOpenLoops = input.keepOpenLoops;
	return proposal;
}

export const MemoryPatchInputSchema = z
	.object({
		entities: z.array(PatchEntitySchema).max(50).optional(),
		facts: z.array(PatchFactItemSchema).max(300).optional(),
		closeLoops: z.array(PatchCloseLoopSchema).max(50).optional(),
		keepOpenLoops: z.array(z.string().min(1).max(200)).max(200).optional()
	})
	.strict();

/**
 * The schema model output is parsed with. Accepts the unified write shape and
 * transforms it into the internal {@link MemoryPatchProposal}, so every
 * downstream consumer (`validatePatch`, `commitPatch`, summarization) is
 * untouched.
 */
export const MemoryPatchProposalSchema =
	MemoryPatchInputSchema.transform(normalizeMemoryPatchInput);

/** The fact kinds, in canonical order. */
export const MEMORY_FACT_KINDS = ['attribute', 'directive', 'open_loop', 'event'] as const;
export type MemoryFactKind = (typeof MEMORY_FACT_KINDS)[number];

/**
 * Per-kind JSON Schema for a single `facts[]` item, one object per kind. The
 * model-facing schema advertises a single *flattened* fact object (see
 * {@link MEMORY_FACT_FLAT_JSON_SCHEMA}) because many function-calling backends
 * constrain `oneOf`/discriminated unions poorly, but these precise per-branch
 * shapes are kept so a schema failure can echo back *only* the branch the model
 * was aiming for instead of the whole five-way union.
 */
export const MEMORY_FACT_KIND_SCHEMAS = {
	attribute: {
		type: 'object',
		additionalProperties: false,
		required: ['kind', 'predicate', 'value'],
		properties: {
			kind: { const: 'attribute' },
			entityKey: { type: 'string', minLength: 1, maxLength: 200 },
			predicate: { type: 'string', minLength: 1, maxLength: 100 },
			value: { description: 'Required attribute value (any JSON type except undefined).' },
			visibility: { type: 'string', minLength: 1, maxLength: 100 },
			confidence: { type: 'number', minimum: 0, maximum: 1 }
		}
	},
	directive: {
		type: 'object',
		additionalProperties: false,
		required: ['kind', 'rule'],
		properties: {
			kind: { const: 'directive' },
			rule: {
				type: 'string',
				minLength: 3,
				maxLength: 4000,
				description: 'The standing instruction, stated in full as a declarative rule.'
			},
			entityKey: { type: 'string', minLength: 1, maxLength: 200 }
		}
	},
	open_loop: {
		type: 'object',
		additionalProperties: false,
		required: ['kind', 'loopType', 'title'],
		properties: {
			kind: { const: 'open_loop' },
			loopType: { type: 'string', minLength: 1, maxLength: 100 },
			title: { type: 'string', minLength: 1, maxLength: 200 },
			description: { type: 'string', maxLength: 8000 },
			priority: { type: 'integer', minimum: -100, maximum: 100 },
			relatedEntityKeys: {
				type: 'array',
				maxItems: 50,
				items: { type: 'string', minLength: 1, maxLength: 200 }
			}
		}
	},
	event: {
		type: 'object',
		additionalProperties: false,
		required: ['kind', 'eventType', 'summary'],
		properties: {
			kind: { const: 'event' },
			eventType: { type: 'string', minLength: 1, maxLength: 100 },
			summary: { type: 'string', minLength: 1, maxLength: 4000 },
			entityKey: { type: 'string', minLength: 1, maxLength: 200 },
			payload: { description: 'Arbitrary JSON payload.' },
			visibility: { type: 'string', minLength: 1, maxLength: 100 },
			confidence: { type: 'number', minimum: 0, maximum: 1 }
		}
	}
} as const satisfies Record<MemoryFactKind, unknown>;

/**
 * A tiny, valid example per kind. Echoed back on a schema failure: a concrete
 * correct object is far easier for a model to copy than an abstract schema.
 */
export const MEMORY_FACT_KIND_EXAMPLES = {
	attribute: {
		kind: 'attribute',
		entityKey: 'auth_service',
		predicate: 'language',
		value: 'TypeScript'
	},
	directive: { kind: 'directive', rule: 'Keep responses under 200 words.' },
	open_loop: {
		kind: 'open_loop',
		loopType: 'task',
		title: 'Add rate limiting to the login endpoint'
	},
	event: { kind: 'event', eventType: 'deploy', summary: 'Shipped v1.2 to production' }
} as const satisfies Record<MemoryFactKind, { kind: MemoryFactKind } & Record<string, unknown>>;

/** The required field names (besides `kind`) for each kind, for error hints. */
export const MEMORY_FACT_KIND_REQUIRED_FIELDS: Record<MemoryFactKind, string[]> = {
	attribute: ['predicate', 'value'],
	directive: ['rule'],
	open_loop: ['loopType', 'title'],
	event: ['eventType', 'summary']
};

/**
 * Single, flattened JSON Schema for a `facts[]` item: `kind` is an enum and every
 * possible field is an optional property whose description names the kind(s) it
 * belongs to. The Zod {@link PatchFactItemSchema} discriminated union remains the
 * source of truth (it strips fields that don't belong to the chosen kind), so
 * advertising one flat object — rather than a five-way `oneOf` — gives weaker
 * backends a shape they can actually fill while losing nothing on validation.
 */
const MEMORY_FACT_FLAT_JSON_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['kind'],
	description:
		'One thing to remember. Set "kind" first — it decides which other fields are required. attribute: predicate + value. directive: rule. open_loop: loopType + title. event: eventType + summary.',
	properties: {
		kind: {
			type: 'string',
			enum: [...MEMORY_FACT_KINDS],
			description:
				'Required. attribute = something to KNOW (needs predicate + value); directive = a standing behavioural rule (needs rule); open_loop = an unresolved task/question (needs loopType + title); event = something that happened (needs eventType + summary).'
		},
		entityKey: {
			type: 'string',
			minLength: 1,
			maxLength: 200,
			description: 'Referent this attaches to. Used by attribute, directive, and event.'
		},
		predicate: {
			type: 'string',
			minLength: 1,
			maxLength: 100,
			description: 'attribute (required): the property name, e.g. "language".'
		},
		value: { description: 'attribute (required): the value (any JSON type).' },
		rule: {
			type: 'string',
			minLength: 3,
			maxLength: 4000,
			description: 'directive (required): the standing instruction, stated in full.'
		},
		loopType: {
			type: 'string',
			minLength: 1,
			maxLength: 100,
			description: 'open_loop (required): the kind of thread, e.g. "task" or "question".'
		},
		title: {
			type: 'string',
			minLength: 1,
			maxLength: 200,
			description: 'open_loop (required): a short title for the thread.'
		},
		description: { type: 'string', maxLength: 8000, description: 'open_loop (optional): detail.' },
		priority: {
			type: 'integer',
			minimum: -100,
			maximum: 100,
			description: 'open_loop (optional).'
		},
		relatedEntityKeys: {
			type: 'array',
			maxItems: 50,
			items: { type: 'string', minLength: 1, maxLength: 200 },
			description: 'open_loop (optional): related entity keys.'
		},
		eventType: {
			type: 'string',
			minLength: 1,
			maxLength: 100,
			description: 'event (required): the kind of event, e.g. "deploy".'
		},
		summary: {
			type: 'string',
			minLength: 1,
			maxLength: 4000,
			description: 'event (required): what happened.'
		},
		payload: { description: 'event (optional): arbitrary JSON payload.' },
		visibility: {
			type: 'string',
			minLength: 1,
			maxLength: 100,
			description: 'attribute / event (optional).'
		},
		confidence: {
			type: 'number',
			minimum: 0,
			maximum: 1,
			description: 'attribute / event (optional).'
		}
	}
} as const;

/** Where to put a lifted scalar when a `{ "<kind>": value }` shape is repaired. */
const MEMORY_FACT_KIND_PRIMARY_FIELD: Record<MemoryFactKind, string> = {
	attribute: 'value',
	directive: 'rule',
	open_loop: 'title',
	event: 'summary'
};

function isMemoryFactKind(value: unknown): value is MemoryFactKind {
	return typeof value === 'string' && (MEMORY_FACT_KINDS as readonly string[]).includes(value);
}

/**
 * Best-effort repair of a single malformed `facts[]` item before strict parsing.
 * Small models routinely collapse `{ "kind": "directive", "rule": "…" }` into
 * `{ "directive": "…" }` — using the kind value as the property key and stashing
 * the payload as its value. When an item has no usable `kind` but *does* carry a
 * key that is itself a kind name, lift it into the canonical shape rather than
 * bouncing the whole patch back. Deliberately conservative: it only fires when
 * `kind` is missing/invalid and a kind-named key is present, and never
 * overwrites a field the model already set.
 */
function coerceFactItem(item: unknown): { item: unknown; warning?: string } {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return { item };
	const record = item as Record<string, unknown>;
	if (isMemoryFactKind(record.kind)) return { item };

	const kindKey = MEMORY_FACT_KINDS.find(
		(kind) => kind in record && record[kind] !== undefined && record[kind] !== null
	);
	if (!kindKey) return { item };

	const lifted = record[kindKey];
	const repaired: Record<string, unknown> = { ...record };
	delete repaired[kindKey];
	repaired.kind = kindKey;
	const primaryField = MEMORY_FACT_KIND_PRIMARY_FIELD[kindKey];
	let placement = '';
	if (
		repaired[primaryField] === undefined &&
		(typeof lifted === 'string' || typeof lifted === 'number' || typeof lifted === 'boolean')
	) {
		repaired[primaryField] = lifted;
		placement = ` and moved its value into "${primaryField}"`;
	}
	return {
		item: repaired,
		warning: `Rewrote a fact that used "${kindKey}" as a key into { "kind": "${kindKey}", … }${placement}.`
	};
}

/**
 * Apply {@link coerceFactItem} across a raw patch's `facts[]`, returning the
 * (possibly) repaired patch plus any human-readable warnings describing what was
 * changed. Non-object / arrayless input is returned untouched.
 */
export function coerceMemoryPatchInput(raw: unknown): { patch: unknown; warnings: string[] } {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { patch: raw, warnings: [] };
	const record = raw as Record<string, unknown>;
	if (!Array.isArray(record.facts)) return { patch: raw, warnings: [] };
	const warnings: string[] = [];
	const facts = record.facts.map((fact, index) => {
		const { item, warning } = coerceFactItem(fact);
		if (warning) warnings.push(`facts[${index}]: ${warning}`);
		return item;
	});
	if (!warnings.length) return { patch: raw, warnings };
	return { patch: { ...record, facts }, warnings };
}

/**
 * Hand-written JSON Schema for the unified `patch` argument, used as the
 * single-shot extractor's `response_format` schema. Mirrors
 * {@link MemoryPatchInputSchema}; the Zod parse remains the source of truth.
 */
export const MEMORY_PATCH_JSON_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	description:
		'Durable memory patch. Only two concepts exist: entities (the referents) and facts (everything you record about them). Every item in facts MUST set "kind"; there is no default.',
	properties: {
		entities: {
			type: 'array',
			maxItems: 50,
			description:
				'Durable referents that facts attach to. Reuse an existing entityKey when one exists.',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['entityKey', 'entityType', 'displayName'],
				properties: {
					entityKey: { type: 'string', minLength: 1, maxLength: 200 },
					entityType: { type: 'string', minLength: 1, maxLength: 80 },
					displayName: { type: 'string', minLength: 1, maxLength: 200 },
					summary: { type: 'string', maxLength: 4000 },
					metadata: { description: 'Arbitrary JSON metadata.' }
				}
			}
		},
		facts: {
			type: 'array',
			maxItems: 300,
			description:
				'Everything to remember, each tagged with its kind. attribute = something to KNOW; directive = a standing rule for how you must behave; open_loop = an unresolved task/question; event = something that happened.',
			items: MEMORY_FACT_FLAT_JSON_SCHEMA
		},
		closeLoops: {
			type: 'array',
			maxItems: 50,
			description:
				'Retire existing open loops when this turn resolved or abandoned them. Reference each loop by the handle shown in its [id=...] in the packet (its stable key, e.g. loop.find_attic_key).',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['id', 'status'],
				properties: {
					id: {
						type: 'string',
						minLength: 1,
						maxLength: 200,
						description: 'The loop handle from its [id=...] in the packet (key or raw id).'
					},
					status: { type: 'string', enum: ['resolved', 'dropped'] },
					reason: { type: 'string', maxLength: 2000 }
				}
			}
		},
		keepOpenLoops: {
			type: 'array',
			maxItems: 200,
			description:
				"Handles (the [id=...] shown in the packet, i.e. each loop's stable key) of presented open loops that are STILL live and should stay open. Any presented loop you neither keep here nor close in closeLoops ages out and is auto-dropped after a few turns.",
			items: { type: 'string', minLength: 1, maxLength: 200 }
		}
	}
} as const;

function memoryInstructions(mode: MemoryMode): string {
	return getMemoryProfile(mode).instructions;
}

function summarizePacket(packet: {
	entities: memoryRepo.MemoryEntity[];
	facts: memoryRepo.MemoryFact[];
	decisions: memoryRepo.MemoryDecision[];
	openLoops: memoryRepo.MemoryOpenLoop[];
	recentEvents: memoryRepo.MemoryEvent[];
	directives?: memoryRepo.MemoryFact[];
}): string {
	return [
		packet.directives?.length ? `${packet.directives.length} directives` : '',
		`${packet.entities.length} entities`,
		`${packet.facts.length} active facts`,
		`${packet.decisions.length} decisions`,
		`${packet.openLoops.length} open loops`,
		`${packet.recentEvents.length} recent events`
	]
		.filter(Boolean)
		.join(', ');
}

function formatMemoryValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return 'null';
	return JSON.stringify(value);
}

function entityLine(entity: memoryRepo.MemoryEntity, includeId = false): string {
	const status = entity.status && entity.status !== 'active' ? ` [${entity.status}]` : '';
	const summary = entity.summary ? ` — ${cleanSentence(entity.summary)}` : '';
	const idStr = includeId ? ` [id=${entity.id}]` : '';
	return `- ${entity.entityKey} (${entity.entityType}) "${entity.displayName}"${status}${summary}${idStr}`;
}

function entityIndexLine(entry: MemoryEntityIndexEntry, includeId = false): string {
	const status = entry.status && entry.status !== 'active' ? ` [${entry.status}]` : '';
	const facts = entry.factCount ? ` (${entry.factCount} facts)` : '';
	const idStr = includeId ? ` [id=${entry.entityId}]` : '';
	return `- ${entry.entityKey} (${entry.entityType})${status}${facts}${idStr}`;
}

function factLine(
	fact: memoryRepo.MemoryFact,
	keyOf: (id: string | null) => string | null
): string {
	const key = keyOf(fact.entityId);
	const subject = key ? `${key}.` : '';
	return `- ${subject}${factDetail(fact)}`;
}

/**
 * The `predicate = value (meta)` body of a fact, without any entity prefix or
 * list bullet. Used when rendering facts grouped beneath their owning entity,
 * where the entity is already named by the surrounding block header.
 */
function factDetail(fact: memoryRepo.MemoryFact, includeId = false): string {
	const meta: string[] = [];
	if (fact.pinned) meta.push('pinned');
	if (fact.visibility && fact.visibility !== 'session') meta.push(fact.visibility);
	if (fact.confidence < 1) meta.push(`conf ${fact.confidence}`);
	if (fact.status && fact.status !== 'active') meta.push(fact.status);
	const metaStr = meta.length ? ` (${meta.join(', ')})` : '';
	const idStr = includeId ? ` [id=${fact.id}]` : '';
	return `${fact.predicate} = ${formatMemoryValue(fact.value)}${metaStr}${idStr}`;
}

function decisionLine(decision: memoryRepo.MemoryDecision, includeId = false): string {
	const status = decision.status && decision.status !== 'active' ? ` [${decision.status}]` : '';
	const rationale = decision.rationale ? ` — ${cleanSentence(decision.rationale)}` : '';
	const idStr = includeId ? ` [id=${decision.id}]` : '';
	return `- ${decision.subject}: ${decision.decision}${status}${rationale}${idStr}`;
}

function loopLine(
	loop: memoryRepo.MemoryOpenLoop,
	keyOf: (id: string | null) => string | null,
	opts: { includeId?: boolean; expiry?: { baseThreshold: number; warnWithin?: number } } = {}
): string {
	const related = loop.relatedEntityIds
		.map((id) => keyOf(id))
		.filter((key): key is string => Boolean(key));
	const relatedStr = related.length ? ` [related: ${related.join(', ')}]` : '';
	const status = loop.status && loop.status !== 'open' ? ` [${loop.status}]` : '';
	const desc = loop.description ? ` — ${cleanSentence(loop.description)}` : '';
	// The extractor needs a handle to keep/close the loop; the main-turn
	// injection omits it as noise. Prefer the stable, legible loop key over the
	// opaque ULID (older loops without a key fall back to the id). Front-load it
	// so it survives truncation.
	const handle = loop.loopKey || loop.id;
	const idStr = opts.includeId ? `[id=${handle}] ` : '';
	// Liveness nudge: when a still-open loop is within `warnWithin` passes of its
	// effective auto-drop threshold, flag it so the extractor either reaffirms
	// (keepOpenLoops) or closes it this turn rather than letting it silently age
	// out. Effective threshold mirrors applyOpenLoopLivenessProjection:
	// baseThreshold + max(0, priority). Front-loaded for the same reason as the id.
	let warnStr = '';
	if (opts.expiry && opts.expiry.baseThreshold > 0 && loop.status === 'open') {
		const warnWithin = opts.expiry.warnWithin ?? 2;
		const effectiveThreshold = opts.expiry.baseThreshold + Math.max(0, loop.priority);
		const remaining = effectiveThreshold - loop.idleTurns;
		if (remaining > 0 && remaining <= warnWithin) {
			warnStr = `[expires in ${remaining} pass${remaining === 1 ? '' : 'es'} unless kept] `;
		}
	}
	return `- ${idStr}${warnStr}(${loop.loopType}, p${loop.priority}) ${loop.title}${status}${desc}${relatedStr}`;
}

function eventLine(
	event: memoryRepo.MemoryEvent,
	keyOf: (id: string | null) => string | null,
	includeId = false
): string {
	const actor = keyOf(event.actorEntityId);
	const target = keyOf(event.targetEntityId);
	const who = [actor, target].filter(Boolean).join(' -> ');
	const whoStr = who ? ` [${who}]` : '';
	const meta: string[] = [];
	if (event.visibility && event.visibility !== 'session') meta.push(event.visibility);
	if (event.confidence < 1) meta.push(`conf ${event.confidence}`);
	const metaStr = meta.length ? ` (${meta.join(', ')})` : '';
	const idStr = includeId ? ` [id=${event.id}]` : '';
	return `- ${event.eventType}: ${cleanSentence(event.summary)}${whoStr}${metaStr}${idStr}`;
}

/**
 * Options controlling how a packet is rendered for its audience. The two
 * audiences differ deliberately: the main-turn agent gets a clean, id-free view
 * (internal handles are noise it can't act on), while the post-turn extractor
 * opts into stable handles and liveness hints so it can reference, keep, and
 * close items precisely. Making this one explicit options object — rather than
 * the previous lone `includeOpenLoopIds` boolean — keeps the agent/extractor
 * split a single, self-documenting decision instead of per-primitive guesswork.
 */
export interface RenderMemoryPacketOptions {
	/**
	 * Surface stable `[id=…]` handles on every primitive (entities, facts,
	 * decisions, events, open loops) so a downstream writer can reference items
	 * precisely. The main-turn agent omits these; the extractor enables them.
	 * Note that only open loops are *acted on* by id (keepOpenLoops/closeLoops);
	 * facts self-supersede by re-asserting the same entityKey+predicate.
	 */
	includeIds?: boolean;
	/**
	 * When set, annotate open loops nearing auto-drop with an `[expires in N …]`
	 * hint, nudging the extractor to keep or close them before they age out.
	 * `baseThreshold` mirrors `MEMORY_OPEN_LOOP_MAX_IDLE_TURNS`; a loop is flagged
	 * when it is within `warnWithin` (default 2) passes of its effective
	 * threshold. Omit to render no liveness hints.
	 */
	openLoopExpiry?: { baseThreshold: number; warnWithin?: number };
}

/**
 * Render a memory packet as compact, human-readable text instead of a raw
 * pretty-printed JSON blob. This strips structural noise (internal ids,
 * timestamps, null source pointers, indentation) that bloats the model context
 * while preserving every semantically useful field — including the entityKey
 * values downstream consumers must reuse.
 */
export function renderMemoryPacket(
	packet: TurnMemoryPacket,
	options: RenderMemoryPacketOptions = {}
): string {
	const includeIds = options.includeIds ?? false;
	const keyOf = (id: string | null): string | null =>
		id ? (packet.entityKeyById[id] ?? null) : null;

	const lines: string[] = [];
	lines.push(`mode: ${packet.mode}`);
	lines.push(`summary: ${packet.summary}`);
	if (packet.relevanceQuery) {
		lines.push('selection: relevance-ranked for the current turn');
	}
	if (packet.instructions) {
		lines.push('', 'instructions:', packet.instructions.trim());
	}

	// Per-session directives (standing rules) render verbatim in their own
	// always-on block ahead of the budgeted body, so the model reliably obeys
	// every active standing instruction for the rest of the conversation.
	if (packet.directives.length) {
		lines.push('', `standing directives (${packet.directives.length}) — always in effect:`);
		for (const directive of packet.directives) {
			lines.push(`- ${cleanSentence(formatMemoryValue(directive.value))}`);
		}
		if (packet.directives.length >= MAX_DIRECTIVES) {
			lines.push(
				`(showing the ${MAX_DIRECTIVES} most recent standing directives; older ones may be omitted)`
			);
		}
	}

	// Group facts beneath their owning entity so memory injects as coherent
	// per-entity blocks ("character.mara: { location = ..., mood = ... }")
	// rather than a flat list of "entityKey.predicate = value" lines.
	const entityById = new Map(packet.entities.map((entity) => [entity.id, entity]));
	const indexById = new Map(packet.entityIndex.map((entry) => [entry.entityId, entry]));
	const factsByEntity = new Map<string, memoryRepo.MemoryFact[]>();
	const detachedFacts: memoryRepo.MemoryFact[] = [];
	const blockOrder: string[] = [];
	for (const fact of packet.facts) {
		// Directives are rendered in their own always-on block above; never group
		// them under an entity here even if one slipped into packet.facts.
		if (isDirectivePredicate(fact.predicate)) continue;
		if (!fact.entityId) {
			detachedFacts.push(fact);
			continue;
		}
		let group = factsByEntity.get(fact.entityId);
		if (!group) {
			group = [];
			factsByEntity.set(fact.entityId, group);
			blockOrder.push(fact.entityId);
		}
		group.push(fact);
	}
	// Entities that earned a summary slot but have no facts in this packet still
	// get a header so their description is not lost.
	for (const entity of packet.entities) {
		if (!factsByEntity.has(entity.id)) blockOrder.push(entity.id);
	}

	const entityHeader = (id: string): string => {
		const entity = entityById.get(id);
		if (entity) return entityLine(entity, includeIds);
		const entry = indexById.get(id);
		if (entry) {
			const status = entry.status && entry.status !== 'active' ? ` [${entry.status}]` : '';
			const idStr = includeIds ? ` [id=${entry.entityId}]` : '';
			return `- ${entry.entityKey} (${entry.entityType}) "${entry.displayName}"${status}${idStr}`;
		}
		const key = keyOf(id);
		return `- ${key ?? id}`;
	};

	if (blockOrder.length || detachedFacts.length) {
		const total = blockOrder.length + (detachedFacts.length ? 1 : 0);
		lines.push('', `entities & facts (${total}):`);
		for (const id of blockOrder) {
			lines.push(entityHeader(id));
			for (const fact of factsByEntity.get(id) ?? [])
				lines.push(`    ${factDetail(fact, includeIds)}`);
		}
		if (detachedFacts.length) {
			lines.push('- (session-scoped):');
			for (const fact of detachedFacts) lines.push(`    ${factDetail(fact, includeIds)}`);
		}
	}

	if (packet.entityIndex.length) {
		lines.push('', `entity index (${packet.entityIndex.length}) — queryable by name:`);
		for (const entry of packet.entityIndex) lines.push(entityIndexLine(entry, includeIds));
	}

	if (packet.decisions.length) {
		lines.push('', `decisions (${packet.decisions.length}):`);
		for (const decision of packet.decisions) lines.push(decisionLine(decision, includeIds));
	}

	if (packet.openLoops.length) {
		lines.push('', `open loops (${packet.openLoops.length}):`);
		for (const loop of packet.openLoops)
			lines.push(loopLine(loop, keyOf, { includeId: includeIds, expiry: options.openLoopExpiry }));
	}

	if (packet.recentEvents.length) {
		lines.push('', `recent events (${packet.recentEvents.length}):`);
		for (const event of packet.recentEvents) lines.push(eventLine(event, keyOf, includeIds));
	}

	if (packet.autoSearchHits.length) {
		lines.push('', `auto-retrieved for this turn (${packet.autoSearchHits.length}):`);
		for (const hit of packet.autoSearchHits) {
			lines.push(`- [${hit.itemType}] ${cleanSentence(hit.text)}`);
		}
	}

	const guidance = packet.toolGuidance;
	lines.push('', 'memory tools:');
	lines.push(
		`- ${guidance.mandatory ? 'mandatory' : 'optional'} recall via: ${guidance.availableTools.join(', ')}`
	);
	lines.push(`- recall when: ${guidance.recallTriggers.join('; ')}`);

	return lines.join('\n');
}

function summarizePatch(patch: MemoryPatchProposal): string {
	return [
		patch.entities?.length ? `${patch.entities.length} entities` : '',
		patch.events?.length ? `${patch.events.length} events` : '',
		patch.facts?.length ? `${patch.facts.length} facts` : '',
		patch.decisions?.length ? `${patch.decisions.length} decisions` : '',
		patch.openLoops?.length ? `${patch.openLoops.length} open loops` : '',
		patch.resolveOpenLoops?.length ? `${patch.resolveOpenLoops.length} resolved loops` : ''
	]
		.filter(Boolean)
		.join(', ');
}

function collectEntityKeys(patch: MemoryPatchProposal): Set<string> {
	const keys = new Set<string>();
	for (const entity of patch.entities ?? []) keys.add(entity.entityKey);
	for (const event of patch.events ?? []) if (event.entityKey) keys.add(event.entityKey);
	for (const fact of patch.facts ?? []) if (fact.entityKey) keys.add(fact.entityKey);
	for (const loop of patch.openLoops ?? []) {
		for (const key of loop.relatedEntityKeys ?? []) keys.add(key);
	}
	return keys;
}

function recentTranscript(conversationId: string, userMessageId: string, limit: number): string {
	const transcript = messages.listByConversation(conversationId);
	const targetIdx = transcript.findIndex((message) => message.id === userMessageId);
	const prior = transcript
		.slice(Math.max(0, targetIdx - limit), targetIdx)
		.filter((message) => message.status === 'complete' && message.content.trim())
		.map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
		.join('\n\n');
	return prior;
}

function cleanSentence(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}
