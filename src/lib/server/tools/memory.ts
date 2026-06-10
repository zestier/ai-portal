import { z } from 'zod';
import * as memoryRepo from '../db/repos/memory';
import * as messagesRepo from '../db/repos/messages';
import { buildInitialPacket, renderMemoryPacket } from '../memory/engine';
import type { MemoryMode } from '$lib/types';
import type { PortalTool } from './git';

const SearchArgs = z.object({
	query: z.string().trim().min(1).max(500),
	types: z
		.array(z.enum(['entity', 'event', 'fact', 'decision', 'open_loop']))
		.max(5)
		.optional(),
	limit: z.number().int().min(1).max(50).optional().default(20)
});

const EntityArgs = z.object({
	id: z.string().trim().min(1).max(200)
});

const OpenLoopsArgs = z
	.object({
		loopType: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(50).optional().default(20)
	})
	.optional()
	.default({});

const RecentEventsArgs = z
	.object({
		entityId: z.string().trim().min(1).max(200).optional(),
		eventType: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(50).optional().default(20)
	})
	.optional()
	.default({});

const TranscriptLookupArgs = z.object({
	query: z.string().trim().min(1).max(500),
	limit: z.number().int().min(1).max(20).optional().default(8)
});

const TimelineArgs = z
	.object({
		entityId: z.string().trim().min(1).max(200).optional(),
		eventType: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(100).optional().default(50)
	})
	.optional()
	.default({});

const ClueArgs = z
	.object({
		status: z.enum(['all', 'open', 'revealed', 'resolved']).optional().default('all'),
		limit: z.number().int().min(1).max(100).optional().default(50)
	})
	.optional()
	.default({});

const CharacterKnowledgeArgs = z.object({
	characterEntityKey: z.string().trim().min(1).max(200),
	limit: z.number().int().min(1).max(100).optional().default(50)
});

const MergeEntitiesArgs = z.object({
	from: z.string().trim().min(1).max(200),
	into: z.string().trim().min(1).max(200)
});

const GlobalRememberArgs = z.object({
	kind: z.enum(['preference', 'decision', 'fact', 'style', 'constraint']),
	key: z.string().trim().min(1).max(200),
	value: z.unknown()
});

const GlobalSearchArgs = z.object({
	query: z.string().trim().min(1).max(500),
	limit: z.number().int().min(1).max(50).optional().default(20)
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
	userId: string;
	conversationId: string;
	getTurnId?: () => string | null;
	mode: MemoryMode;
	globalMemoryEnabled?: boolean;
}): PortalTool[] {
	if (opts.mode === 'off') return [];
	const tools: PortalTool[] = [
		{
			name: 'memory_search',
			description:
				'Search durable session memory. Mandatory when prior details are relevant but absent from the initial packet.',
			argsSchema: SearchArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Text to search for in durable memory.' },
					types: {
						type: 'array',
						items: { type: 'string', enum: ['entity', 'event', 'fact', 'decision', 'open_loop'] },
						description: 'Optional memory item types to include.'
					},
					limit: { type: 'number', description: 'Maximum results, 1-50. Defaults to 20.' }
				},
				required: ['query'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = SearchArgs.parse(args);
				const results = memoryRepo.search(opts.conversationId, parsed);
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_search',
					arguments: parsed,
					resultSummary: `${results.length} result(s)`,
					resultIds: results.map((result) => result.itemId)
				});
				return JSON.stringify({ results }, null, 2);
			}
		},
		{
			name: 'memory_get_entity',
			description:
				'Fetch canonical durable state for one entity by entity id or key, including active facts and recent events.',
			argsSchema: EntityArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Entity id or symbolic key, e.g. character.elias.' }
				},
				required: ['id'],
				additionalProperties: false
			},
			async handler(args) {
				const { id } = EntityArgs.parse(args);
				const entity = memoryRepo.getEntity(opts.conversationId, id);
				if (!entity) return JSON.stringify({ entity: null }, null, 2);
				const facts = memoryRepo.listFacts(opts.conversationId, {
					entityId: entity.id,
					limit: 100
				});
				const events = memoryRepo.listEvents(opts.conversationId, {
					entityId: entity.id,
					limit: 30
				});
				const result = { entity, facts, events };
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_entity',
					arguments: { id },
					resultSummary: entity.displayName,
					resultIds: [entity.id]
				});
				return JSON.stringify(result, null, 2);
			}
		},
		{
			name: 'memory_get_open_loops',
			description:
				'Fetch unresolved durable open loops: tasks, promises, plot threads, clues, questions, or commitments.',
			argsSchema: OpenLoopsArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					loopType: { type: 'string', description: 'Optional loop type filter.' },
					limit: { type: 'number', description: 'Maximum open loops, 1-50. Defaults to 20.' }
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = OpenLoopsArgs.parse(args);
				const openLoops = memoryRepo.listOpenLoops(opts.conversationId, parsed);
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_open_loops',
					arguments: parsed,
					resultSummary: `${openLoops.length} open loop(s)`,
					resultIds: openLoops.map((loop) => loop.id)
				});
				return JSON.stringify({ openLoops }, null, 2);
			}
		},
		{
			name: 'memory_get_recent_events',
			description:
				'Fetch recent durable memory events, optionally filtered by entity or event type.',
			argsSchema: RecentEventsArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					entityId: { type: 'string', description: 'Optional entity id.' },
					eventType: { type: 'string', description: 'Optional event type.' },
					limit: { type: 'number', description: 'Maximum events, 1-50. Defaults to 20.' }
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = RecentEventsArgs.parse(args);
				const events = memoryRepo.listEvents(opts.conversationId, parsed);
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_recent_events',
					arguments: parsed,
					resultSummary: `${events.length} event(s)`,
					resultIds: events.map((event) => event.id)
				});
				return JSON.stringify({ events }, null, 2);
			}
		},
		{
			name: 'memory_transcript_lookup',
			description:
				'Search exact prior conversation wording. Use when phrasing, quotes, or an old user/assistant statement matters.',
			argsSchema: TranscriptLookupArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Literal text to find in prior messages.' },
					limit: { type: 'number', description: 'Maximum matching messages, 1-20. Defaults to 8.' }
				},
				required: ['query'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = TranscriptLookupArgs.parse(args);
				const matches = messagesRepo.searchConversation(opts.conversationId, parsed.query, {
					limit: parsed.limit
				});
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_transcript_lookup',
					arguments: parsed,
					resultSummary: `${matches.length} message(s)`,
					resultIds: matches.map((message) => message.id)
				});
				return JSON.stringify({ messages: matches }, null, 2);
			}
		},
		{
			name: 'memory_query_timeline',
			description:
				'Return ordered memory events for timeline reasoning. Use in strict mode for alibis, chronology, and continuity checks.',
			argsSchema: TimelineArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					entityId: { type: 'string', description: 'Optional entity id.' },
					eventType: { type: 'string', description: 'Optional event type.' },
					limit: { type: 'number', description: 'Maximum events, 1-100. Defaults to 50.' }
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = TimelineArgs.parse(args);
				const events = memoryRepo
					.listEvents(opts.conversationId, parsed)
					.sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_query_timeline',
					arguments: parsed,
					resultSummary: `${events.length} timeline event(s)`,
					resultIds: events.map((event) => event.id)
				});
				return JSON.stringify({ events }, null, 2);
			}
		},
		{
			name: 'memory_query_clues',
			description:
				'Return clue-ledger records stored as open loops or facts. Use in mystery/strict sessions to preserve fair-play clues.',
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
					limit: { type: 'number', description: 'Maximum clues, 1-100. Defaults to 50.' }
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
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_query_clues',
					arguments: parsed,
					resultSummary: `${loops.length + clueFacts.length} clue record(s)`,
					resultIds: [...loops.map((loop) => loop.id), ...clueFacts.map((fact) => fact.id)]
				});
				return JSON.stringify({ openLoops: loops, facts: clueFacts }, null, 2);
			}
		},
		{
			name: 'memory_get_character_knowledge',
			description:
				'Return facts/events describing what a character or participant knows. Use to prevent impossible knowledge leakage.',
			argsSchema: CharacterKnowledgeArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					characterEntityKey: {
						type: 'string',
						description: 'Character entity key, e.g. character.elias.'
					},
					limit: { type: 'number', description: 'Maximum records, 1-100. Defaults to 50.' }
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
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_character_knowledge',
					arguments: parsed,
					resultSummary: `${facts.length + events.length} knowledge record(s)`,
					resultIds: [...facts.map((fact) => fact.id), ...events.map((event) => event.id)]
				});
				return JSON.stringify({ entity, facts, events }, null, 2);
			}
		},
		{
			name: 'memory_check_claims',
			description:
				'Check proposed claims against active durable facts. Use before making continuity-sensitive claims.',
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
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_check_claims',
					arguments: parsed,
					resultSummary: `${results.length} claim(s) checked`
				});
				return JSON.stringify({ results }, null, 2);
			}
		},
		{
			name: 'memory_merge_entities',
			description:
				"Fold a duplicate entity into a canonical one when two keys denote the same real referent (e.g. character.firstname and character.firstname_lastname). Reassigns the duplicate's facts, events, and open-loop links onto the canonical entity and retires the duplicate. Use this to clean up duplicates you discover; confirm with memory_get_entity first that they truly match.",
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
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_merge_entities',
					arguments: parsed,
					resultSummary: result.ok
						? `merged ${parsed.from} into ${parsed.into} (${result.reassignedFacts} fact(s), ${result.reassignedEvents} event(s))`
						: `not merged: ${result.error ?? 'unknown error'}`,
					resultIds: result.into ? [result.into.id] : []
				});
				return JSON.stringify(result, null, 2);
			}
		},
		{
			name: 'memory_global_remember',
			description:
				'Explicitly store a user-scoped global memory that may be recalled across conversations. Use only when the user asks to remember something beyond this session.',
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
					value: { description: 'JSON-serializable global memory value.' }
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
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_global_remember',
					arguments: parsed,
					resultSummary: `Stored global ${row.kind}: ${row.memoryKey}`,
					resultIds: [row.id]
				});
				return JSON.stringify({ memory: row }, null, 2);
			}
		},
		{
			name: 'memory_global_search',
			description:
				'Search explicit user-scoped global memories. Use for opt-in cross-session preferences, decisions, facts, style, and constraints.',
			argsSchema: GlobalSearchArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Text to search in global memories.' },
					limit: { type: 'number', description: 'Maximum results, 1-50. Defaults to 20.' }
				},
				required: ['query'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GlobalSearchArgs.parse(args);
				const results = memoryRepo.searchGlobalMemories(opts.userId, parsed);
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_global_search',
					arguments: parsed,
					resultSummary: `${results.length} global result(s)`,
					resultIds: results.map((result) => result.itemId)
				});
				return JSON.stringify({ results }, null, 2);
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
				return renderMemoryPacket(packet);
			}
		}
	];
	return opts.globalMemoryEnabled
		? tools
		: tools.filter((tool) => !tool.name.startsWith('memory_global_'));
}

function checkClaim(
	conversationId: string,
	claim: { entityKey?: string; predicate: string; value?: unknown }
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
