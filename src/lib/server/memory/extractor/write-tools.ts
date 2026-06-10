/**
 * The durable-write tool surface for the tool-calling memory extractor: the JSON
 * schemas/examples advertised to the model, the uniform success/error result
 * envelopes, and the stateful per-tool handlers.
 *
 * Handlers are built by {@link createWriteToolHandlers} against an explicit
 * {@link WriteToolDeps} object rather than closing over a giant extractor method,
 * so the surface lives on its own and the extractor loop stays small. Each tool
 * validates with the same `MemoryPatchInputSchema` + `validatePatch` the commit
 * path uses (no second schema to drift), stages the normalized fragment into the
 * shared `deps.staged` list, and returns a JSON envelope the model self-corrects
 * against.
 */
import type { ZodError, ZodIssue } from 'zod';
import type { MemoryMode } from '$lib/types';
import {
	validatePatch,
	isDirectivePredicate,
	MEMORY_FACT_KINDS,
	MEMORY_FACT_KIND_SCHEMAS,
	MEMORY_FACT_KIND_EXAMPLES,
	MemoryPatchInputSchema,
	normalizeMemoryPatchInput,
	type MemoryFactKind,
	type MemoryPatchProposal
} from '../engine';
import type { ExtractorToolSpec } from './types';

// Map a Zod issue to a short, actionable remediation sentence. The bare Zod
// message ("Required", "Invalid input") rarely tells a small model what to do;
// the issue's own metadata (expected type, the offending keys, the discriminator
// options) is far more useful when phrased as an instruction.
function hintForIssue(issue: ZodIssue): string {
	switch (issue.code) {
		case 'invalid_union_discriminator':
			return `Set "kind" to one of: ${MEMORY_FACT_KINDS.join(', ')}.`;
		case 'invalid_type':
			return issue.received === 'undefined'
				? `Missing required field — provide a ${issue.expected}.`
				: `Wrong type — expected ${issue.expected}, got ${issue.received}.`;
		case 'unrecognized_keys':
			return `Remove field(s) not allowed for this kind: ${issue.keys.join(', ')}.`;
		case 'too_small':
			return `Too short/small — needs at least ${issue.minimum}.`;
		case 'too_big':
			return `Too long/large — at most ${issue.maximum}.`;
		case 'invalid_enum_value':
			return `Use one of: ${issue.options.join(', ')}.`;
		default:
			return issue.message;
	}
}

// One field-scoped problem with a write-tool call, in the shape echoed back to
// the model. `field` names the offending argument; `hint` says how to fix it.
interface WriteIssue {
	field?: string;
	code: string;
	message: string;
	hint?: string;
}

// The single-item per-kind write tools handled generically. `remember_attribute`
// is intentionally NOT here — attributes use the dedicated batch tool
// `remember_attributes` (see below) because an entity naturally has many
// attributes at once, and one-item-per-call would penalize the granularity we
// want. keep_loops/close_loop/remember_entity/remember_attributes are handled
// separately.
const REMEMBER_TOOL_KINDS = {
	remember_directive: 'directive',
	remember_event: 'event',
	remember_loop: 'open_loop'
} as const satisfies Record<string, MemoryFactKind>;
type RememberToolName = keyof typeof REMEMBER_TOOL_KINDS;
type WriteToolName =
	| RememberToolName
	| 'remember_attributes'
	| 'remember_entity'
	| 'keep_loops'
	| 'close_loop';

const REMEMBER_TOOL_DESCRIPTIONS: Record<RememberToolName, string> = {
	remember_directive:
		'Record a standing rule for how you (the agent) must behave going forward — conduct, style, format, or process. Any durable behavioural policy counts, however phrased ("always …", "never …", or a plain declarative rule). One-off work for this turn is NOT a directive.',
	remember_event:
		'Record a point-in-time occurrence that belongs in a time-ordered log AND does not describe durable current state — e.g. a deploy shipped, a build/test failed, an approach was tried, a clue was revealed, a character moved. Append-only and recency-ranked. Most things are NOT events: if it is the current state of something (a value, status, preference, ownership, relationship), use remember_attributes instead. Test: would re-stating it later UPDATE a value (→ attribute) or ADD another log entry (→ event)?',
	remember_loop:
		'Open a NEW unresolved task, question, or thread to follow up on later. Use keep_loops/close_loop to maintain EXISTING loops; do not re-open one that already exists.'
};

// remember_entity establishes the durable referent (its type + display name)
// that attributes/events/loops attach to via entityKey. Facts referencing an
// unknown entityKey still auto-mint a bare entity on commit, but recording the
// entity explicitly lets the model set a proper type and display name.
const ENTITY_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['entityKey', 'entityType', 'displayName'],
	properties: {
		entityKey: {
			type: 'string',
			minLength: 1,
			maxLength: 200,
			description: 'Stable, namespaced key, e.g. character.mara or component.memory_extractor.'
		},
		entityType: {
			type: 'string',
			minLength: 1,
			maxLength: 80,
			description: 'The kind of referent, e.g. character, component, file, concept.'
		},
		displayName: {
			type: 'string',
			minLength: 1,
			maxLength: 200,
			description: 'Human-readable name for the referent.'
		},
		summary: { type: 'string', maxLength: 4000, description: 'Optional one-line description.' },
		metadata: { description: 'Optional arbitrary JSON metadata.' }
	}
} as const;

const ENTITY_EXAMPLE = {
	entityKey: 'character.mara',
	entityType: 'character',
	displayName: 'Mara'
};

// keep_loops / close_loop act on EXISTING loops by handle, so their schemas are
// hand-written rather than derived from a fact kind.
const KEEP_LOOPS_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['handles'],
	properties: {
		handles: {
			type: 'array',
			minItems: 1,
			maxItems: 200,
			items: { type: 'string', minLength: 1, maxLength: 200 },
			description:
				'Handles ([id=...] from the packet, e.g. loop.find_attic_key) of every presented open loop that is STILL live. Any presented loop you neither keep here nor close ages out and is auto-dropped.'
		}
	}
} as const;

const CLOSE_LOOP_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['handle', 'status'],
	properties: {
		handle: {
			type: 'string',
			minLength: 1,
			maxLength: 200,
			description: 'Handle ([id=...] from the packet) of the existing loop to retire.'
		},
		status: {
			type: 'string',
			enum: ['resolved', 'dropped'],
			description: '"resolved" = done/answered; "dropped" = abandoned/superseded.'
		},
		reason: { type: 'string', maxLength: 2000, description: 'Optional short reason.' }
	}
} as const;

const KEEP_LOOPS_EXAMPLE = { handles: ['loop.find_attic_key'] };
const CLOSE_LOOP_EXAMPLE = { handle: 'loop.find_attic_key', status: 'resolved' };

// A remember_* tool advertises its fact kind's schema/example with the internal
// `kind` discriminator stripped — the tool name already fixes the kind.
function stripKind<T extends { properties: Record<string, unknown>; required?: readonly string[] }>(
	schema: T
): {
	type: 'object';
	additionalProperties: false;
	required: string[];
	properties: Record<string, unknown>;
} {
	const { kind: _kind, ...properties } = schema.properties;
	void _kind;
	return {
		type: 'object',
		additionalProperties: false,
		required: (schema.required ?? []).filter((field) => field !== 'kind'),
		properties
	};
}

function stripKindExample(example: Record<string, unknown>): Record<string, unknown> {
	const { kind: _kind, ...rest } = example;
	void _kind;
	return rest;
}

// Optional paired-event fields layered onto each `remember_attributes` *item*
// (not the underlying attribute fact schema): when a state change is also a
// notable point-in-time occurrence, the model can log it in the same call
// instead of reaching for a separate remember_event (and losing the current
// state). These exist only at the tool boundary; the handler splits them off
// before validating the attribute, then stages a paired event fact.
const PAIRED_EVENT_PROPS = {
	event: {
		type: 'string',
		minLength: 1,
		maxLength: 4000,
		description:
			'Optional. If this change is ALSO a notable point-in-time occurrence worth a timeline entry, a one-line summary of what happened. Leave unset for ordinary state — most attributes need no event.'
	},
	eventType: {
		type: 'string',
		minLength: 1,
		maxLength: 100,
		description: 'Optional category for the paired `event` (defaults to "change").'
	}
} as const;

// Default category for an attribute-paired event when the model supplies `event`
// but no explicit `eventType`.
const PAIRED_EVENT_DEFAULT_TYPE = 'change';

// `remember_attributes` sets MANY attributes on ONE entity in a single call.
// entityKey is hoisted to the top level (shared by every item, so a batch can't
// straddle entities), and each item is a flat { predicate, value, … } object —
// an array of homogeneous flat objects, which weak backends handle far better
// than a union. Batching makes granularity cheap: the model splits a description
// into one item per trait instead of collapsing them into a single mega-value.
const ATTRIBUTES_BATCH_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['attributes'],
	properties: {
		entityKey: {
			type: 'string',
			minLength: 1,
			maxLength: 200,
			description:
				'The referent ALL these attributes attach to (its canonical entityKey). Strongly preferred; omit only for a genuinely entity-less attribute.'
		},
		attributes: {
			type: 'array',
			minItems: 1,
			maxItems: 100,
			description:
				'One item per DISTINCT trait or value. Split each detail into its own item — do not collapse several traits into one "description" value. Prose blurbs belong in the entity summary (remember_entity), not here.',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['predicate', 'value'],
				properties: {
					predicate: {
						type: 'string',
						minLength: 1,
						maxLength: 100,
						description: 'The property name for this single trait, e.g. "hair" or "language".'
					},
					value: { description: 'The value for this trait (any JSON type).' },
					visibility: { type: 'string', minLength: 1, maxLength: 100 },
					confidence: { type: 'number', minimum: 0, maximum: 1 },
					...PAIRED_EVENT_PROPS
				}
			}
		}
	}
} as const;

const ATTRIBUTES_BATCH_EXAMPLE = {
	entityKey: 'character.mara',
	attributes: [
		{ predicate: 'hair', value: 'red' },
		{ predicate: 'build', value: 'tall' },
		{ predicate: 'fears', value: 'deep water' }
	]
};

function writeToolParameters(tool: WriteToolName): Record<string, unknown> {
	if (tool === 'keep_loops') return KEEP_LOOPS_SCHEMA;
	if (tool === 'close_loop') return CLOSE_LOOP_SCHEMA;
	if (tool === 'remember_entity') return ENTITY_SCHEMA;
	if (tool === 'remember_attributes') return ATTRIBUTES_BATCH_SCHEMA;
	return stripKind(MEMORY_FACT_KIND_SCHEMAS[REMEMBER_TOOL_KINDS[tool]]);
}

function writeToolExample(tool: WriteToolName): Record<string, unknown> {
	if (tool === 'keep_loops') return KEEP_LOOPS_EXAMPLE;
	if (tool === 'close_loop') return CLOSE_LOOP_EXAMPLE;
	if (tool === 'remember_entity') return ENTITY_EXAMPLE;
	if (tool === 'remember_attributes') return ATTRIBUTES_BATCH_EXAMPLE;
	return stripKindExample(MEMORY_FACT_KIND_EXAMPLES[REMEMBER_TOOL_KINDS[tool]]);
}

// Map raw Zod issues to the model-facing WriteIssue shape, dropping a leading
// path segment (e.g. `facts.0.`) so the field name is what the model actually
// sent rather than an internal fragment path.
function zodToWriteIssues(error: ZodError, stripPrefix?: string): WriteIssue[] {
	return error.issues.map((issue) => {
		let field = issue.path.join('.');
		if (stripPrefix && field.startsWith(stripPrefix)) field = field.slice(stripPrefix.length);
		return {
			field: field || undefined,
			code: issue.code,
			message: issue.message,
			hint: hintForIssue(issue)
		};
	});
}

// One `remember_attributes` item validates an attribute fact (facts.0) plus,
// when a paired event is present, an event fact (facts.1). Strip the `facts.<n>.`
// prefix and rename the event fact's `summary` back to the item's `event` field
// so issues name what the model actually sent.
function attributeItemWriteIssues(error: ZodError): WriteIssue[] {
	return error.issues.map((issue) => {
		let field = issue.path.join('.').replace(/^facts\.\d+\./, '');
		if (field === 'summary') field = 'event';
		return {
			field: field || undefined,
			code: issue.code,
			message: issue.message,
			hint: hintForIssue(issue)
		};
	});
}

function semanticToWriteIssues(
	issues: Array<{ severity: 'info' | 'warning' | 'error'; code: string; message: string }>
): WriteIssue[] {
	return issues.map((issue) => ({ code: issue.code, message: issue.message, hint: issue.message }));
}

// `accepted` echoes the CANONICAL input — the normalized form the server actually
// consumed, expressed back in the tool's own input shape ("you sent X; I used Y").
// We get it by parsing the fragment with MemoryPatchInputSchema (which validates
// and normalizes — trims, fills defaults, drops unknown keys — but does NOT
// transform to the internal storage shape), then projecting each parsed item back
// to the flat tool-input object. normalizeMemoryPatchInput() turns the same parsed
// input into the internal patch we stage, so accepted and what-we-store agree.
function dropKeys<T extends Record<string, unknown>>(
	obj: T,
	keys: string[]
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (!keys.includes(k) && v !== undefined) out[k] = v;
	}
	return out;
}

// Running per-kind totals of what is staged so far, echoed on every result so
// the model can see nothing already staged was lost when a later call fails.
function stagedTotals(staged: MemoryPatchProposal[]): Record<string, number> {
	let entities = 0;
	let attributes = 0;
	let directives = 0;
	let events = 0;
	let loops = 0;
	let keptLoops = 0;
	let closedLoops = 0;
	for (const patch of staged) {
		entities += patch.entities?.length ?? 0;
		for (const fact of patch.facts ?? []) {
			if (isDirectivePredicate(fact.predicate)) directives += 1;
			else attributes += 1;
		}
		events += patch.events?.length ?? 0;
		loops += patch.openLoops?.length ?? 0;
		keptLoops += patch.keepOpenLoops?.length ?? 0;
		closedLoops += patch.resolveOpenLoops?.length ?? 0;
	}
	return { entities, attributes, directives, events, loops, keptLoops, closedLoops };
}

function writeSuccess(
	tool: WriteToolName,
	action: 'created' | 'kept' | 'closed',
	accepted: unknown,
	totals: Record<string, number>,
	warnings: WriteIssue[],
	extra: Record<string, unknown> = {}
): string {
	return JSON.stringify({
		ok: true,
		tool,
		action,
		accepted,
		...(warnings.length ? { issues: warnings } : {}),
		staged_totals: totals,
		...extra,
		note: 'Staged. Call another write tool to record more, or stop when nothing durable remains. Nothing commits until you finish.'
	});
}

function writeError(
	tool: WriteToolName,
	kind: 'validation' | 'execution',
	code: string,
	message: string,
	issues: WriteIssue[],
	received: unknown,
	totals: Record<string, number>,
	extra: Record<string, unknown> = {},
	noteOverride?: string
): string {
	const note =
		noteOverride ??
		(kind === 'execution'
			? `Could not run: ${message} Read each issue's \`hint\`, then call ${tool} again with valid arguments. Nothing already staged was lost.`
			: `Not staged. Fix the fields in \`issues\` (each has a \`hint\`), copy the shape in \`expected.example\`, then call ${tool} again. Nothing already staged was lost; nothing commits until you finish.`);
	return JSON.stringify({
		ok: false,
		tool,
		error: { kind, code, message },
		issues,
		expected: { schema: writeToolParameters(tool), example: writeToolExample(tool) },
		received,
		staged_totals: totals,
		...extra,
		note
	});
}

/**
 * The durable-write tool specs advertised to the extractor: remember_attributes
 * (a batch of traits on one entity), the single-item remember_directive/event/
 * loop creators, remember_entity, and keep_loops/close_loop for open-loop
 * lifecycle. Each has a flat schema (at most an array of flat objects) so even
 * backends with weak tool-argument grammar enforcement can fill it — no union.
 */
export function buildWriteToolSpecs(): ExtractorToolSpec[] {
	const remember = (Object.keys(REMEMBER_TOOL_KINDS) as RememberToolName[]).map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool,
			description: REMEMBER_TOOL_DESCRIPTIONS[tool],
			parameters: writeToolParameters(tool)
		}
	}));
	return [
		...remember,
		{
			type: 'function',
			function: {
				name: 'remember_attributes',
				description:
					'Record durable things to KNOW about ONE entity — its current state, traits, values, relationships, preferences, constraints, ownership, roles, deadlines, or identifiers. Pass the shared entityKey once at the top level and an `attributes` array with ONE item per distinct trait. Always decompose: a description like "a tall woman with red hair who fears water" becomes separate items (build=tall, hair=red, fears=water), never one big "description" value — a prose blurb belongs in the entity summary instead. An item may carry an optional `event` summary (+ optional `eventType`) when that particular change is also a notable timeline occurrence.',
				parameters: writeToolParameters('remember_attributes')
			}
		},
		{
			type: 'function',
			function: {
				name: 'remember_entity',
				description:
					'Establish a durable referent (its type and display name) that attributes, events, and loops attach to via entityKey. Record the entity before, or alongside, the first fact about a new referent so it gets a proper type and name instead of being auto-minted. Put a one-line prose blurb in `summary`; put discrete traits as separate items via remember_attributes.',
				parameters: writeToolParameters('remember_entity')
			}
		},
		{
			type: 'function',
			function: {
				name: 'keep_loops',
				description:
					'Keep one or more EXISTING open loops alive (anti-aging) by handle. Pass the handle of every presented loop that is still live; any you omit ages out. Batch them in a single call.',
				parameters: writeToolParameters('keep_loops')
			}
		},
		{
			type: 'function',
			function: {
				name: 'close_loop',
				description:
					'Retire one EXISTING open loop by handle: status "resolved" when done/answered, "dropped" when abandoned or superseded (e.g. an option the user did not choose).',
				parameters: writeToolParameters('close_loop')
			}
		}
	];
}

/**
 * Everything the write-tool handlers need from the owning extraction run. The
 * handlers append accepted internal patch fragments to `staged` (a shared array
 * the extractor later merges + commits) and report call/rejection counts via the
 * callbacks, so they stay pure functions of this object instead of closures over
 * a giant method.
 */
export interface WriteToolDeps {
	conversationId: string;
	mode: MemoryMode;
	/** Open loops presented to the extractor this turn (for handle validation). */
	presentedLoops: Array<{ id: string; loopKey: string }>;
	/** Shared staging buffer; handlers push accepted normalized patch fragments. */
	staged: MemoryPatchProposal[];
	/** Invoked once per write-tool call (telemetry: total propose calls). */
	onProposeCall: () => void;
	/** Invoked when a write-tool call is rejected (telemetry: rejected count). */
	onReject: () => void;
}

/**
 * Build the durable-write tool handler map for one extraction run. Each handler
 * validates with `MemoryPatchInputSchema` + `validatePatch`, stages the
 * normalized fragment into `deps.staged`, and returns a JSON envelope.
 */
export function createWriteToolHandlers(
	deps: WriteToolDeps
): Map<string, (args: unknown) => Promise<string>> {
	const { conversationId, mode, presentedLoops, staged } = deps;
	const isPresentedHandle = (handle: string): boolean =>
		presentedLoops.some((loop) => loop.id === handle || loop.loopKey === handle);

	// remember_directive / remember_event / remember_loop. Each maps to a single
	// fact kind: build a one-item fragment with the kind injected, validate it
	// with MemoryPatchInputSchema (canonical input), normalize that into the
	// internal patch the commit path consumes (same code, no schema drift), and
	// stage it. A bad call stages nothing, so a correction replaces it rather
	// than duplicating. (Attributes use the dedicated batch handler below.)
	const handleRemember =
		(tool: RememberToolName) =>
		async (rawArgs: unknown): Promise<string> => {
			deps.onProposeCall();
			const kind = REMEMBER_TOOL_KINDS[tool];
			const args = (rawArgs ?? {}) as Record<string, unknown>;
			const parsed = MemoryPatchInputSchema.safeParse({ facts: [{ kind, ...args }] });
			if (!parsed.success) {
				deps.onReject();
				return writeError(
					tool,
					'validation',
					'schema_invalid',
					`Arguments for ${tool} did not match its schema.`,
					zodToWriteIssues(parsed.error, 'facts.0.'),
					args,
					stagedTotals(staged)
				);
			}
			const internal = normalizeMemoryPatchInput(parsed.data);
			const validation = validatePatch(internal, { conversationId, mode });
			const errors = validation.issues.filter((issue) => issue.severity === 'error');
			if (errors.length) {
				deps.onReject();
				return writeError(
					tool,
					'validation',
					'semantic_invalid',
					`Arguments for ${tool} are well-formed but not acceptable.`,
					semanticToWriteIssues(errors),
					args,
					stagedTotals(staged)
				);
			}
			staged.push(internal);
			// Canonical input echo: the parsed fact with its `kind` discriminator
			// removed (the tool name already fixes the kind).
			const canonical = dropKeys(parsed.data.facts![0], ['kind']);
			return writeSuccess(
				tool,
				'created',
				canonical,
				stagedTotals(staged),
				semanticToWriteIssues(validation.issues.filter((issue) => issue.severity !== 'error'))
			);
		};

	// remember_attributes: set many granular attributes on ONE entity in a
	// single call. entityKey is hoisted (shared by every item); each item is
	// validated INDEPENDENTLY so one malformed trait can't sink the batch —
	// valid items stage and invalid ones are reported by index (partial
	// acceptance, like keep_loops). Each item may carry an optional paired
	// event (`event` + optional `eventType`), staged as a sibling event fact.
	const handleRememberAttributes = async (rawArgs: unknown): Promise<string> => {
		deps.onProposeCall();
		const args = (rawArgs ?? {}) as Record<string, unknown>;
		const topEntityKey = typeof args.entityKey === 'string' ? args.entityKey : undefined;
		const items = args.attributes;
		if (!Array.isArray(items) || items.length === 0) {
			deps.onReject();
			return writeError(
				'remember_attributes',
				'validation',
				'schema_invalid',
				'`attributes` must be a non-empty array of { predicate, value } items.',
				[
					{
						field: 'attributes',
						code: 'invalid_attributes',
						message: '`attributes` must be a non-empty array.',
						hint: 'Provide one item per distinct trait, each with a predicate and value.'
					}
				],
				args,
				stagedTotals(staged)
			);
		}

		const acceptedPatches: MemoryPatchProposal[] = [];
		const acceptedItems: Record<string, unknown>[] = [];
		const results: Array<Record<string, unknown>> = [];
		const failureIssues: WriteIssue[] = [];
		let pairedEvents = 0;

		for (let i = 0; i < items.length; i += 1) {
			const raw = (items[i] ?? {}) as Record<string, unknown>;
			const { event, eventType, ...attr } = raw;
			const fail = (issues: WriteIssue[]) => {
				results.push({ index: i, staged: false, issues });
				for (const issue of issues) {
					failureIssues.push({
						...issue,
						field: `attributes.${i}.${issue.field ?? ''}`.replace(/\.$/, '')
					});
				}
			};

			if (!(typeof event === 'string' && event.trim()) && eventType !== undefined) {
				fail([
					{
						field: 'eventType',
						code: 'event_type_without_event',
						message: '`eventType` only applies when a paired `event` summary is given.',
						hint: 'Provide an `event` summary too, or omit `eventType`.'
					}
				]);
				continue;
			}

			const factItems: Record<string, unknown>[] = [
				{ kind: 'attribute', ...(topEntityKey ? { entityKey: topEntityKey } : {}), ...attr }
			];
			let itemPaired = false;
			if (typeof event === 'string' && event.trim()) {
				itemPaired = true;
				factItems.push({
					kind: 'event',
					eventType:
						typeof eventType === 'string' && eventType.trim()
							? eventType
							: PAIRED_EVENT_DEFAULT_TYPE,
					summary: event,
					...(topEntityKey ? { entityKey: topEntityKey } : {})
				});
			}

			const parsed = MemoryPatchInputSchema.safeParse({ facts: factItems });
			if (!parsed.success) {
				fail(attributeItemWriteIssues(parsed.error));
				continue;
			}
			const internal = normalizeMemoryPatchInput(parsed.data);
			const validation = validatePatch(internal, { conversationId, mode });
			const errors = validation.issues.filter((issue) => issue.severity === 'error');
			if (errors.length) {
				fail(semanticToWriteIssues(errors));
				continue;
			}
			acceptedPatches.push(internal);
			// Canonical input echo: the parsed attribute item (kind + the hoisted
			// entityKey removed) plus, if paired, the normalized event summary and
			// its eventType — including the defaulted "change" — folded back into
			// the single tool-input item shape.
			const attrItem = dropKeys(parsed.data.facts![0], ['kind', 'entityKey']);
			if (itemPaired) {
				const evFact = parsed.data.facts![1] as { summary?: unknown; eventType?: unknown };
				attrItem.event = evFact.summary;
				attrItem.eventType = evFact.eventType;
			}
			acceptedItems.push(attrItem);
			if (itemPaired) pairedEvents += 1;
			results.push({ index: i, staged: true });
		}

		for (const patch of acceptedPatches) staged.push(patch);
		const extra: Record<string, unknown> = { results };
		if (pairedEvents) extra.pairedEvents = pairedEvents;

		if (failureIssues.length) {
			deps.onReject();
			const failed = results.filter((result) => !result.staged).length;
			return writeError(
				'remember_attributes',
				'validation',
				'batch_partial',
				`${failed} of ${items.length} attribute(s) were not staged.`,
				failureIssues,
				args,
				stagedTotals(staged),
				extra,
				`Staged the valid attribute(s); the items in \`results\` with "staged": false were NOT. Re-send ONLY those items (corrected) — do not resend the whole batch, or the already-staged items would be duplicated.`
			);
		}
		return writeSuccess(
			'remember_attributes',
			'created',
			{ ...(topEntityKey ? { entityKey: topEntityKey } : {}), attributes: acceptedItems },
			stagedTotals(staged),
			[],
			extra
		);
	};

	// remember_entity: establish a durable referent. Validated via the input
	// schema; the parsed entity is itself the canonical input shape.
	const handleRememberEntity = async (rawArgs: unknown): Promise<string> => {
		deps.onProposeCall();
		const args = (rawArgs ?? {}) as Record<string, unknown>;
		const parsed = MemoryPatchInputSchema.safeParse({ entities: [args] });
		if (!parsed.success) {
			deps.onReject();
			return writeError(
				'remember_entity',
				'validation',
				'schema_invalid',
				'Arguments for remember_entity did not match its schema.',
				zodToWriteIssues(parsed.error, 'entities.0.'),
				args,
				stagedTotals(staged)
			);
		}
		staged.push(normalizeMemoryPatchInput(parsed.data));
		const canonical = dropKeys(parsed.data.entities![0], []);
		return writeSuccess('remember_entity', 'created', canonical, stagedTotals(staged), []);
	};

	// keep_loops: batch anti-aging reaffirm. Only handles for loops actually
	// presented this turn are staged; unknown handles are reported per-handle so
	// the model can correct them (partial success is first-class).
	const handleKeepLoops = async (rawArgs: unknown): Promise<string> => {
		deps.onProposeCall();
		const args = (rawArgs ?? {}) as Record<string, unknown>;
		const handles = args.handles;
		if (
			!Array.isArray(handles) ||
			handles.length === 0 ||
			!handles.every((handle) => typeof handle === 'string' && handle.length > 0)
		) {
			deps.onReject();
			return writeError(
				'keep_loops',
				'validation',
				'schema_invalid',
				'`handles` must be a non-empty array of open-loop handle strings.',
				[
					{
						field: 'handles',
						code: 'invalid_handles',
						message: '`handles` must be a non-empty array of strings.',
						hint: 'Pass the [id=...] handle of each still-live presented loop.'
					}
				],
				args,
				stagedTotals(staged)
			);
		}
		const strHandles = handles as string[];
		const known: string[] = [];
		const unknown: string[] = [];
		const results = strHandles.map((handle) => {
			const kept = isPresentedHandle(handle);
			(kept ? known : unknown).push(handle);
			return {
				handle,
				kept,
				...(kept ? {} : { hint: 'Not a presented open loop; see memory_get_open_loops.' })
			};
		});
		if (known.length) staged.push({ keepOpenLoops: known });
		if (unknown.length) {
			deps.onReject();
			return writeError(
				'keep_loops',
				'execution',
				'unknown_handles',
				`${unknown.length} of ${strHandles.length} handle(s) are not presented open loops.`,
				unknown.map((handle) => ({
					field: 'handles',
					code: 'unknown_handle',
					message: `Unknown loop handle: ${handle}`,
					hint: 'Call memory_get_open_loops to list valid handles.'
				})),
				args,
				stagedTotals(staged),
				{ results }
			);
		}
		return writeSuccess('keep_loops', 'kept', { handles: known }, stagedTotals(staged), [], {
			results
		});
	};

	// close_loop: retire one existing loop. Existence is checked via the same
	// key-or-id resolution validatePatch uses; an unresolved handle is surfaced
	// as an execution error (not silently staged as a no-op).
	const handleCloseLoop = async (rawArgs: unknown): Promise<string> => {
		deps.onProposeCall();
		const args = (rawArgs ?? {}) as Record<string, unknown>;
		const parsed = MemoryPatchInputSchema.safeParse({
			closeLoops: [{ id: args.handle, status: args.status, reason: args.reason }]
		});
		if (!parsed.success) {
			deps.onReject();
			const issues = zodToWriteIssues(parsed.error, 'closeLoops.0.').map((issue) =>
				issue.field === 'id' ? { ...issue, field: 'handle' } : issue
			);
			return writeError(
				'close_loop',
				'validation',
				'schema_invalid',
				'Arguments for close_loop did not match its schema.',
				issues,
				args,
				stagedTotals(staged)
			);
		}
		const internal = normalizeMemoryPatchInput(parsed.data);
		const validation = validatePatch(internal, { conversationId, mode });
		const unknown = validation.issues.find(
			(issue) => issue.code === 'open_loop_resolution_unknown_id'
		);
		if (unknown) {
			deps.onReject();
			return writeError(
				'close_loop',
				'execution',
				'unknown_loop',
				`No open loop matches handle "${String(args.handle)}".`,
				[
					{
						field: 'handle',
						code: 'unknown_loop',
						message: unknown.message,
						hint: 'Call memory_get_open_loops to list valid handles.'
					}
				],
				args,
				stagedTotals(staged)
			);
		}
		const errors = validation.issues.filter((issue) => issue.severity === 'error');
		if (errors.length) {
			deps.onReject();
			return writeError(
				'close_loop',
				'validation',
				'semantic_invalid',
				'close_loop arguments are well-formed but not acceptable.',
				semanticToWriteIssues(errors),
				args,
				stagedTotals(staged)
			);
		}
		staged.push(internal);
		// Canonical input echo: map the internal `id` field back to the tool's
		// `handle` field.
		const cl = parsed.data.closeLoops![0];
		const canonical: Record<string, unknown> = { handle: cl.id, status: cl.status };
		if (cl.reason !== undefined) canonical.reason = cl.reason;
		return writeSuccess(
			'close_loop',
			'closed',
			canonical,
			stagedTotals(staged),
			semanticToWriteIssues(validation.issues.filter((issue) => issue.severity !== 'error'))
		);
	};

	const handlers = new Map<string, (args: unknown) => Promise<string>>();
	for (const tool of Object.keys(REMEMBER_TOOL_KINDS) as RememberToolName[]) {
		handlers.set(tool, handleRemember(tool));
	}
	handlers.set('remember_attributes', handleRememberAttributes);
	handlers.set('remember_entity', handleRememberEntity);
	handlers.set('keep_loops', handleKeepLoops);
	handlers.set('close_loop', handleCloseLoop);
	return handlers;
}
