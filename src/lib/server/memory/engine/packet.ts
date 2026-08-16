import { conversationId as convCodec, memoryFactId } from '$lib/ids';
import * as memoryRepo from '$lib/server/db/repos/memory';
import type { MemoryMode, Message } from '$lib/types';
import type {
	BuildInitialPacketOptions,
	MemoryAutoSearchHit,
	MemoryEntityIndexEntry,
	TurnMemoryPacket
} from './types';
import {
	entityLine,
	eventLine,
	factLine,
	formatMemoryValue,
	memoryInstructions,
	renderMemoryPacket,
	summarizePacket
} from './render';
import { recentTranscript } from './recent';

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

/**
 * Token budget for the always-on standing-directives block. Directives bypass
 * the variable-body token budget, so the raw char/count caps alone (50 rules ×
 * 4000 chars) let a CJK-heavy set quietly blow the context window. This bounds
 * their cumulative *token* cost; sized to the largest packet body budget so the
 * always-on header can never dwarf the budgeted body. The newest directives win.
 */
export const DIRECTIVE_TOKEN_BUDGET = 2000;

export function isDirectivePredicate(predicate: string): boolean {
	return predicate.trim().toLowerCase() === DIRECTIVE_PREDICATE;
}

/**
 * Resolve a forget target — supplied either as a `factId` (the packet `[id=...]`
 * handle) or, for attributes, as `entityKey` + `predicate` — to the single
 * ACTIVE fact it names, reporting whether that fact is a directive. Returns null
 * when nothing active resolves (a stale handle, a hallucinated id, or an
 * entity/predicate with no active fact), so both `validatePatch` and the forget
 * tools surface an explicit miss instead of silently committing a no-op.
 *
 * `factId` takes precedence: it is unambiguous and the only selector directives
 * accept (they share the reserved `directive` predicate and have no per-entity
 * key). The `entityKey` + `predicate` path is attribute-only in practice — a
 * directive's predicate is `directive` on the session entity — and the caller
 * (memory_forget_attribute) additionally refuses a directive hit via `isDirective`.
 */
export function resolveForgetTarget(
	conversationId: string | number,
	target: {
		factId?: string | number | undefined;
		entityKey?: string | undefined;
		predicate?: string | undefined;
	}
): { factId: number; isDirective: boolean } | null {
	if (target.factId) {
		// The packet renders fact handles as `[id=F7]`; tolerate both that and a
		// raw int (older model output / tests).
		const factId =
			typeof target.factId === 'number'
				? target.factId
				: (memoryFactId.tryParse(target.factId) ?? Number(target.factId));
		if (!Number.isInteger(factId) || factId <= 0) return null; // stale/hallucinated handle
		const fact = memoryRepo.getFact(conversationId, factId);
		if (!fact || fact.status !== 'active') return null;
		return {
			factId: memoryFactId.parse(fact.id),
			isDirective: isDirectivePredicate(fact.predicate)
		};
	}
	if (target.entityKey && target.predicate) {
		const entity = memoryRepo.getEntity(conversationId, target.entityKey);
		if (!entity) return null;
		const fact = memoryRepo
			.listFacts(conversationId, {
				entityId: entity.id,
				predicate: target.predicate,
				status: 'active',
				limit: 1
			})
			.at(0);
		if (!fact) return null;
		return {
			factId: memoryFactId.parse(fact.id),
			isDirective: isDirectivePredicate(fact.predicate)
		};
	}
	return null;
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
export const SESSION_ENTITY_KEY = 'session.context';

/**
 * Derive a sensible entityType and human display name from a namespaced entity
 * key like `character.mara` or `object.attic_key`. Used when a fact references
 * a key that has no entity yet, so we can mint one rather than drop the link.
 */
export function deriveEntityFromKey(key: string): { entityType: string; displayName: string } {
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
	// UTF-16 length / 4 assumes ASCII English (~4 chars/token) and badly
	// underestimates multibyte text: CJK chars are ~1 UTF-16 unit but cost 1-2
	// tokens, so length-based estimates run 2-4x low and can silently blow the
	// budget. UTF-8 byte length tracks token cost far more closely across scripts.
	return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
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
	conversationId: string | number,
	mode: MemoryMode,
	opts: BuildInitialPacketOptions = {}
): TurnMemoryPacket {
	const intConv =
		typeof conversationId === 'number' ? conversationId : convCodec.parse(conversationId);
	const strict = mode === 'strict';
	const query = (opts.query ?? '').trim();
	const budget = opts.tokenBudget ?? packetTokenBudget(mode);

	const entityPool = memoryRepo.listEntities(intConv, { limit: 500 });
	const allFacts = memoryRepo.listFacts(intConv, { limit: strict ? 400 : 200 });
	// Directives are loaded in full (up to a safety cap) and held apart so every
	// active standing rule is always injected, regardless of how many other facts
	// exist or where they fall in the relevance-ranked fact pool. listFacts orders
	// by updated_at DESC, so capping the load keeps the most recently asserted
	// directives if a pathological conversation exceeds MAX_DIRECTIVES.
	const loadedDirectives = memoryRepo.listFacts(intConv, {
		predicate: DIRECTIVE_PREDICATE,
		limit: MAX_DIRECTIVES
	});
	// Directives bypass the variable-body token budget, so apply a real token
	// budget here too — a count/char cap alone lets multibyte rules overflow the
	// context window. listFacts orders by updated_at DESC, so accumulating in load
	// order keeps the most recently asserted directives and drops older ones once
	// the budget is spent. Always keep at least one so a lone oversized rule shows.
	const budgetedDirectives: memoryRepo.MemoryFact[] = [];
	let directiveTokens = 0;
	for (const directive of loadedDirectives) {
		const cost = estimateTokens(formatMemoryValue(directive.value));
		if (budgetedDirectives.length && directiveTokens + cost > DIRECTIVE_TOKEN_BUDGET) break;
		budgetedDirectives.push(directive);
		directiveTokens += cost;
	}
	const directives = budgetedDirectives.sort(
		(a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)
	);
	const factPool = allFacts.filter((fact) => !isDirectivePredicate(fact.predicate));
	const eventPool = memoryRepo.listEvents(intConv, { limit: strict ? 200 : 100 });
	const openLoops = memoryRepo.listOpenLoops(intConv, { limit: strict ? 80 : 40 });

	const entityKeyById: Record<string, string> = {};
	for (const entity of entityPool) entityKeyById[entity.id] = entity.entityKey;
	const keyOf = (id: string | null): string | null => (id ? (entityKeyById[id] ?? null) : null);
	const factCounts = memoryRepo.entityFactCounts(intConv);

	// One search per turn powers both relevance ranking and the auto-search
	// section: scores rank the pools, the top hits are injected verbatim.
	const searchHits = query
		? memoryRepo.search(intConv, { query, limit: Math.max(AUTO_SEARCH_LIMIT, 300) })
		: [];
	const scores = new Map<string | number, number>();
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

	// Open loops are cheap, high-value continuity: always pinned.
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
		summary: summarizePacket({ entities, facts, openLoops, recentEvents, directives }),
		entities,
		facts,
		directives,
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
				'memory_get_transcript',
				'memory_query_timeline',
				'memory_query_clues',
				'memory_get_character_knowledge',
				'memory_check_claims',
				...(opts.globalMemoryEnabled ? ['memory_global_record', 'memory_global_search'] : [])
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

// A packet is "empty" when none of the durable primitives surfaced anything for
// this turn — including the always-present entity index and the per-turn
// auto-search hits, so a populated store with a non-matching query still counts
// as non-empty via its index.
function isPacketEmpty(packet: TurnMemoryPacket): boolean {
	return (
		packet.entities.length === 0 &&
		packet.facts.length === 0 &&
		packet.directives.length === 0 &&
		packet.openLoops.length === 0 &&
		packet.recentEvents.length === 0 &&
		packet.entityIndex.length === 0 &&
		packet.autoSearchHits.length === 0
	);
}

export function buildPromptWithMemory(params: {
	conversationId: string | number;
	mode: MemoryMode;
	userMsg: Message;
	userId?: number | undefined;
	includeRecentTranscript?: boolean | undefined;
	globalMemoryEnabled?: boolean | undefined;
	extractorPresent?: boolean | undefined;
}): string {
	const intConv =
		typeof params.conversationId === 'number'
			? params.conversationId
			: convCodec.parse(params.conversationId);
	const recent = params.includeRecentTranscript
		? recentTranscript(intConv, params.userMsg.id, 6)
		: '';
	// Condition selection (and the auto-search prestep) on the current turn.
	const query = [params.userMsg.content, recent].filter(Boolean).join('\n').trim();
	const packet = buildInitialPacket(intConv, params.mode, {
		globalMemoryEnabled: params.globalMemoryEnabled,
		query
	});

	// When there is nothing durable to surface, skip the entire memory framing.
	// An empty packet paired with "mandatory recall via …" guidance just nudges
	// the model to fire a recall tool against an empty store and end the turn
	// (the classic first-turn "tool call then nothing" behavior). The post-turn
	// extractor still runs regardless, so memory bootstraps from this same turn.
	// Global memory is cross-conversation, so only short-circuit when it is off
	// or genuinely empty; when we lack the userId to check, stay conservative.
	const hasGlobalMemory =
		params.globalMemoryEnabled === true &&
		(params.userId ? memoryRepo.listGlobalMemories(params.userId, { limit: 1 }).length > 0 : true);
	if (isPacketEmpty(packet) && !hasGlobalMemory) {
		return [
			recent ? `<recent_transcript>\n${recent}\n</recent_transcript>\n` : '',
			'Final user message:',
			params.userMsg.content
		]
			.filter(Boolean)
			.join('\n');
	}

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
		"The packet lists every entity you can query by name (detailed entries plus the compact 'also on record' remainder) even when an entity's details were not injected. The auto-retrieved memory in the packet was already pulled by searching your current message, so a reflexive first memory_search usually returns nothing new — only query when the packet leaves a real gap.",
		'When the answer could depend on details that are missing from or only partially covered by the packet, query the memory tools (memory_search, memory_get_entity, memory_get_open_loops, memory_get_recent_events, and the others) to pull in more before you respond. Prefer querying too often over assuming; querying is cheap, inventing details is not.',
		'These memory tools are for your own recall only. Calling one is never a complete response, and the user never sees tool output directly. After any memory query you MUST continue in the same turn and give the user a substantive reply. Never end your turn immediately after a recall tool call.',
		'Do not invent older details when memory returns unknown.',
		writeGuidance,
		recent ? `\n<recent_transcript>\n${recent}\n</recent_transcript>\n` : '',
		'Final user message:',
		params.userMsg.content
	].join('\n');
}
