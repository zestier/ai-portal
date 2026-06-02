import { z } from 'zod';
import * as memoryRepo from '$lib/server/db/repos/memory';
import * as messages from '$lib/server/db/repos/messages';
import { getMemoryProfile } from './profiles';
import type { MemoryMode, Message } from '$lib/types';

export interface TurnMemoryPacket {
	mode: MemoryMode;
	instructions: string;
	summary: string;
	decisions: memoryRepo.MemoryDecision[];
	openLoops: memoryRepo.MemoryOpenLoop[];
	facts: memoryRepo.MemoryFact[];
	entities: memoryRepo.MemoryEntity[];
	recentEvents: memoryRepo.MemoryEvent[];
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

export function buildInitialPacket(
	conversationId: string,
	mode: MemoryMode,
	opts: { globalMemoryEnabled?: boolean } = {}
): TurnMemoryPacket {
	const entities = memoryRepo.listEntities(conversationId, { limit: mode === 'strict' ? 80 : 40 });
	const facts = memoryRepo.listFacts(conversationId, { limit: mode === 'strict' ? 120 : 60 });
	const decisions = memoryRepo.listDecisions(conversationId, { limit: 40 });
	const openLoops = memoryRepo.listOpenLoops(conversationId, {
		limit: mode === 'strict' ? 80 : 40
	});
	const recentEvents = memoryRepo.listEvents(conversationId, {
		limit: mode === 'strict' ? 50 : 20
	});
	return {
		mode,
		instructions: memoryInstructions(mode),
		summary: summarizePacket({ entities, facts, decisions, openLoops, recentEvents }),
		entities,
		facts,
		decisions,
		openLoops,
		recentEvents,
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
	const packet = buildInitialPacket(params.conversationId, params.mode, {
		globalMemoryEnabled: params.globalMemoryEnabled
	});
	const recent = params.includeRecentTranscript
		? recentTranscript(params.conversationId, params.userMsg.id, 6)
		: '';
	const writeGuidance = params.extractorPresent
		? 'A dedicated memory extractor reviews every turn after you respond and records durable memory on your behalf. Do not call memory_propose_patch yourself: writing patches directly duplicates the extractor, blurs responsibilities, and makes a mess of the memory store. Concentrate on answering well and let the extractor capture what to remember. Only use memory_propose_patch if you must correct a specific, concrete memory error.'
		: 'If you make durable decisions, create tasks/open loops, establish story facts, or change important state, call memory_propose_patch with a structured patch before the final answer when practical.';
	return [
		'<portal_memory_mode>',
		JSON.stringify(packet, null, 2),
		'</portal_memory_mode>',
		'',
		'You are running in a fresh model context for this request. Durable session memory, not hidden chat context, is the source of continuity.',
		'The packet above is a deliberately small, high-level slice of durable memory — it is not the whole memory store. Treat it as a starting index, not the full picture.',
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
		if (!fact.entityKey && fact.predicate !== 'session_note') {
			issues.push({
				severity: 'warning',
				code: 'fact_without_entity',
				message: `Fact "${fact.predicate}" has no entity key; it will be stored as session-scoped.`
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

	let factCount = 0;
	for (const fact of input.patch.facts ?? []) {
		const row = memoryRepo.addFact(input.conversationId, {
			entityId: fact.entityKey ? (entityIdsByKey.get(fact.entityKey) ?? null) : null,
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
