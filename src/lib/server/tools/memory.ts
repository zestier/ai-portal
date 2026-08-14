import { z } from 'zod';
import { memoryEntityId, memoryFactId, messageId as msgCodec } from '$lib/ids';
import * as memoryRepo from '../db/repos/memory';
import * as messagesRepo from '../db/repos/messages';
import { buildInitialPacket, renderMemoryPacket } from '../memory/engine';
import type { MemoryMode } from '$lib/types';
import { ok, type PortalTool } from './types';
import {
	project,
	combineOmitted,
	withOmitted,
	assertFieldsKnown,
	type FieldSelector,
	FieldsArg,
	FIELDS_PARAM,
	FIELDS_NOTE
} from './project';

// Per-shape allowlists of model-relevant fields. Everything else (provenance
// ids, timestamps, raw payloads, confidence/visibility, etc.) is dropped from
// the compact-by-default result; pass `fields` with specific names to
// recover more.
const ENTITY_KEEP = ['id', 'entityKey', 'entityType', 'displayName', 'summary', 'status'] as const;
const EVENT_KEEP = [
	'id',
	'eventType',
	'occurredAt',
	'actorEntityId',
	'targetEntityId',
	'summary'
] as const;
const FACT_KEEP = ['id', 'entityId', 'predicate', 'value', 'status'] as const;
const OPEN_LOOP_KEEP = [
	'id',
	'loopKey',
	'loopType',
	'title',
	'description',
	'status',
	'priority'
] as const;
const SEARCH_HIT_KEEP = ['itemType', 'itemId', 'text'] as const;
const MESSAGE_KEEP = ['id', 'role', 'content'] as const;
const GLOBAL_MEMORY_KEEP = ['id', 'kind', 'memoryKey', 'value', 'status'] as const;

function projectOptions<K extends readonly string[]>(
	fields: FieldSelector | string | string[] | undefined,
	keep: K,
	validate?: boolean
): { keep: K; fields?: FieldSelector | string; validate?: boolean } {
	return {
		keep,
		...(fields !== undefined ? { fields } : {}),
		...(validate !== undefined ? { validate } : {})
	};
}

const SearchArgs = z.object({
	query: z.string().trim().min(1).max(500),
	types: z
		.array(z.enum(['entity', 'event', 'fact', 'open_loop']))
		.max(5)
		.optional(),
	limit: z.number().int().min(1).max(50).optional().default(20),
	fields: FieldsArg
});

const EntityArgs = z.object({
	id: z.string().trim().min(1).max(200),
	fields: FieldsArg
});

const OpenLoopsArgs = z
	.object({
		loopType: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(50).optional().default(20),
		fields: FieldsArg
	})
	.optional()
	.default({});

const RecentEventsArgs = z
	.object({
		entityId: z.string().trim().min(1).max(200).optional(),
		eventType: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(50).optional().default(20),
		fields: FieldsArg
	})
	.optional()
	.default({});

const TranscriptLookupArgs = z.object({
	query: z.string().trim().min(1).max(500),
	limit: z.number().int().min(1).max(20).optional().default(8),
	fields: FieldsArg
});

const TimelineArgs = z
	.object({
		entityId: z.string().trim().min(1).max(200).optional(),
		eventType: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(100).optional().default(50),
		fields: FieldsArg
	})
	.optional()
	.default({});

const ClueArgs = z
	.object({
		status: z.enum(['all', 'open', 'revealed', 'resolved']).optional().default('all'),
		limit: z.number().int().min(1).max(100).optional().default(50),
		fields: FieldsArg
	})
	.optional()
	.default({});

const CharacterKnowledgeArgs = z.object({
	characterEntityKey: z.string().trim().min(1).max(200),
	limit: z.number().int().min(1).max(100).optional().default(50),
	fields: FieldsArg
});

const MergeEntitiesArgs = z.object({
	from: z.string().trim().min(1).max(200),
	into: z.string().trim().min(1).max(200)
});

const GlobalRememberArgs = z.object({
	kind: z.enum(['preference', 'decision', 'fact', 'style', 'constraint']),
	key: z.string().trim().min(1).max(200),
	value: z.unknown(),
	fields: FieldsArg
});

const GlobalSearchArgs = z.object({
	query: z.string().trim().min(1).max(500),
	limit: z.number().int().min(1).max(50).optional().default(20),
	fields: FieldsArg
});

const CheckClaimsArgs = z.object({
	claims: z
		.array(
			z.object({
				entityKey: z.string().trim().min(1).max(200).optional(),
				predicate: z.string().trim().min(1).max(100),
				value: z.unknown().optional()
			})
		)
		.min(1)
		.max(50)
});

export function buildMemoryTools(opts: {
	userId: number;
	conversationId: string | number;
	getTurnId?: () => string | null;
	mode: MemoryMode;
	globalMemoryEnabled?: boolean;
}): PortalTool[] {
	if (opts.mode === 'off') return [];
	const tools: PortalTool[] = [
		{
			name: 'memory_search',
			description:
				'Search durable session memory. Mandatory when prior details are relevant but absent from the initial packet. ' +
				FIELDS_NOTE,
			argsSchema: SearchArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Text to search for in durable memory.' },
					types: {
						type: 'array',
						items: { type: 'string', enum: ['entity', 'event', 'fact', 'open_loop'] },
						description: 'Optional memory item types to include.'
					},
					limit: { type: 'number', description: 'Results 1-50, default 20.' },
					fields: FIELDS_PARAM
				},
				required: ['query'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = SearchArgs.parse(args);
				const results = memoryRepo.search(opts.conversationId, parsed);
				const summary = `${results.length} result(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_search',
					arguments: parsed,
					resultSummary: summary,
					resultIds: results.map((result) =>
						result.itemType === 'entity'
							? memoryEntityId.parse(result.itemId as string)
							: result.itemType === 'fact'
								? memoryFactId.parse(result.itemId as string)
								: (result.itemId as number)
					)
				});
				const projected = project(results, projectOptions(parsed.fields, SEARCH_HIT_KEEP));
				return ok(withOmitted({ results: projected.value }, projected.omitted), summary);
			}
		},
		{
			name: 'memory_get_entity',
			description:
				'Fetch canonical durable state for one entity by entity id or key, including active facts and recent events. ' +
				FIELDS_NOTE,
			argsSchema: EntityArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Entity id or symbolic key, e.g. character.elias.' },
					fields: FIELDS_PARAM
				},
				required: ['id'],
				additionalProperties: false
			},
			async handler(args) {
				const { id, fields } = EntityArgs.parse(args);
				const entity = memoryRepo.getEntity(opts.conversationId, id);
				if (!entity) return ok({ entity: null });
				const facts = memoryRepo.listFacts(opts.conversationId, {
					entityId: entity.id,
					limit: 100
				});
				const events = memoryRepo.listEvents(opts.conversationId, {
					entityId: entity.id,
					limit: 30
				});
				assertFieldsKnown(fields, [
					{ input: entity, keep: ENTITY_KEEP },
					{ input: facts, keep: FACT_KEEP },
					{ input: events, keep: EVENT_KEEP }
				]);
				const entityP = project(entity, projectOptions(fields, ENTITY_KEEP, false));
				const factsP = project(facts, projectOptions(fields, FACT_KEEP, false));
				const eventsP = project(events, projectOptions(fields, EVENT_KEEP, false));
				const result = withOmitted(
					{ entity: entityP.value, facts: factsP.value, events: eventsP.value },
					combineOmitted(entityP, factsP, eventsP)
				);
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_entity',
					arguments: { id },
					resultSummary: entity.displayName,
					resultIds: [memoryEntityId.parse(entity.id)]
				});
				return ok(result, entity.displayName);
			}
		},
		{
			name: 'memory_get_open_loops',
			description:
				'Fetch unresolved durable open loops: tasks, promises, plot threads, clues, questions, or commitments. ' +
				FIELDS_NOTE,
			argsSchema: OpenLoopsArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					loopType: { type: 'string', description: 'Optional loop type filter.' },
					limit: { type: 'number', description: 'Open loops 1-50, default 20.' },
					fields: FIELDS_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = OpenLoopsArgs.parse(args);
				const openLoops = memoryRepo.listOpenLoops(opts.conversationId, parsed);
				const summary = `${openLoops.length} open loop(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_open_loops',
					arguments: parsed,
					resultSummary: summary,
					resultIds: openLoops.map((loop) => loop.id)
				});
				const projected = project(openLoops, projectOptions(parsed.fields, OPEN_LOOP_KEEP));
				return ok(withOmitted({ openLoops: projected.value }, projected.omitted), summary);
			}
		},
		{
			name: 'memory_get_recent_events',
			description:
				'Fetch recent durable memory events, optionally filtered by entity or event type. ' +
				FIELDS_NOTE,
			argsSchema: RecentEventsArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					entityId: { type: 'string', description: 'Optional entity id.' },
					eventType: { type: 'string', description: 'Optional event type.' },
					limit: { type: 'number', description: 'Events 1-50, default 20.' },
					fields: FIELDS_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = RecentEventsArgs.parse(args);
				const events = memoryRepo.listEvents(opts.conversationId, {
					...parsed,
					entityId: parsed.entityId ? Number(parsed.entityId) : undefined
				});
				const summary = `${events.length} event(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_recent_events',
					arguments: parsed,
					resultSummary: summary,
					resultIds: events.map((event) => event.id)
				});
				const projected = project(events, projectOptions(parsed.fields, EVENT_KEEP));
				return ok(withOmitted({ events: projected.value }, projected.omitted), summary);
			}
		},
		{
			name: 'memory_get_transcript',
			description:
				'Search exact prior conversation wording. Use when phrasing, quotes, or an old user/assistant statement matters. ' +
				FIELDS_NOTE,
			argsSchema: TranscriptLookupArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Literal text to find in prior messages.' },
					limit: { type: 'number', description: 'Matching messages 1-20, default 8.' },
					fields: FIELDS_PARAM
				},
				required: ['query'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = TranscriptLookupArgs.parse(args);
				const matches = messagesRepo.searchConversation(opts.conversationId, parsed.query, {
					limit: parsed.limit
				});
				const summary = `${matches.length} message(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_transcript',
					arguments: parsed,
					resultSummary: summary,
					resultIds: matches.map((message) => msgCodec.parse(message.id))
				});
				const projected = project(matches, projectOptions(parsed.fields, MESSAGE_KEEP));
				return ok(withOmitted({ messages: projected.value }, projected.omitted), summary);
			}
		},
		{
			name: 'memory_query_timeline',
			description:
				'Return ordered memory events for timeline reasoning. Use in strict mode for alibis, chronology, and continuity checks. ' +
				FIELDS_NOTE,
			argsSchema: TimelineArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					entityId: { type: 'string', description: 'Optional entity id.' },
					eventType: { type: 'string', description: 'Optional event type.' },
					limit: { type: 'number', description: 'Events 1-100, default 50.' },
					fields: FIELDS_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = TimelineArgs.parse(args);
				const events = memoryRepo
					.listEvents(opts.conversationId, {
						...parsed,
						entityId: parsed.entityId ? Number(parsed.entityId) : undefined
					})
					.sort((a, b) => a.occurredAt - b.occurredAt || a.id - b.id);
				const summary = `${events.length} timeline event(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_query_timeline',
					arguments: parsed,
					resultSummary: summary,
					resultIds: events.map((event) => event.id)
				});
				const projected = project(events, projectOptions(parsed.fields, EVENT_KEEP));
				return ok(withOmitted({ events: projected.value }, projected.omitted), summary);
			}
		},
		{
			name: 'memory_query_clues',
			description:
				'Return clue-ledger records stored as open loops or facts. Use in mystery/strict sessions to preserve fair-play clues. ' +
				FIELDS_NOTE,
			argsSchema: ClueArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					status: {
						type: 'string',
						enum: ['all', 'open', 'revealed', 'resolved'],
						description: 'Clue status filter. Defaults to all.'
					},
					limit: { type: 'number', description: 'Clues 1-100, default 50.' },
					fields: FIELDS_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = ClueArgs.parse(args);
				const loops = memoryRepo
					.listOpenLoops(opts.conversationId, {
						loopType: 'clue',
						status: parsed.status,
						limit: parsed.limit
					})
					.filter((loop) => parsed.status === 'all' || loop.status === parsed.status);
				const clueFacts = memoryRepo
					.listFacts(opts.conversationId, { predicate: 'clue', limit: parsed.limit })
					.filter((fact) => parsed.status === 'all' || fact.status === parsed.status);
				const summary = `${loops.length + clueFacts.length} clue record(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_query_clues',
					arguments: parsed,
					resultSummary: summary,
					resultIds: [...loops.map((loop) => loop.id), ...clueFacts.map((fact) => memoryFactId.parse(fact.id))]
				});
				assertFieldsKnown(parsed.fields, [
					{ input: loops, keep: OPEN_LOOP_KEEP },
					{ input: clueFacts, keep: FACT_KEEP }
				]);
				const loopsP = project(loops, projectOptions(parsed.fields, OPEN_LOOP_KEEP, false));
				const factsP = project(clueFacts, projectOptions(parsed.fields, FACT_KEEP, false));
				const result = withOmitted(
					{ openLoops: loopsP.value, facts: factsP.value },
					combineOmitted(loopsP, factsP)
				);
				return ok(result, summary);
			}
		},
		{
			name: 'memory_get_character_knowledge',
			description:
				'Return facts/events describing what a character or participant knows. Use to prevent impossible knowledge leakage. ' +
				FIELDS_NOTE,
			argsSchema: CharacterKnowledgeArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					characterEntityKey: {
						type: 'string',
						description: 'Character entity key, e.g. character.elias.'
					},
					limit: { type: 'number', description: 'Records 1-100, default 50.' },
					fields: FIELDS_PARAM
				},
				required: ['characterEntityKey'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = CharacterKnowledgeArgs.parse(args);
				const entity = memoryRepo.getEntity(opts.conversationId, parsed.characterEntityKey);
				const knowledgePredicate = `knowledge:${parsed.characterEntityKey}`;
				const facts = memoryRepo.listFacts(opts.conversationId, {
					predicate: knowledgePredicate,
					limit: parsed.limit
				});
				const events = entity
					? memoryRepo.listEvents(opts.conversationId, { entityId: entity.id, limit: parsed.limit })
					: [];
				const summary = `${facts.length + events.length} knowledge record(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_character_knowledge',
					arguments: parsed,
					resultSummary: summary,
					resultIds: [...facts.map((fact) => memoryFactId.parse(fact.id)), ...events.map((event) => event.id)]
				});
				assertFieldsKnown(parsed.fields, [
					{ input: entity, keep: ENTITY_KEEP },
					{ input: facts, keep: FACT_KEEP },
					{ input: events, keep: EVENT_KEEP }
				]);
				const entityP = project(entity, projectOptions(parsed.fields, ENTITY_KEEP, false));
				const factsP = project(facts, projectOptions(parsed.fields, FACT_KEEP, false));
				const eventsP = project(events, projectOptions(parsed.fields, EVENT_KEEP, false));
				const result = withOmitted(
					{ entity: entityP.value, facts: factsP.value, events: eventsP.value },
					combineOmitted(entityP, factsP, eventsP)
				);
				return ok(result, summary);
			}
		},
		{
			name: 'memory_check_claims',
			description:
				'Check proposed claims against active durable facts; use before making continuity-sensitive claims.',
			argsSchema: CheckClaimsArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					claims: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								entityKey: { type: 'string' },
								predicate: { type: 'string' },
								value: {}
							},
							required: ['predicate'],
							additionalProperties: false
						}
					}
				},
				required: ['claims'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = CheckClaimsArgs.parse(args);
				const results = parsed.claims.map((claim) => checkClaim(opts.conversationId, claim));
				const summary = `${results.length} claim(s) checked`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_check_claims',
					arguments: parsed,
					resultSummary: summary
				});
				return ok({ results }, summary);
			}
		},
		{
			name: 'memory_merge_entities',
			description:
				"Fold a duplicate entity into a canonical one when two keys denote the same real referent. Reassigns the duplicate's facts, events, and open-loop links onto the canonical entity and retires it. Confirm with memory_get_entity first that they truly match.",
			argsSchema: MergeEntitiesArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					from: {
						type: 'string',
						description:
							'Duplicate entity to retire, by id or key, e.g. character.firstname_lastname.'
					},
					into: {
						type: 'string',
						description: 'Canonical entity to keep, by id or key, e.g. character.firstname.'
					}
				},
				required: ['from', 'into'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = MergeEntitiesArgs.parse(args);
				const result = memoryRepo.mergeEntities(opts.conversationId, {
					fromKeyOrId: parsed.from,
					intoKeyOrId: parsed.into
				});
				const summary = result.ok
					? `merged ${parsed.from} into ${parsed.into} (${result.reassignedFacts} fact(s), ${result.reassignedEvents} event(s))`
					: `not merged: ${result.error ?? 'unknown error'}`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_merge_entities',
					arguments: parsed,
					resultSummary: summary,
					resultIds: result.into ? [memoryEntityId.parse(result.into.id)] : []
				});
				return ok(result, summary);
			}
		},
		{
			name: 'memory_global_record',
			description:
				'Explicitly store a user-scoped global memory recallable across conversations. Only when the user asks to remember something beyond this session. ' +
				FIELDS_NOTE,
			argsSchema: GlobalRememberArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					kind: {
						type: 'string',
						enum: ['preference', 'decision', 'fact', 'style', 'constraint'],
						description: 'Global memory kind.'
					},
					key: { type: 'string', description: 'Stable key for this memory.' },
					value: { description: 'JSON-serializable global memory value.' },
					fields: FIELDS_PARAM
				},
				required: ['kind', 'key', 'value'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GlobalRememberArgs.parse(args);
				const row = memoryRepo.upsertGlobalMemory(opts.userId, {
					kind: parsed.kind,
					memoryKey: parsed.key,
					value: parsed.value,
					sourceConversationId: opts.conversationId
				});
				const summary = `Stored global ${row.kind}: ${row.memoryKey}`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_global_record',
					arguments: parsed,
					resultSummary: summary,
					resultIds: [row.id]
				});
				const projected = project(row, projectOptions(parsed.fields, GLOBAL_MEMORY_KEEP));
				return ok(withOmitted({ memory: projected.value }, projected.omitted), summary);
			}
		},
		{
			name: 'memory_global_search',
			description:
				'Search explicit user-scoped global memories. Use for opt-in cross-session preferences, decisions, facts, style, and constraints. ' +
				FIELDS_NOTE,
			argsSchema: GlobalSearchArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Text to search in global memories.' },
					limit: { type: 'number', description: 'Results 1-50, default 20.' },
					fields: FIELDS_PARAM
				},
				required: ['query'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GlobalSearchArgs.parse(args);
				const results = memoryRepo.searchGlobalMemories(opts.userId, parsed);
				const summary = `${results.length} global result(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_global_search',
					arguments: parsed,
					resultSummary: summary,
					resultIds: results.map((result) => result.itemId)
				});
				const projected = project(results, projectOptions(parsed.fields, SEARCH_HIT_KEEP));
				return ok(withOmitted({ results: projected.value }, projected.omitted), summary);
			}
		},
		{
			name: 'memory_get_packet',
			description: 'Fetch the current initial durable memory packet for this session.',
			argsSchema: z.object({}).optional().default({}),
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {},
				additionalProperties: false
			},
			async handler() {
				const packet = buildInitialPacket(opts.conversationId, opts.mode, {
					globalMemoryEnabled: opts.globalMemoryEnabled
				});
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_packet',
					arguments: {},
					resultSummary: packet.summary
				});
				return ok(renderMemoryPacket(packet), packet.summary);
			}
		}
	];
	return opts.globalMemoryEnabled
		? tools
		: tools.filter((tool) => !tool.name.startsWith('memory_global_'));
}

function checkClaim(
	conversationId: string | number,
	claim: { entityKey?: string | undefined; predicate: string; value?: unknown }
) {
	const entity = claim.entityKey ? memoryRepo.getEntity(conversationId, claim.entityKey) : null;
	if (claim.entityKey && !entity) {
		return {
			claim,
			status: 'unknown',
			sources: [],
			reason: `No memory entity found for ${claim.entityKey}.`
		};
	}
	const facts = memoryRepo.listFacts(conversationId, {
		entityId: entity?.id,
		predicate: claim.predicate,
		limit: 50
	});
	if (facts.length === 0) return { claim, status: 'unknown', sources: [] };
	const exact = facts.find((fact) => JSON.stringify(fact.value) === JSON.stringify(claim.value));
	if (claim.value === undefined) return { claim, status: 'supported', sources: facts };
	if (exact) return { claim, status: 'supported', sources: [exact] };
	return { claim, status: 'contradicted', sources: facts };
}
