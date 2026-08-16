import type { MemoryMode } from '$lib/types';
import type * as memoryRepo from '$lib/server/db/repos/memory';

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
	itemId: string | number;
	text: string;
	score: number;
}

export interface TurnMemoryPacket {
	mode: MemoryMode;
	instructions: string;
	summary: string;
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
	entities?:
		| Array<{
				entityKey: string;
				entityType?: string | undefined;
				displayName?: string | undefined;
				summary?: string | undefined;
				metadata?: unknown;
		  }>
		| undefined;
	events?:
		| Array<{
				eventType: string;
				summary: string;
				payload?: unknown;
				visibility?: string | undefined;
				confidence?: number | undefined;
				entityKey?: string | undefined;
		  }>
		| undefined;
	facts?:
		| Array<{
				entityKey?: string | undefined;
				predicate: string;
				value?: unknown;
				visibility?: string | undefined;
				confidence?: number | undefined;
		  }>
		| undefined;
	openLoops?:
		| Array<{
				loopType: string;
				title: string;
				description?: string | undefined;
				priority?: number | undefined;
				relatedEntityKeys?: string[] | undefined;
		  }>
		| undefined;
	/**
	 * Resolutions for *existing* open loops the latest turn closed, answered, or
	 * abandoned — e.g. the user picked one of several offered options, so the
	 * unchosen ones should be dropped rather than left lingering. Without this
	 * the extraction pipeline is append-only and superseded loops accumulate,
	 * crowding the packet budget. `id` is an existing open-loop id (retrieve via
	 * memory_get_open_loops); `resolved` = completed/answered, `dropped` =
	 * abandoned/superseded.
	 */
	resolveOpenLoops?:
		| Array<{
				id: string | number;
				status: 'resolved' | 'dropped';
				reason?: string | undefined;
		  }>
		| undefined;
	/**
	 * Ids of existing open loops the extractor is explicitly keeping alive this
	 * turn. Not a commit action — `commitPatch` ignores it. It feeds open-loop
	 * liveness (see {@link ageOpenLoops}): a loop that was presented to the
	 * extractor but appears in neither `keepOpenLoops` nor `resolveOpenLoops`
	 * accrues idle turns and is eventually auto-dropped, so dead threads stop
	 * accumulating without the model having to notice their absence.
	 */
	keepOpenLoops?: Array<string | number> | undefined;
	/**
	 * Explicit retirements of existing *facts* (attributes or directives) the
	 * extractor decided are stale and have no natural supersede — e.g. after
	 * breaking a compound attribute (`description="tall, red hair, fears water"`)
	 * into granular facts under new predicates, the original compound predicate is
	 * never superseded, so it is forgotten directly; or a trait/rule the user
	 * explicitly retracted with no replacement. Each target resolves to one active
	 * fact, either by its `factId` (the `[id=...]` handle) or, for attributes, by
	 * `entityKey` + `predicate`. Commit tombstones the fact (`status='deleted'`)
	 * and records a `forget` patch item, so the retirement is auditable and
	 * visible in the inspector (and reviewable per item). Prefer supersede (re-assert same entityKey +
	 * predicate) whenever the predicate is unchanged; forgetting is for the cases
	 * supersede cannot reach.
	 */
	forgetFacts?:
		| Array<{
				factId?: string | number | undefined;
				entityKey?: string | undefined;
				predicate?: string | undefined;
		  }>
		| undefined;
}

export interface CommitMemoryPatchInput {
	conversationId: string | number;
	mode?: MemoryMode | undefined;
	turnId?: string | null | undefined;
	sourceMessageId?: string | number | null | undefined;
	patch: MemoryPatchProposal;
	summary?: string | undefined;
	/**
	 * Optional hook invoked exactly once, only when the patch validates and is
	 * about to be applied — after the (failed) early return for a `needs_review`
	 * patch, but before any durable items are written. The retry path uses it to
	 * undo the prior turn's patch only once a replacement is guaranteed to
	 * land, so a `needs_review` (or otherwise non-committing) retry never
	 * destroys the existing committed memory. Running it here — immediately before
	 * applying the new items — also keeps entity-key reuse on clean pre-turn
	 * state, avoiding double-counting.
	 */
	beforeCommit?: (() => void) | undefined;
}

export interface BuildInitialPacketOptions {
	globalMemoryEnabled?: boolean | undefined;
	/** Current turn text (user message + recent transcript) used to relevance-rank. */
	query?: string | undefined;
	/** Token budget for the variable portion of the packet. */
	tokenBudget?: number | undefined;
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
	/**
	 * Append the live-session `memory tools:` recall-guidance block (the
	 * `mandatory/optional recall via: …` + `recall when: …` lines derived from
	 * `packet.toolGuidance`). Defaults to true for the live agent, which acts on
	 * that guidance. The background extractor sets this false: it carries its own
	 * tool vocabulary (the `remember_*` write tools plus the recall tools) in its
	 * system prompt, and embedding the live agent's recall-only tool list in the
	 * extractor's turn data is both redundant and misleading — it names recall
	 * tools but not the write tools the extractor must call, which has prompted
	 * models to hallucinate hybrids like `memory_attributes`.
	 */
	includeToolGuidance?: boolean;
}

export interface AgeOpenLoopsResult {
	/** Ids of loops auto-dropped this turn because they aged out. */
	dropped: number[];
}
