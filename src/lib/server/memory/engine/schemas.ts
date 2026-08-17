import { z } from "zod";
import { DIRECTIVE_PREDICATE } from "./packet";
import type { MemoryPatchProposal } from "./types";

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
  metadata: z.unknown().optional(),
});

const PatchFactItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("attribute"),
    entityKey: z.string().min(1).max(200).optional(),
    predicate: z.string().min(1).max(100),
    value: z.custom<unknown>((value) => value !== undefined, {
      message: "value is required",
    }),
    visibility: z.string().min(1).max(100).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    kind: z.literal("directive"),
    rule: z.string().trim().min(3).max(4000),
    entityKey: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("open_loop"),
    loopType: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    description: z.string().max(8000).optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    relatedEntityKeys: z.array(z.string().min(1).max(200)).max(50).optional(),
  }),
  z.object({
    kind: z.literal("event"),
    eventType: z.string().min(1).max(100),
    summary: z.string().min(1).max(4000),
    entityKey: z.string().min(1).max(200).optional(),
    payload: z.unknown().optional(),
    visibility: z.string().min(1).max(100).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
]);

// A loop may be referenced by its stable key or its raw integer id — both are
// valid `[id=...]` handles now that loop PKs are integers.
const LoopRefSchema = z.union([
  z.string().min(1).max(200),
  z.number().int().positive(),
]);
const PatchCloseLoopSchema = z.object({
  id: LoopRefSchema,
  status: z.enum(["resolved", "dropped"]),
  reason: z.string().max(2000).optional(),
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
export function normalizeMemoryPatchInput(
  input: MemoryPatchInput,
): MemoryPatchProposal {
  const proposal: MemoryPatchProposal = {};
  if (input.entities?.length) proposal.entities = input.entities;

  const facts: NonNullable<MemoryPatchProposal["facts"]> = [];
  const events: NonNullable<MemoryPatchProposal["events"]> = [];
  const openLoops: NonNullable<MemoryPatchProposal["openLoops"]> = [];

  for (const item of input.facts ?? []) {
    switch (item.kind) {
      case "attribute":
        facts.push({
          entityKey: item.entityKey,
          predicate: item.predicate,
          value: item.value,
          visibility: item.visibility,
          confidence: item.confidence,
        });
        break;
      case "directive":
        facts.push({
          entityKey: item.entityKey,
          predicate: DIRECTIVE_PREDICATE,
          value: item.rule,
        });
        break;
      case "open_loop":
        openLoops.push({
          loopType: item.loopType,
          title: item.title,
          description: item.description,
          priority: item.priority,
          relatedEntityKeys: item.relatedEntityKeys,
        });
        break;
      case "event":
        events.push({
          eventType: item.eventType,
          summary: item.summary,
          entityKey: item.entityKey,
          payload: item.payload,
          visibility: item.visibility,
          confidence: item.confidence,
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
    keepOpenLoops: z.array(LoopRefSchema).max(200).optional(),
  })
  .strict();

/**
 * The schema model output is parsed with. Accepts the unified write shape and
 * transforms it into the internal {@link MemoryPatchProposal}, so every
 * downstream consumer (`validatePatch`, `commitPatch`, summarization) is
 * untouched.
 */
export const MemoryPatchProposalSchema = MemoryPatchInputSchema.transform(
  normalizeMemoryPatchInput,
);

/** The fact kinds, in canonical order. */
export const MEMORY_FACT_KINDS = [
  "attribute",
  "directive",
  "open_loop",
  "event",
] as const;
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
    type: "object",
    additionalProperties: false,
    required: ["kind", "predicate", "value"],
    properties: {
      kind: { const: "attribute" },
      entityKey: { type: "string", minLength: 1, maxLength: 200 },
      predicate: { type: "string", minLength: 1, maxLength: 100 },
      value: {
        description:
          "Required attribute value (any JSON type except undefined).",
      },
      visibility: { type: "string", minLength: 1, maxLength: 100 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
  directive: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "rule"],
    properties: {
      kind: { const: "directive" },
      rule: {
        type: "string",
        minLength: 3,
        maxLength: 4000,
        description:
          "The standing instruction, stated in full as a declarative rule.",
      },
      entityKey: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
  open_loop: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "loopType", "title"],
    properties: {
      kind: { const: "open_loop" },
      loopType: { type: "string", minLength: 1, maxLength: 100 },
      title: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 8000 },
      priority: { type: "integer", minimum: -100, maximum: 100 },
      relatedEntityKeys: {
        type: "array",
        maxItems: 50,
        items: { type: ["string", "integer"], minLength: 1, maxLength: 200 },
      },
    },
  },
  event: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "eventType", "summary"],
    properties: {
      kind: { const: "event" },
      eventType: { type: "string", minLength: 1, maxLength: 100 },
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      entityKey: { type: "string", minLength: 1, maxLength: 200 },
      payload: { description: "Arbitrary JSON payload." },
      visibility: { type: "string", minLength: 1, maxLength: 100 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  },
} as const satisfies Record<MemoryFactKind, unknown>;

/**
 * A tiny, valid example per kind. Echoed back on a schema failure: a concrete
 * correct object is far easier for a model to copy than an abstract schema.
 */
export const MEMORY_FACT_KIND_EXAMPLES = {
  attribute: {
    kind: "attribute",
    entityKey: "auth_service",
    predicate: "language",
    value: "TypeScript",
  },
  directive: { kind: "directive", rule: "Keep responses under 200 words." },
  open_loop: {
    kind: "open_loop",
    loopType: "task",
    title: "Add rate limiting to the login endpoint",
  },
  event: {
    kind: "event",
    eventType: "deploy",
    summary: "Shipped v1.2 to production",
  },
} as const satisfies Record<
  MemoryFactKind,
  { kind: MemoryFactKind } & Record<string, unknown>
>;

/** The required field names (besides `kind`) for each kind, for error hints. */
export const MEMORY_FACT_KIND_REQUIRED_FIELDS: Record<
  MemoryFactKind,
  string[]
> = {
  attribute: ["predicate", "value"],
  directive: ["rule"],
  open_loop: ["loopType", "title"],
  event: ["eventType", "summary"],
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
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  description:
    'One thing to remember. Set "kind" first — it decides which other fields are required. attribute: predicate + value. directive: rule. open_loop: loopType + title. event: eventType + summary.',
  properties: {
    kind: {
      type: "string",
      enum: [...MEMORY_FACT_KINDS],
      description:
        "Required. attribute = something to KNOW (needs predicate + value); directive = a standing behavioural rule (needs rule); open_loop = an unresolved task/question (needs loopType + title); event = something that happened (needs eventType + summary).",
    },
    entityKey: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Referent this attaches to. Used by attribute, directive, and event.",
    },
    predicate: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: 'attribute (required): the property name, e.g. "language".',
    },
    value: { description: "attribute (required): the value (any JSON type)." },
    rule: {
      type: "string",
      minLength: 3,
      maxLength: 4000,
      description:
        "directive (required): the standing instruction, stated in full.",
    },
    loopType: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description:
        'open_loop (required): the kind of thread, e.g. "task" or "question".',
    },
    title: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description: "open_loop (required): a short title for the thread.",
    },
    description: {
      type: "string",
      maxLength: 8000,
      description: "open_loop (optional): detail.",
    },
    priority: {
      type: "integer",
      minimum: -100,
      maximum: 100,
      description: "open_loop (optional).",
    },
    relatedEntityKeys: {
      type: "array",
      maxItems: 50,
      items: { type: "string", minLength: 1, maxLength: 200 },
      description: "open_loop (optional): related entity keys.",
    },
    eventType: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: 'event (required): the kind of event, e.g. "deploy".',
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 4000,
      description: "event (required): what happened.",
    },
    payload: { description: "event (optional): arbitrary JSON payload." },
    visibility: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "attribute / event (optional).",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "attribute / event (optional).",
    },
  },
} as const;

/** Where to put a lifted scalar when a `{ "<kind>": value }` shape is repaired. */
const MEMORY_FACT_KIND_PRIMARY_FIELD: Record<MemoryFactKind, string> = {
  attribute: "value",
  directive: "rule",
  open_loop: "title",
  event: "summary",
};

function isMemoryFactKind(value: unknown): value is MemoryFactKind {
  return (
    typeof value === "string" &&
    (MEMORY_FACT_KINDS as readonly string[]).includes(value)
  );
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
  if (!item || typeof item !== "object" || Array.isArray(item)) return { item };
  const record = item as Record<string, unknown>;
  if (isMemoryFactKind(record.kind)) return { item };

  const kindKey = MEMORY_FACT_KINDS.find(
    (kind) =>
      kind in record && record[kind] !== undefined && record[kind] !== null,
  );
  if (!kindKey) return { item };

  const lifted = record[kindKey];
  const repaired: Record<string, unknown> = { ...record };
  delete repaired[kindKey];
  repaired.kind = kindKey;
  const primaryField = MEMORY_FACT_KIND_PRIMARY_FIELD[kindKey];
  let placement = "";
  if (
    repaired[primaryField] === undefined &&
    (typeof lifted === "string" ||
      typeof lifted === "number" ||
      typeof lifted === "boolean")
  ) {
    repaired[primaryField] = lifted;
    placement = ` and moved its value into "${primaryField}"`;
  }
  return {
    item: repaired,
    warning: `Rewrote a fact that used "${kindKey}" as a key into { "kind": "${kindKey}", … }${placement}.`,
  };
}

/**
 * Apply {@link coerceFactItem} across a raw patch's `facts[]`, returning the
 * (possibly) repaired patch plus any human-readable warnings describing what was
 * changed. Non-object / arrayless input is returned untouched.
 */
export function coerceMemoryPatchInput(raw: unknown): {
  patch: unknown;
  warnings: string[];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { patch: raw, warnings: [] };
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
  type: "object",
  additionalProperties: false,
  description:
    'Durable memory patch. Only two concepts exist: entities (the referents) and facts (everything you record about them). Every item in facts MUST set "kind"; there is no default.',
  properties: {
    entities: {
      type: "array",
      maxItems: 50,
      description:
        "Durable referents that facts attach to. Reuse an existing entityKey when one exists.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["entityKey"],
        properties: {
          entityKey: { type: "string", minLength: 1, maxLength: 200 },
          entityType: { type: "string", minLength: 1, maxLength: 80 },
          displayName: { type: "string", minLength: 1, maxLength: 200 },
          summary: { type: "string", maxLength: 4000 },
          metadata: { description: "Arbitrary JSON metadata." },
        },
      },
    },
    facts: {
      type: "array",
      maxItems: 300,
      description:
        "Everything to remember, each tagged with its kind. attribute = something to KNOW; directive = a standing rule for how you must behave; open_loop = an unresolved task/question; event = something that happened.",
      items: MEMORY_FACT_FLAT_JSON_SCHEMA,
    },
    closeLoops: {
      type: "array",
      maxItems: 50,
      description:
        "Retire existing open loops when this turn resolved or abandoned them. Reference each loop by the handle shown in its [id=...] in the packet (its stable key, e.g. loop.find_attic_key).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status"],
        properties: {
          id: {
            type: ["string", "integer"],
            minLength: 1,
            maxLength: 200,
            description:
              "The loop handle from its [id=...] in the packet (key or raw id).",
          },
          status: { type: "string", enum: ["resolved", "dropped"] },
          reason: { type: "string", maxLength: 2000 },
        },
      },
    },
    keepOpenLoops: {
      type: "array",
      maxItems: 200,
      description:
        "Handles (the [id=...] shown in the packet, i.e. each loop's stable key) of presented open loops that are STILL live and should stay open. Any presented loop you neither keep here nor close in closeLoops ages out and is auto-dropped after a few turns.",
      items: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
} as const;
