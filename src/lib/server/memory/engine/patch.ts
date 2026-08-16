import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { conversationId as convCodec, memoryFactId, messageId as msgCodec } from '$lib/ids';
import * as memoryRepo from '$lib/server/db/repos/memory';
import {
	DIRECTIVE_PREDICATE,
	deriveEntityFromKey,
	isDirectivePredicate,
	resolveForgetTarget,
	SESSION_ENTITY_KEY
} from './packet';
import { hasObjectStringFields, isHiddenVisibility, isSecretPredicate } from './loops';
import { solveStrictContinuity } from './continuity';
import type { MemoryMode } from '$lib/types';
import type { CommitMemoryPatchInput, MemoryPatchProposal } from './types';

export function validatePatch(
	patch: MemoryPatchProposal,
	opts: { conversationId?: string | number | undefined; mode?: MemoryMode | undefined } = {}
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
		const seenResolutionIds = new Set<string | number>();
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
		for (const target of patch.forgetFacts ?? []) {
			// Every forget must resolve to an ACTIVE fact (by handle, or by
			// entityKey+predicate for attributes). An unresolved target is an
			// error — not a silent no-op — so a stale/hallucinated handle is
			// surfaced rather than committed as nothing.
			const resolved = resolveForgetTarget(opts.conversationId, target);
			if (!resolved) {
				const selector = target.factId
					? `id "${target.factId}"`
					: target.entityKey || target.predicate
						? `${target.entityKey ?? '?'}.${target.predicate ?? '?'}`
						: '(no selector)';
				issues.push({
					severity: 'error',
					code: 'forget_target_unresolved',
					message: `No active fact matches the forget target ${selector}.`
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

/**
 * The write model the extractor (and any direct caller) speaks. Deliberately
 * narrowed to the two concepts that actually exist — `entities` (the durable
 * referents) and `facts` (everything you record about them) — plus
 * `closeLoops` for retiring existing threads.
 *
 * Every item in `facts` is a discriminated union on a REQUIRED `kind`, with no
 * default and no fallback: the model must explicitly decide what each thing is
 * before it can be written. `directive`, `open_loop`, and `event` are no longer
 * separate top-level arrays nor magic predicates — they are fact kinds. This is
 * the single change that makes mis-filing (the classic "a directive came out as
 * a fact / attribute / nothing at all") structurally hard:
 * there is exactly one place to put a thing, and you cannot put it there
 * without naming its kind.
 */
const PatchEntitySchema = z.object({
	entityKey: z.string().min(1).max(200),
	entityType: z.string().min(1).max(80).optional(),
	displayName: z.string().min(1).max(200).optional(),
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

// A loop may be referenced by its stable key or its raw integer id — both are
// valid `[id=...]` handles now that loop PKs are integers.
const LoopRefSchema = z.union([z.string().min(1).max(200), z.number().int().positive()]);
const PatchCloseLoopSchema = z.object({
	id: LoopRefSchema,
	status: z.enum(['resolved', 'dropped']),
	reason: z.string().max(2000).optional()
});

export type MemoryPatchFactItem = z.infer<typeof PatchFactItemSchema>;

export interface MemoryPatchInput {
	entities?: z.infer<typeof PatchEntitySchema>[] | undefined;
	facts?: MemoryPatchFactItem[] | undefined;
	closeLoops?: z.infer<typeof PatchCloseLoopSchema>[] | undefined;
	keepOpenLoops?: Array<string | number> | undefined;
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
		keepOpenLoops: z.array(LoopRefSchema).max(200).optional()
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
				items: { type: ['string', 'integer'], minLength: 1, maxLength: 200 }
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
				required: ['entityKey'],
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
						type: ['string', 'integer'],
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

export function commitPatch(
	input: CommitMemoryPatchInput,
	extractor?: {
		extractorKind?: string | undefined;
		extractorModel?: string | undefined;
		extractorConfidence?: number | undefined;
		extractorDiagnostics?: unknown;
	}
): {
	patch: memoryRepo.MemoryPatch;
	counts: {
		entities: number;
		events: number;
		facts: number;
		openLoops: number;
		resolvedOpenLoops: number;
		forgottenFacts: number;
		issues: number;
	};
} {
	const intConv =
		typeof input.conversationId === 'number'
			? input.conversationId
			: convCodec.parse(input.conversationId);
	const intSourceMessageId =
		input.sourceMessageId == null
			? null
			: typeof input.sourceMessageId === 'number'
				? input.sourceMessageId
				: msgCodec.parse(input.sourceMessageId);
	const validation = validatePatch(input.patch, {
		conversationId: intConv,
		mode: input.mode
	});
	const status = validation.ok ? 'committed' : 'needs_review';

	// The patch header, its issue rows, and — when the patch validated — the
	// full set of applied items (entities, events, facts, open loops,
	// resolutions, forgets, and their patch-item audit rows) all commit inside a
	// single better-sqlite3 transaction, so the whole commit is atomic. A crash
	// or exception mid-application can't leave a `committed` patch with only a
	// partial (or empty) set of items: the header rolls back along with the
	// items. better-sqlite3 nests transactions via SAVEPOINTs, so the inner
	// db.transaction() calls inside createPatch/upsertEntity/addFact/etc. become
	// savepoints under this outer transaction rather than throwing. The whole
	// body is synchronous (no awaits), which db.transaction() requires.
	return getDb().transaction(() => {
		const patchRecord = memoryRepo.createPatch(intConv, {
			turnId: input.turnId ?? null,
			sourceMessageId: intSourceMessageId ?? null,
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
			memoryRepo.addIssue(intConv, { patchId: patchRecord.id, ...issue });
		}
		if (!validation.ok) {
			return {
				patch: patchRecord,
				counts: {
					entities: 0,
					events: 0,
					facts: 0,
					openLoops: 0,
					resolvedOpenLoops: 0,
					forgottenFacts: 0,
					issues: validation.issues.length
				}
			};
		}

		// The patch validated and is about to be applied: now — and only now — is it
		// safe to run the caller's pre-commit hook (the retry path's undo of the
		// prior patch). A `needs_review` patch returns above without reaching this,
		// so a failed retry leaves the existing committed memory intact. Running it
		// here, immediately before the upserts below, also means the new patch's
		// entity-key reuse operates on clean pre-turn state.
		input.beforeCommit?.();

		const entityIdsByKey = new Map<string, string>();
		for (const entity of input.patch.entities ?? []) {
			// entityType/displayName are independently optional. For a brand-new
			// entity, fill whichever the caller omitted from the key (the single
			// derive site shared with ensureEntityForKey below). For an EXISTING
			// entity, leave the omitted field undefined so upsertEntity preserves the
			// stored value instead of clobbering it.
			const existing = memoryRepo.getEntity(intConv, entity.entityKey);
			let resolved = entity;
			if (!existing && (entity.entityType === undefined || entity.displayName === undefined)) {
				const derived = deriveEntityFromKey(entity.entityKey);
				resolved = {
					...entity,
					entityType: entity.entityType ?? derived.entityType,
					displayName: entity.displayName ?? derived.displayName
				};
			}
			const row = memoryRepo.upsertEntity(intConv, {
				...resolved,
				sourceMessageId: intSourceMessageId ?? null,
				turnId: input.turnId ?? null
			});
			entityIdsByKey.set(entity.entityKey, row.id);
			memoryRepo.recordPatchItem(intConv, {
				patchId: patchRecord.id,
				itemType: 'entity',
				itemId: row.id,
				action: 'create'
			});
		}
		for (const key of collectEntityKeys(input.patch)) {
			if (!entityIdsByKey.has(key)) {
				const existing = memoryRepo.getEntity(intConv, key);
				if (existing) entityIdsByKey.set(key, existing.id);
			}
		}

		let eventCount = 0;
		// Ids this patch itself created, so the concurrent-dedupe check below only
		// suppresses events appended by a DIFFERENT (racing) patch and still lets a
		// single patch intentionally carry repeats.
		const createdEventIds = new Set<number>();
		for (const event of input.patch.events ?? []) {
			// Concurrent extractions for the same conversation can each snapshot the
			// same pre-commit state and propose the identical event; `addEvent` is
			// append-only, so without this both commits would land a permanent
			// duplicate. Skip an event whose (turnId, eventType, summary) identity is
			// already present from another patch.
			const dupEvent = memoryRepo.findDuplicateEvent(intConv, {
				turnId: input.turnId ?? null,
				eventType: event.eventType,
				summary: event.summary
			});
			if (dupEvent && !createdEventIds.has(dupEvent.id)) {
				continue;
			}
			const row = memoryRepo.addEvent(intConv, {
				turnId: input.turnId,
				eventType: event.eventType,
				summary: event.summary,
				payload: event.payload,
				visibility: event.visibility,
				confidence: event.confidence,
				sourceMessageId: intSourceMessageId ?? null,
				targetEntityId: event.entityKey ? (entityIdsByKey.get(event.entityKey) ?? null) : null
			});
			memoryRepo.recordPatchItem(intConv, {
				patchId: patchRecord.id,
				itemType: 'event',
				itemId: row.id,
				action: 'create'
			});
			eventCount++;
			createdEventIds.add(row.id);
		}

		// Facts are always anchored to an entity so memory stays organized and
		// injects coherently. A referenced-but-unknown key mints a minimal entity
		// from the key itself; a fact with no key at all is attached to the
		// per-conversation session entity (created lazily, only when needed).
		// Record a freshly minted entity as a patch item so it participates in
		// undo/review just like an explicitly-declared entity. Pre-existing
		// entities are reused silently and must NOT be recorded, or undoing this
		// patch would delete an entity that other patches rely on.
		const recordMintedEntity = (entityId: string | number) => {
			memoryRepo.recordPatchItem(intConv, {
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
			const existing = memoryRepo.getEntity(intConv, SESSION_ENTITY_KEY);
			if (existing) {
				entityIdsByKey.set(SESSION_ENTITY_KEY, existing.id);
				sessionEntityId = existing.id;
				return existing.id;
			}
			const row = memoryRepo.upsertEntity(intConv, {
				entityKey: SESSION_ENTITY_KEY,
				entityType: 'session',
				displayName: 'Session',
				summary: 'Catch-all for session-scoped facts not tied to a specific entity.',
				sourceMessageId: intSourceMessageId ?? null,
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
			const row = memoryRepo.upsertEntity(intConv, {
				entityKey: key,
				entityType,
				displayName,
				sourceMessageId: intSourceMessageId ?? null,
				turnId: input.turnId ?? null
			});
			entityIdsByKey.set(key, row.id);
			recordMintedEntity(row.id);
			return row.id;
		};

		let factCount = 0;
		// Fact ids created by THIS patch (int form). A forget that re-resolves to
		// one of these (e.g. a forget-by-entityKey+predicate aimed at a predicate
		// the same patch also re-asserted — supersede already retired the old
		// value, leaving the fresh one active under that selector) must be
		// skipped, otherwise the forget would tombstone the just-written value and
		// wipe the predicate entirely.
		const createdFactIds = new Set<number>();
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
			const row = memoryRepo.addFact(intConv, {
				entityId,
				predicate,
				value: fact.value,
				visibility: fact.visibility,
				confidence: fact.confidence,
				pinned,
				sourceMessageId: intSourceMessageId ?? null
			});
			memoryRepo.recordPatchItem(intConv, {
				patchId: patchRecord.id,
				itemType: 'fact',
				itemId: row.id,
				action: 'create'
			});
			createdFactIds.add(memoryFactId.parse(row.id));
			factCount++;
		}

		// Legacy decisions: any `decisions` array on a historical/foreign patch is
		// silently ignored — the primitive has been retired (settled choices live on
		// as facts/attributes or directives).
		let openLoopCount = 0;
		// Ids this patch created, so the concurrent-dedupe check only suppresses
		// loops appended by a DIFFERENT (racing) patch — a single patch may still
		// intentionally carry two same-title loops (they get distinct loop keys).
		const createdOpenLoopIds = new Set<number>();
		for (const loop of input.patch.openLoops ?? []) {
			// Same concurrent-extraction hazard as events: `addOpenLoop` is
			// append-only, so two racing commits would both append the identical
			// loop. Skip a loop whose (loopType, title) already exists as an open
			// loop from another patch. Resolved/dropped loops don't match, so a
			// deliberately re-raised thread still creates a fresh loop.
			const dupLoop = memoryRepo.findDuplicateOpenLoop(intConv, {
				loopType: loop.loopType,
				title: loop.title
			});
			if (dupLoop && !createdOpenLoopIds.has(dupLoop.id)) {
				continue;
			}
			const row = memoryRepo.addOpenLoop(intConv, {
				loopType: loop.loopType,
				title: loop.title,
				description: loop.description,
				priority: loop.priority,
				relatedEntityIds: (loop.relatedEntityKeys ?? [])
					.map((key) => entityIdsByKey.get(key))
					.filter((id): id is string => id !== undefined),
				sourceMessageId: intSourceMessageId ?? null
			});
			memoryRepo.recordPatchItem(intConv, {
				patchId: patchRecord.id,
				itemType: 'open_loop',
				itemId: row.id,
				action: 'create'
			});
			openLoopCount++;
			createdOpenLoopIds.add(row.id);
		}
		let resolvedOpenLoops = 0;
		for (const resolution of input.patch.resolveOpenLoops ?? []) {
			// Accept either the stable loop key or the raw id; resolve to canonical id.
			const loopId = memoryRepo.resolveOpenLoopId(intConv, resolution.id);
			const existing = loopId ? memoryRepo.getOpenLoop(intConv, loopId) : null;
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
			const updated = memoryRepo.updateOpenLoop(intConv, loopId, {
				status: resolution.status,
				description
			});
			if (!updated) continue;
			resolvedOpenLoops += 1;
			memoryRepo.recordPatchItem(intConv, {
				patchId: patchRecord.id,
				itemType: 'open_loop',
				itemId: loopId,
				action: 'resolve'
			});
		}

		// Forget: tombstone each targeted active fact. Resolution is re-checked here
		// (not just at tool-call time) so a handle superseded/deleted by an earlier
		// item in THIS patch is skipped rather than mis-deleting whatever now sits
		// under that id. Recorded as a `forget` patch item so the delete is
		// auditable and visible in the inspector (and reviewable per item).
		let forgottenFacts = 0;
		for (const target of input.patch.forgetFacts ?? []) {
			const resolved = resolveForgetTarget(intConv, target);
			// Unresolved targets were already flagged in validation; skip so a stale
			// handle doesn't abort the rest of the commit.
			if (!resolved) continue;
			// Never forget a fact this same patch just created: a forget-by-predicate
			// re-resolves to the freshly-superseding value, so tombstoning it would
			// undo the supersede and drop the predicate. Prefer the supersede.
			if (createdFactIds.has(resolved.factId)) continue;
			const updated = memoryRepo.updateFact(intConv, resolved.factId, {
				status: 'deleted'
			});
			if (!updated) continue;
			forgottenFacts += 1;
			memoryRepo.recordPatchItem(intConv, {
				patchId: patchRecord.id,
				itemType: 'fact',
				itemId: resolved.factId,
				action: 'forget'
			});
		}

		return {
			patch: patchRecord,
			counts: {
				entities: input.patch.entities?.length ?? 0,
				events: eventCount,
				facts: factCount,
				openLoops: openLoopCount,
				resolvedOpenLoops,
				forgottenFacts,
				issues: validation.issues.length
			}
		};
	})();
}

function summarizePatch(patch: MemoryPatchProposal): string {
	return [
		patch.entities?.length ? `${patch.entities.length} entities` : '',
		patch.events?.length ? `${patch.events.length} events` : '',
		patch.facts?.length ? `${patch.facts.length} facts` : '',
		patch.openLoops?.length ? `${patch.openLoops.length} open loops` : '',
		patch.resolveOpenLoops?.length ? `${patch.resolveOpenLoops.length} resolved loops` : '',
		patch.forgetFacts?.length ? `${patch.forgetFacts.length} forgotten facts` : ''
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
