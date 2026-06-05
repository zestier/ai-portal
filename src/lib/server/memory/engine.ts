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
	const factPool = memoryRepo.listFacts(conversationId, { limit: strict ? 400 : 200 });
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
		summary: summarizePacket({ entities, facts, decisions, openLoops, recentEvents }),
		entities,
		facts,
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
				'memory_propose_patch',
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
		? 'A dedicated memory extractor reviews every turn after you respond and records durable memory on your behalf. Do not call memory_propose_patch yourself: writing patches directly duplicates the extractor, blurs responsibilities, and makes a mess of the memory store. Concentrate on answering well and let the extractor capture what to remember. Only use memory_propose_patch if you must correct a specific, concrete memory error.'
		: 'If you make durable decisions, create tasks/open loops, establish story facts, or change important state, call memory_propose_patch with a structured patch before the final answer when practical.';
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
		const row = memoryRepo.addFact(input.conversationId, {
			entityId,
			predicate: fact.predicate,
			value: fact.value,
			visibility: fact.visibility,
			confidence: fact.confidence,
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

	return {
		patch: patchRecord,
		counts: {
			entities: input.patch.entities?.length ?? 0,
			events: eventCount,
			facts: factCount,
			decisions: input.patch.decisions?.length ?? 0,
			openLoops: input.patch.openLoops?.length ?? 0,
			issues: validation.issues.length
		}
	};
}

export function extractHeuristicPatch(params: {
	userMsg: Message;
	assistantContent: string;
	mode: MemoryMode;
}): MemoryPatchProposal {
	const combined = `${params.userMsg.content}\n\n${params.assistantContent}`.trim();
	const patch: MemoryPatchProposal = { events: [], facts: [], decisions: [], openLoops: [] };
	if (!combined) return patch;

	const decisionMatch = combined.match(
		/\b(?:decided|decision|we will|we should|use|choose)\b[:\s]+(.{12,240})/i
	);
	if (decisionMatch) {
		patch.decisions?.push({
			subject: 'session_decision',
			decision: cleanSentence(decisionMatch[1]),
			rationale: 'Heuristically extracted from the turn.'
		});
	}

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

export const MemoryPatchProposalSchema: z.ZodType<MemoryPatchProposal> = z
	.object({
		entities: z
			.array(
				z.object({
					entityKey: z.string().min(1).max(200),
					entityType: z.string().min(1).max(80),
					displayName: z.string().min(1).max(200),
					summary: z.string().max(4000).optional(),
					metadata: z.unknown().optional()
				})
			)
			.max(50)
			.optional(),
		events: z
			.array(
				z.object({
					eventType: z.string().min(1).max(100),
					summary: z.string().min(1).max(4000),
					payload: z.unknown().optional(),
					visibility: z.string().min(1).max(100).optional(),
					confidence: z.number().min(0).max(1).optional(),
					entityKey: z.string().min(1).max(200).optional()
				})
			)
			.max(100)
			.optional(),
		facts: z
			.array(
				z.object({
					entityKey: z.string().min(1).max(200).optional(),
					predicate: z.string().min(1).max(100),
					value: z.custom<unknown>((value) => value !== undefined, {
						message: 'value is required'
					}),
					visibility: z.string().min(1).max(100).optional(),
					confidence: z.number().min(0).max(1).optional()
				})
			)
			.max(100)
			.optional(),
		decisions: z
			.array(
				z.object({
					subject: z.string().min(1).max(200),
					decision: z.string().min(1).max(4000),
					rationale: z.string().max(4000).optional()
				})
			)
			.max(50)
			.optional(),
		openLoops: z
			.array(
				z.object({
					loopType: z.string().min(1).max(100),
					title: z.string().min(1).max(200),
					description: z.string().max(8000).optional(),
					priority: z.number().int().min(-100).max(100).optional(),
					relatedEntityKeys: z.array(z.string().min(1).max(200)).max(50).optional()
				})
			)
			.max(50)
			.optional()
	})
	.strict();

function memoryInstructions(mode: MemoryMode): string {
	return getMemoryProfile(mode).instructions;
}

function summarizePacket(packet: {
	entities: memoryRepo.MemoryEntity[];
	facts: memoryRepo.MemoryFact[];
	decisions: memoryRepo.MemoryDecision[];
	openLoops: memoryRepo.MemoryOpenLoop[];
	recentEvents: memoryRepo.MemoryEvent[];
}): string {
	return [
		`${packet.entities.length} entities`,
		`${packet.facts.length} active facts`,
		`${packet.decisions.length} decisions`,
		`${packet.openLoops.length} open loops`,
		`${packet.recentEvents.length} recent events`
	].join(', ');
}

function formatMemoryValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined) return 'null';
	return JSON.stringify(value);
}

function entityLine(entity: memoryRepo.MemoryEntity): string {
	const status = entity.status && entity.status !== 'active' ? ` [${entity.status}]` : '';
	const summary = entity.summary ? ` — ${cleanSentence(entity.summary)}` : '';
	return `- ${entity.entityKey} (${entity.entityType}) "${entity.displayName}"${status}${summary}`;
}

function entityIndexLine(entry: MemoryEntityIndexEntry): string {
	const status = entry.status && entry.status !== 'active' ? ` [${entry.status}]` : '';
	const facts = entry.factCount ? ` (${entry.factCount} facts)` : '';
	return `- ${entry.entityKey} (${entry.entityType})${status}${facts}`;
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
function factDetail(fact: memoryRepo.MemoryFact): string {
	const meta: string[] = [];
	if (fact.pinned) meta.push('pinned');
	if (fact.visibility && fact.visibility !== 'session') meta.push(fact.visibility);
	if (fact.confidence < 1) meta.push(`conf ${fact.confidence}`);
	if (fact.status && fact.status !== 'active') meta.push(fact.status);
	const metaStr = meta.length ? ` (${meta.join(', ')})` : '';
	return `${fact.predicate} = ${formatMemoryValue(fact.value)}${metaStr}`;
}

function decisionLine(decision: memoryRepo.MemoryDecision): string {
	const status = decision.status && decision.status !== 'active' ? ` [${decision.status}]` : '';
	const rationale = decision.rationale ? ` — ${cleanSentence(decision.rationale)}` : '';
	return `- ${decision.subject}: ${decision.decision}${status}${rationale}`;
}

function loopLine(
	loop: memoryRepo.MemoryOpenLoop,
	keyOf: (id: string | null) => string | null
): string {
	const related = loop.relatedEntityIds
		.map((id) => keyOf(id))
		.filter((key): key is string => Boolean(key));
	const relatedStr = related.length ? ` [related: ${related.join(', ')}]` : '';
	const status = loop.status && loop.status !== 'open' ? ` [${loop.status}]` : '';
	const desc = loop.description ? ` — ${cleanSentence(loop.description)}` : '';
	return `- (${loop.loopType}, p${loop.priority}) ${loop.title}${status}${desc}${relatedStr}`;
}

function eventLine(
	event: memoryRepo.MemoryEvent,
	keyOf: (id: string | null) => string | null
): string {
	const actor = keyOf(event.actorEntityId);
	const target = keyOf(event.targetEntityId);
	const who = [actor, target].filter(Boolean).join(' -> ');
	const whoStr = who ? ` [${who}]` : '';
	const meta: string[] = [];
	if (event.visibility && event.visibility !== 'session') meta.push(event.visibility);
	if (event.confidence < 1) meta.push(`conf ${event.confidence}`);
	const metaStr = meta.length ? ` (${meta.join(', ')})` : '';
	return `- ${event.eventType}: ${cleanSentence(event.summary)}${whoStr}${metaStr}`;
}

/**
 * Render a memory packet as compact, human-readable text instead of a raw
 * pretty-printed JSON blob. This strips structural noise (internal ids,
 * timestamps, null source pointers, indentation) that bloats the model context
 * while preserving every semantically useful field — including the entityKey
 * values downstream consumers must reuse.
 */
export function renderMemoryPacket(packet: TurnMemoryPacket): string {
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

	// Group facts beneath their owning entity so memory injects as coherent
	// per-entity blocks ("character.mara: { location = ..., mood = ... }")
	// rather than a flat list of "entityKey.predicate = value" lines.
	const entityById = new Map(packet.entities.map((entity) => [entity.id, entity]));
	const indexById = new Map(packet.entityIndex.map((entry) => [entry.entityId, entry]));
	const factsByEntity = new Map<string, memoryRepo.MemoryFact[]>();
	const detachedFacts: memoryRepo.MemoryFact[] = [];
	const blockOrder: string[] = [];
	for (const fact of packet.facts) {
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
		if (entity) return entityLine(entity);
		const entry = indexById.get(id);
		if (entry) {
			const status = entry.status && entry.status !== 'active' ? ` [${entry.status}]` : '';
			return `- ${entry.entityKey} (${entry.entityType}) "${entry.displayName}"${status}`;
		}
		const key = keyOf(id);
		return `- ${key ?? id}`;
	};

	if (blockOrder.length || detachedFacts.length) {
		const total = blockOrder.length + (detachedFacts.length ? 1 : 0);
		lines.push('', `entities & facts (${total}):`);
		for (const id of blockOrder) {
			lines.push(entityHeader(id));
			for (const fact of factsByEntity.get(id) ?? []) lines.push(`    ${factDetail(fact)}`);
		}
		if (detachedFacts.length) {
			lines.push('- (session-scoped):');
			for (const fact of detachedFacts) lines.push(`    ${factDetail(fact)}`);
		}
	}

	if (packet.entityIndex.length) {
		lines.push('', `entity index (${packet.entityIndex.length}) — queryable by name:`);
		for (const entry of packet.entityIndex) lines.push(entityIndexLine(entry));
	}

	if (packet.decisions.length) {
		lines.push('', `decisions (${packet.decisions.length}):`);
		for (const decision of packet.decisions) lines.push(decisionLine(decision));
	}

	if (packet.openLoops.length) {
		lines.push('', `open loops (${packet.openLoops.length}):`);
		for (const loop of packet.openLoops) lines.push(loopLine(loop, keyOf));
	}

	if (packet.recentEvents.length) {
		lines.push('', `recent events (${packet.recentEvents.length}):`);
		for (const event of packet.recentEvents) lines.push(eventLine(event, keyOf));
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
		patch.openLoops?.length ? `${patch.openLoops.length} open loops` : ''
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
