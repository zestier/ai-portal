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
import type { ZodError, ZodIssue } from "zod";
import type { MemoryMode } from "$lib/types";
import {
  validatePatch,
  isDirectivePredicate,
  resolveForgetTarget,
  MEMORY_FACT_KINDS,
  MEMORY_FACT_KIND_SCHEMAS,
  MEMORY_FACT_KIND_EXAMPLES,
  MemoryPatchInputSchema,
  normalizeMemoryPatchInput,
  type MemoryFactKind,
  type MemoryPatchProposal,
  type TurnMemoryPacket,
} from "../engine";
import type { ExtractorToolSpec } from "./types";

// Map a Zod issue to a short, actionable remediation sentence. The bare Zod
// message ("Required", "Invalid input") rarely tells a small model what to do;
// the issue's own metadata (expected type, the offending keys, the discriminator
// options) is far more useful when phrased as an instruction.
function hintForIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case "invalid_union":
      return `Set "kind" to one of: ${
        "options" in issue && issue.options?.length
          ? issue.options.join(", ")
          : MEMORY_FACT_KINDS.join(", ")
      }.`;
    case "invalid_type":
      return issue.input === undefined
        ? `Missing required field — provide a ${issue.expected}.`
        : `Wrong type — expected ${issue.expected}, got ${typeof issue.input}.`;
    case "unrecognized_keys":
      return `Remove field(s) not allowed for this kind: ${issue.keys.join(", ")}.`;
    case "too_small":
      return `Too short/small — needs at least ${issue.minimum}.`;
    case "too_big":
      return `Too long/large — at most ${issue.maximum}.`;
    case "invalid_value":
      return `Use one of: ${issue.values.join(", ")}.`;
    default:
      return issue.message;
  }
}

// One field-scoped problem with a write-tool call, in the shape echoed back to
// the model. `field` names the offending argument; `hint` says how to fix it.
interface WriteIssue {
  field?: string | undefined;
  code: string;
  message: string;
  hint?: string | undefined;
}

// The single-item per-kind write tools handled generically. Per-item attribute
// writes are intentionally NOT here — attributes use the dedicated batch tool
// `memory_set_attributes` (see below) because an entity naturally has many
// attributes at once, and one-item-per-call would penalize the granularity we
// want. memory_keep_loops/memory_close_loop/memory_set_attributes are handled separately.
const SINGLE_FACT_WRITE_KINDS = {
  memory_add_directive: "directive",
  memory_record_event: "event",
  memory_open_loop: "open_loop",
} as const satisfies Record<string, MemoryFactKind>;
type SingleFactWriteToolName = keyof typeof SINGLE_FACT_WRITE_KINDS;
type WriteToolName =
  | SingleFactWriteToolName
  | "memory_set_attributes"
  | "memory_keep_loops"
  | "memory_close_loop"
  | "memory_forget_attribute"
  | "memory_forget_directive";

const SINGLE_FACT_WRITE_DESCRIPTIONS: Record<SingleFactWriteToolName, string> =
  {
    memory_add_directive:
      'Record a standing rule for how you (the agent) must behave going forward — conduct, style, format, or process. Any durable behavioural policy counts, however phrased ("always …", "never …", or a plain declarative rule). One-off work for this turn is NOT a directive.',
    memory_record_event:
      "Record a point-in-time occurrence that belongs in a time-ordered log AND does not describe durable current state — e.g. a deploy shipped, a build/test failed, an approach was tried, a clue was revealed, a character moved. Append-only and recency-ranked. Most things are NOT events: if it is the current state of something (a value, status, preference, ownership, relationship), use memory_set_attributes instead. Test: would re-stating it later UPDATE a value (→ attribute) or ADD another log entry (→ event)?",
    memory_open_loop:
      "Open a NEW unresolved task, question, or thread to follow up on later. Use memory_keep_loops/memory_close_loop to maintain EXISTING loops; do not re-open one that already exists.",
  };

// memory_keep_loops / memory_close_loop act on EXISTING loops by handle, so their schemas are
// hand-written rather than derived from a fact kind.
const KEEP_LOOPS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["handles"],
  properties: {
    handles: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: { type: ["string", "integer"], minLength: 1, maxLength: 200 },
      description:
        "Handles ([id=...] from the packet — each loop's stable key or its integer id) of every presented open loop that is STILL live. Any presented loop you neither keep here nor close ages out and is auto-dropped.",
    },
  },
} as const;

const CLOSE_LOOP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["handle", "status"],
  properties: {
    handle: {
      type: ["string", "integer"],
      minLength: 1,
      maxLength: 200,
      description:
        "Handle ([id=...] from the packet — the loop's stable key or integer id) of the existing loop to retire.",
    },
    status: {
      type: "string",
      enum: ["resolved", "dropped"],
      description:
        '"resolved" = done/answered; "dropped" = abandoned/superseded.',
    },
    reason: {
      type: "string",
      maxLength: 2000,
      description: "Optional short reason.",
    },
  },
} as const;

const KEEP_LOOPS_EXAMPLE = { handles: ["loop.find_attic_key"] };
const CLOSE_LOOP_EXAMPLE = {
  handle: "loop.find_attic_key",
  status: "resolved",
};

// memory_forget_attribute / memory_forget_directive retire an EXISTING fact (tombstone it) when
// no natural supersede applies — e.g. after splitting a compound attribute into
// granular facts under new predicates the original predicate is never superseded,
// or the user explicitly retracted a trait/rule with no replacement. Targets are
// resolved against committed memory (not the staged buffer) the same way the
// commit path resolves them, so an unresolved handle is reported rather than
// silently staged as a no-op.
const FORGET_ATTRIBUTE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    handle: {
      type: ["string", "integer"],
      minLength: 1,
      maxLength: 200,
      description:
        "The attribute fact's [id=...] handle from the packet/search (its stable key or integer id). Provide this OR both entityKey and predicate.",
    },
    entityKey: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "The entity the attribute is on. Provide with `predicate` as an alternative to `handle`.",
    },
    predicate: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description:
        "The attribute predicate to forget on `entityKey`. Provide with `entityKey` as an alternative to `handle`.",
    },
  },
} as const;

const FORGET_DIRECTIVE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["handle"],
  properties: {
    handle: {
      type: ["string", "integer"],
      minLength: 1,
      maxLength: 200,
      description:
        "The directive fact's [id=...] handle from the packet (its stable key or integer id). Directives are global (no entityKey), so the handle is the only selector.",
    },
  },
} as const;

const FORGET_ATTRIBUTE_EXAMPLE = {
  entityKey: "character.mara",
  predicate: "description",
};
const FORGET_DIRECTIVE_EXAMPLE = { handle: "01J9Z0M5Q2K7V8N3B4C5D6E7F8" };

// Optional threading field advertised on every write tool: the model passes a
// prior rejection's `failureId` here when retrying that call. On success the id
// is cleared (the loop drops it from the outstanding set); on a repeat failure
// the SAME id is echoed back rather than minting a new one. Kept short (the id
// is `f1`,`f2`,… per run) so the echoed schema/example stays well under the
// tool-result truncation cap. Stripped from args before content validation, so
// it never reaches a fact schema with `additionalProperties:false`.
const FAILURE_ID_PROP = {
  type: "string",
  maxLength: 40,
  description:
    "Optional. When this call retries a write that was previously rejected, pass that rejection's `failureId` here. If the retry succeeds the failure is cleared; if it fails again the same id is returned. Omit on a first attempt.",
} as const;

// A remember_* tool advertises its fact kind's schema/example with the internal
// `kind` discriminator stripped — the tool name already fixes the kind.
function stripKind<
  T extends {
    properties: Record<string, unknown>;
    required?: readonly string[];
  },
>(
  schema: T,
): {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, unknown>;
} {
  const { kind: _kind, ...properties } = schema.properties;
  void _kind;
  return {
    type: "object",
    additionalProperties: false,
    required: (schema.required ?? []).filter((field) => field !== "kind"),
    properties,
  };
}

function stripKindExample(
  example: Record<string, unknown>,
): Record<string, unknown> {
  const { kind: _kind, ...rest } = example;
  void _kind;
  return rest;
}

// Optional paired-event fields layered onto each `memory_set_attributes` *item*
// (not the underlying attribute fact schema): when a state change is also a
// notable point-in-time occurrence, the model can log it in the same call
// instead of reaching for a separate memory_record_event (and losing the current
// state). These exist only at the tool boundary; the handler splits them off
// before validating the attribute, then stages a paired event fact.
const PAIRED_EVENT_PROPS = {
  event: {
    type: "string",
    minLength: 1,
    maxLength: 4000,
    description:
      "Optional. If this change is ALSO a notable point-in-time occurrence worth a timeline entry, a one-line summary of what happened. Leave unset for ordinary state — most attributes need no event.",
  },
  eventType: {
    type: "string",
    minLength: 1,
    maxLength: 100,
    description:
      'Optional category for the paired `event` (defaults to "change").',
  },
} as const;

// Default category for an attribute-paired event when the model supplies `event`
// but no explicit `eventType`.
const PAIRED_EVENT_DEFAULT_TYPE = "change";

// `memory_set_attributes` sets MANY attributes on ONE entity in a single call AND
// is the sole entity constructor: optional top-level `entityType`/`displayName`
// (+ optional `summary`/`metadata`) record the durable referent in the SAME
// call, so a brand-new entity can be typed, named, and described in one shot
// instead of a separate create-then-update. entityKey is hoisted to the top
// level (shared by every attribute item, so a batch can't straddle entities),
// and each item is a flat { predicate, value, … } object — an array of
// homogeneous flat objects, which weak backends handle far better than a union.
// Batching makes granularity cheap: the model splits a description into one item
// per trait instead of collapsing them into a single mega-value. `attributes` is
// optional (a metadata-only call just establishes/updates the referent), but a
// call must supply attributes and/or entity metadata.
const ATTRIBUTES_BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    entityKey: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "The referent ALL these attributes attach to (its canonical entityKey). Strongly preferred; required when setting entity metadata (entityType/displayName/summary/metadata); omit only for a genuinely entity-less attribute.",
    },
    entityType: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      description:
        "Optional and independent of displayName. The kind of referent, e.g. character, component, file, concept. Supply it to type a new entity or to change an existing one. On a NEW entity an omitted type is derived from the entityKey (e.g. character.mara → character); on an EXISTING entity an omitted type leaves the stored value unchanged. Requires entityKey.",
    },
    displayName: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Optional and independent of entityType. Human-readable name for the referent. Supply it to name a new entity or to rename an existing one. On a NEW entity an omitted name is derived from the entityKey (e.g. character.mara → Mara); on an EXISTING entity an omitted name leaves the stored value unchanged. Requires entityKey.",
    },
    summary: {
      type: "string",
      maxLength: 4000,
      description:
        "Optional one-line prose description (blurb) of the entity. Independent of entityType/displayName — you may set it alone on an existing entity. A prose blurb belongs here, NOT as a discrete attribute item.",
    },
    metadata: {
      description: "Optional arbitrary JSON metadata about the entity.",
    },
    attributes: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      description:
        'Optional. One item per DISTINCT trait or value. Split each detail into its own item — do not collapse several traits into one "description" value. Prose blurbs belong in the entity `summary`, not here. May be omitted for a metadata-only call that just establishes/updates the entity referent.',
      items: {
        type: "object",
        additionalProperties: false,
        required: ["predicate", "value"],
        properties: {
          predicate: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            description:
              'The property name for this single trait, e.g. "hair" or "language".',
          },
          value: { description: "The value for this trait (any JSON type)." },
          visibility: { type: "string", minLength: 1, maxLength: 100 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          ...PAIRED_EVENT_PROPS,
        },
      },
    },
  },
} as const;

const ATTRIBUTES_BATCH_EXAMPLE = {
  entityKey: "character.mara",
  entityType: "character",
  displayName: "Mara",
  attributes: [
    { predicate: "hair", value: "red" },
    { predicate: "build", value: "tall" },
    { predicate: "fears", value: "deep water" },
  ],
};

function writeToolParameters(tool: WriteToolName): Record<string, unknown> {
  if (tool === "memory_keep_loops") return KEEP_LOOPS_SCHEMA;
  if (tool === "memory_close_loop") return CLOSE_LOOP_SCHEMA;
  if (tool === "memory_forget_attribute") return FORGET_ATTRIBUTE_SCHEMA;
  if (tool === "memory_forget_directive") return FORGET_DIRECTIVE_SCHEMA;
  if (tool === "memory_set_attributes") return ATTRIBUTES_BATCH_SCHEMA;
  return stripKind(MEMORY_FACT_KIND_SCHEMAS[SINGLE_FACT_WRITE_KINDS[tool]]);
}

function writeToolExample(tool: WriteToolName): Record<string, unknown> {
  if (tool === "memory_keep_loops") return KEEP_LOOPS_EXAMPLE;
  if (tool === "memory_close_loop") return CLOSE_LOOP_EXAMPLE;
  if (tool === "memory_forget_attribute") return FORGET_ATTRIBUTE_EXAMPLE;
  if (tool === "memory_forget_directive") return FORGET_DIRECTIVE_EXAMPLE;
  if (tool === "memory_set_attributes") return ATTRIBUTES_BATCH_EXAMPLE;
  return stripKindExample(
    MEMORY_FACT_KIND_EXAMPLES[SINGLE_FACT_WRITE_KINDS[tool]],
  );
}

// The parameters ADVERTISED to the model: the tool's own schema plus the
// optional inbound `failureId` threading field. The base schemas are shared
// module-level singletons, so clone before layering the field on (never mutate
// them). The rejection envelope's `expected.schema` deliberately uses the bare
// schema (no failureId) to keep that echoed payload lean under truncation.
function advertisedWriteToolParameters(
  tool: WriteToolName,
): Record<string, unknown> {
  const base = writeToolParameters(tool);
  const baseProps = (base.properties ?? {}) as Record<string, unknown>;
  return { ...base, properties: { ...baseProps, failureId: FAILURE_ID_PROP } };
}

// Map raw Zod issues to the model-facing WriteIssue shape, dropping a leading
// path segment (e.g. `facts.0.`) so the field name is what the model actually
// sent rather than an internal fragment path.
function zodToWriteIssues(error: ZodError, stripPrefix?: string): WriteIssue[] {
  return error.issues.map((issue) => {
    let field = issue.path.join(".");
    if (stripPrefix && field.startsWith(stripPrefix))
      field = field.slice(stripPrefix.length);
    return {
      field: field || undefined,
      code: issue.code,
      message: issue.message,
      hint: hintForIssue(issue),
    };
  });
}

// One `memory_set_attributes` item validates an attribute fact (facts.0) plus,
// when a paired event is present, an event fact (facts.1). Strip the `facts.<n>.`
// prefix and rename the event fact's `summary` back to the item's `event` field
// so issues name what the model actually sent.
function attributeItemWriteIssues(error: ZodError): WriteIssue[] {
  return error.issues.map((issue) => {
    let field = issue.path.join(".").replace(/^facts\.\d+\./, "");
    if (field === "summary") field = "event";
    return {
      field: field || undefined,
      code: issue.code,
      message: issue.message,
      hint: hintForIssue(issue),
    };
  });
}

function semanticToWriteIssues(
  issues: Array<{
    severity: "info" | "warning" | "error";
    code: string;
    message: string;
  }>,
): WriteIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    hint: issue.message,
  }));
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
  keys: string[],
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
  let forgotten = 0;
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
    forgotten += patch.forgetFacts?.length ?? 0;
  }
  return {
    entities,
    attributes,
    directives,
    events,
    loops,
    keptLoops,
    closedLoops,
    forgotten,
  };
}

function writeSuccess(
  tool: WriteToolName,
  action: "created" | "kept" | "closed" | "forgotten",
  accepted: unknown,
  totals: Record<string, number>,
  warnings: WriteIssue[],
  extra: Record<string, unknown> = {},
  noteOverride?: string,
): string {
  return JSON.stringify({
    ok: true,
    tool,
    action,
    accepted,
    ...(warnings.length ? { issues: warnings } : {}),
    staged_totals: totals,
    ...extra,
    note:
      noteOverride ??
      "Staged. Call another write tool to record more, or stop when nothing durable remains. Nothing commits until you finish.",
  });
}

// Order-independent serialization of a write call's arguments, used as the
// signature for duplicate-call detection: object keys are emitted sorted (at
// every depth) so two calls that differ only in key order — common when a model
// regenerates the "same" arguments — collapse to one signature. Arrays keep
// their order (a reordered attribute list is a different intent).
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

// Canonical signature for an active stored fact, matching how commit dedupes:
// entityKey + predicate + the value serialized exactly as `safeJson` stores it
// (`JSON.stringify(value ?? null)`) + visibility + confidence. A re-assertion
// that produces this same signature supersedes the prior identical observation
// in place and changes nothing the user can observe, so handlers can flag it as
// redundant. visibility/confidence are part of the signature because re-asserting
// the SAME value with a DIFFERENT visibility/confidence is a real change (commit
// makes the new row active, carrying the new fields) — dropping it would silently
// discard e.g. a secret being promoted to hidden visibility. Defaults are
// normalized to match `addFact` (`visibility ?? 'session'`, `confidence ?? 1`) so
// an unset staged field compares equal to the stored default.
export function factSignature(
  entityKey: string | undefined,
  predicate: string,
  value: unknown,
  visibility?: string | undefined,
  confidence?: number | undefined,
): string {
  let valueJson: string;
  try {
    valueJson = JSON.stringify(value ?? null);
  } catch {
    valueJson = JSON.stringify(String(value));
  }
  const vis = visibility ?? "session";
  const conf = confidence ?? 1;
  return `${entityKey ?? ""}\u0000${predicate}\u0000${valueJson}\u0000${vis}\u0000${conf}`;
}

// Build the set of signatures for every attribute/directive fact already active
// in the turn's initial packet. Re-asserting one of these supersedes the prior
// identical observation in place at commit (see `consolidateFactGroup`) and
// changes nothing observable, so threading this set into the write handlers lets
// them give corrective "already stored, unchanged" feedback instead of a plain
// success — the cross-turn analogue of the same-run duplicate nudge.
export function buildStoredFactSignatures(
  packet: TurnMemoryPacket | undefined,
): Set<string> {
  const signatures = new Set<string>();
  if (!packet) return signatures;
  const keyById = packet.entityKeyById ?? {};
  const add = (facts: TurnMemoryPacket["facts"] | undefined) => {
    for (const fact of facts ?? []) {
      const entityKey = fact.entityId ? (keyById[fact.entityId] ?? "") : "";
      signatures.add(
        factSignature(
          entityKey,
          fact.predicate,
          fact.value,
          fact.visibility,
          fact.confidence,
        ),
      );
    }
  };
  add(packet.facts);
  add(packet.directives);
  return signatures;
}

// When a write call exactly repeats one already made this turn, fold a nudge
// into its result envelope so the model sees — in the very feedback it self-
// corrects against — that it is looping. The nudge adapts to the outcome:
// repeating a *successful* stage records nothing new, while repeating a
// *failing* call will keep failing identically. `repeatCount` is the number of
// times these exact arguments have now been sent (2 on the first repeat).
function annotateDuplicateCall(
  result: string,
  tool: WriteToolName,
  repeatCount: number,
): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result) as Record<string, unknown>;
  } catch {
    // Non-JSON envelope (shouldn't happen for write tools); leave as-is.
    return result;
  }
  const succeeded = parsed.ok === true;
  const nudge = succeeded
    ? `You have already made this exact ${tool} call this turn (${repeatCount} times now). It was staged the first time, so repeating it records nothing new and nothing commits twice. Do NOT call it again — record different durable memory, or stop if nothing durable remains.`
    : `You have now sent these exact ${tool} arguments ${repeatCount} times and they keep failing the same way. Retrying them unchanged will not help — change the arguments to fix the issues above, switch to a different durable memory, or stop.`;
  parsed.duplicate = { repeatCount };
  parsed.note =
    typeof parsed.note === "string" ? `${nudge} ${parsed.note}` : nudge;
  return JSON.stringify(parsed);
}

function writeError(
  tool: WriteToolName,
  kind: "validation" | "execution",
  code: string,
  message: string,
  issues: WriteIssue[],
  received: unknown,
  totals: Record<string, number>,
  extra: Record<string, unknown> = {},
  noteOverride?: string,
): string {
  const note =
    noteOverride ??
    (kind === "execution"
      ? `Could not run: ${message} Read each issue's \`hint\`, then call ${tool} again with valid arguments. Nothing already staged was lost.`
      : `Not staged. Fix the fields in \`issues\` (each has a \`hint\`), copy the shape in \`expected.example\`, then call ${tool} again. Nothing already staged was lost; nothing commits until you finish.`);
  return JSON.stringify({
    ok: false,
    tool,
    error: { kind, code, message },
    issues,
    expected: {
      schema: writeToolParameters(tool),
      example: writeToolExample(tool),
    },
    received,
    staged_totals: totals,
    ...extra,
    note,
  });
}

/**
 * The durable-write tool specs advertised to the extractor: memory_set_attributes
 * (the entity constructor + a batch of traits on one entity), the single-item
 * memory_add_directive/event/loop creators, and memory_keep_loops/memory_close_loop for
 * open-loop lifecycle. Each has a flat schema (at most an array of flat objects)
 * so even backends with weak tool-argument grammar enforcement can fill it — no
 * union.
 */
export function buildWriteToolSpecs(): ExtractorToolSpec[] {
  const singleFactWrites = (
    Object.keys(SINGLE_FACT_WRITE_KINDS) as SingleFactWriteToolName[]
  ).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool,
      description: SINGLE_FACT_WRITE_DESCRIPTIONS[tool],
      parameters: advertisedWriteToolParameters(tool),
    },
  }));
  return [
    ...singleFactWrites,
    {
      type: "function",
      function: {
        name: "memory_set_attributes",
        description:
          'Record a durable entity and/or things to KNOW about it in ONE call — its current state, traits, values, relationships, preferences, constraints, ownership, roles, deadlines, or identifiers. Pass the shared entityKey once at the top level. `entityType` and `displayName` are each optional and INDEPENDENT — supply any subset. To record a new referent you may pass either, both, or neither: a field you omit is derived from the entityKey (character.mara → type character, name Mara), so the entity still gets a sensible type and name. For an existing referent, supply only the fields you are changing — an omitted field leaves the stored value unchanged (you can rename without re-sending the type, retype without re-sending the name, or update just the `summary`). Put discrete traits in the `attributes` array with ONE item per distinct trait — always decompose: "a tall woman with red hair who fears water" becomes separate items (build=tall, hair=red, fears=water), never one big "description" value (a prose blurb belongs in `summary`). `attributes` may be omitted for a metadata-only call that just establishes/updates the entity. An attribute item may carry an optional `event` summary (+ optional `eventType`) when that particular change is also a notable timeline occurrence.',
        parameters: advertisedWriteToolParameters("memory_set_attributes"),
      },
    },
    {
      type: "function",
      function: {
        name: "memory_keep_loops",
        description:
          "Keep one or more EXISTING open loops alive (anti-aging) by handle. Pass the handle of every presented loop that is still live; any you omit ages out. Batch them in a single call.",
        parameters: advertisedWriteToolParameters("memory_keep_loops"),
      },
    },
    {
      type: "function",
      function: {
        name: "memory_close_loop",
        description:
          'Retire one EXISTING open loop by handle: status "resolved" when done/answered, "dropped" when abandoned or superseded (e.g. an option the user did not choose).',
        parameters: advertisedWriteToolParameters("memory_close_loop"),
      },
    },
    {
      type: "function",
      function: {
        name: "memory_forget_attribute",
        description:
          'Retire (tombstone) an EXISTING attribute fact that has no natural supersede. Use ONLY in two cases: (a) after you split a compound attribute into granular facts under NEW predicates (e.g. a single description="tall, red hair, fears water" replaced by build/hair/fears) — forget the original compound predicate, which nothing superseded; or (b) the user EXPLICITLY retracted a trait with no replacement. Otherwise prefer supersede: re-asserting the same entityKey+predicate via memory_set_attributes retires the old value automatically — do NOT forget just to tidy. Target by `handle` (the fact\'s [id=...]) OR by `entityKey`+`predicate`.',
        parameters: advertisedWriteToolParameters("memory_forget_attribute"),
      },
    },
    {
      type: "function",
      function: {
        name: "memory_forget_directive",
        description:
          "Retire (tombstone) an EXISTING directive the user EXPLICITLY retracted with no replacement, by its [id=...] handle. When the user instead OVERRIDES a rule, record the replacement with memory_add_directive rather than forgetting. Never forget a directive merely to tidy.",
        parameters: advertisedWriteToolParameters("memory_forget_directive"),
      },
    },
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
  conversationId: number;
  mode: MemoryMode;
  /** Open loops presented to the extractor this turn (for handle validation). */
  presentedLoops: Array<{ id: number; loopKey: string }>;
  /**
   * Signatures (entityKey+predicate+value) of attribute/directive facts already
   * active in the initial packet. Re-asserting one stores nothing new, so the
   * attribute handler flags it as redundant instead of returning a plain
   * success. Built via {@link buildStoredFactSignatures}; omit for no checking.
   */
  storedFactSignatures?: Set<string> | undefined;
  /** Shared staging buffer; handlers push accepted normalized patch fragments. */
  staged: MemoryPatchProposal[];
  /** Invoked once per write-tool call (telemetry: total propose calls). */
  onProposeCall: () => void;
  /** Invoked when a write-tool call is rejected (telemetry: rejected count). */
  onReject: () => void;
  /**
   * Invoked once per attribute item that was skipped because its value is
   * already stored unchanged (telemetry: redundant re-records). Lets the
   * extractor quantify wasted focus before/after the prompt + feedback nudges.
   */
  onRedundant?: (() => void) | undefined;
}

/**
 * Build the durable-write tool handler map for one extraction run. Each handler
 * validates with `MemoryPatchInputSchema` + `validatePatch`, stages the
 * normalized fragment into `deps.staged`, and returns a JSON envelope.
 */
export function createWriteToolHandlers(
  deps: WriteToolDeps,
): Map<string, (args: unknown) => Promise<string>> {
  const { conversationId, mode, presentedLoops, staged } = deps;
  const isPresentedHandle = (handle: string | number): boolean =>
    presentedLoops.some(
      (loop) =>
        String(loop.id) === String(handle) || loop.loopKey === String(handle),
    );

  // memory_add_directive / memory_record_event / memory_open_loop. Each maps to a single
  // fact kind: build a one-item fragment with the kind injected, validate it
  // with MemoryPatchInputSchema (canonical input), normalize that into the
  // internal patch the commit path consumes (same code, no schema drift), and
  // stage it. A bad call stages nothing, so a correction replaces it rather
  // than duplicating. (Attributes use the dedicated batch handler below.)
  const handleSingleFactWrite =
    (tool: SingleFactWriteToolName) =>
    async (rawArgs: unknown): Promise<string> => {
      deps.onProposeCall();
      const kind = SINGLE_FACT_WRITE_KINDS[tool];
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const parsed = MemoryPatchInputSchema.safeParse({
        facts: [{ kind, ...args }],
      });
      if (!parsed.success) {
        deps.onReject();
        return writeError(
          tool,
          "validation",
          "schema_invalid",
          `Arguments for ${tool} did not match its schema.`,
          zodToWriteIssues(parsed.error, "facts.0."),
          args,
          stagedTotals(staged),
        );
      }
      const internal = normalizeMemoryPatchInput(parsed.data);
      const validation = validatePatch(internal, { conversationId, mode });
      const errors = validation.issues.filter(
        (issue) => issue.severity === "error",
      );
      if (errors.length) {
        deps.onReject();
        return writeError(
          tool,
          "validation",
          "semantic_invalid",
          `Arguments for ${tool} are well-formed but not acceptable.`,
          semanticToWriteIssues(errors),
          args,
          stagedTotals(staged),
        );
      }
      staged.push(internal);
      // Canonical input echo: the parsed fact with its `kind` discriminator
      // removed (the tool name already fixes the kind).
      const canonical = dropKeys(parsed.data.facts![0], ["kind"]);
      return writeSuccess(
        tool,
        "created",
        canonical,
        stagedTotals(staged),
        semanticToWriteIssues(
          validation.issues.filter((issue) => issue.severity !== "error"),
        ),
      );
    };

  // memory_set_attributes: the sole entity constructor AND the batch attribute
  // writer. Optional top-level entity metadata (entityType/displayName/summary/
  // metadata) records the durable referent in the SAME call; entityKey is
  // hoisted (shared by every attribute item). The entity is a WHOLE-CALL gate:
  // if metadata is present but invalid, nothing stages (including attributes).
  // A valid entity stages, then each attribute item is validated INDEPENDENTLY
  // so one malformed trait can't sink the batch — valid items stage and invalid
  // ones are reported by index (partial acceptance, like memory_keep_loops). Each item
  // may carry an optional paired event (`event` + optional `eventType`), staged
  // as a sibling event fact. `attributes` may be omitted for a metadata-only
  // call; a call must supply attributes and/or entity metadata.
  const handleSetAttributes = async (rawArgs: unknown): Promise<string> => {
    deps.onProposeCall();
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const topEntityKey =
      typeof args.entityKey === "string" ? args.entityKey : undefined;
    const hasEntityMeta =
      args.entityType !== undefined ||
      args.displayName !== undefined ||
      args.summary !== undefined ||
      args.metadata !== undefined;
    const items = args.attributes;
    const itemList = Array.isArray(items) ? items : [];

    // `attributes`, if given, must be an array. A non-array (e.g. a string) is
    // a schema error regardless of entity metadata.
    if (items !== undefined && !Array.isArray(items)) {
      deps.onReject();
      return writeError(
        "memory_set_attributes",
        "validation",
        "schema_invalid",
        "`attributes` must be an array of { predicate, value } items.",
        [
          {
            field: "attributes",
            code: "invalid_attributes",
            message: "`attributes` must be an array.",
            hint: "Provide one item per distinct trait, each with a predicate and value.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }

    // A call must do something: stage at least one attribute and/or record
    // entity metadata. An empty/absent attributes array with no metadata is a
    // no-op the model should not be making.
    if (itemList.length === 0 && !hasEntityMeta) {
      deps.onReject();
      return writeError(
        "memory_set_attributes",
        "validation",
        "schema_invalid",
        "Provide a non-empty `attributes` array and/or entity metadata (entityType, displayName, summary, or metadata).",
        [
          {
            field: "attributes",
            code: "empty_call",
            message: "Nothing to record: no attributes and no entity metadata.",
            hint: "Add attribute items, and/or set any of entityType, displayName, summary, or metadata to record the entity.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }

    // Entity metadata is a whole-call gate: validate it BEFORE staging any
    // attribute so an invalid entity rejects the entire call (nothing staged).
    // entityType and displayName are each independently optional (an omitted
    // field is derived from the key for a new entity, or preserved for an
    // existing one); summary/metadata are optional too. An entity needs a key
    // to attach to.
    let entityPatch: MemoryPatchProposal | undefined;
    let entityCanonical: Record<string, unknown> | undefined;
    if (hasEntityMeta) {
      if (!topEntityKey) {
        deps.onReject();
        return writeError(
          "memory_set_attributes",
          "validation",
          "schema_invalid",
          "Entity metadata (entityType/displayName/summary/metadata) requires `entityKey`.",
          [
            {
              field: "entityKey",
              code: "missing_entity_key",
              message:
                "`entityKey` is required when recording entity metadata.",
              hint: "Provide the referent\u2019s canonical entityKey (e.g. character.mara).",
            },
          ],
          args,
          stagedTotals(staged),
        );
      }
      const entityInput = {
        entityKey: topEntityKey,
        ...(args.entityType !== undefined
          ? { entityType: args.entityType }
          : {}),
        ...(args.displayName !== undefined
          ? { displayName: args.displayName }
          : {}),
        ...(args.summary !== undefined ? { summary: args.summary } : {}),
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      };
      const parsed = MemoryPatchInputSchema.safeParse({
        entities: [entityInput],
      });
      if (!parsed.success) {
        deps.onReject();
        return writeError(
          "memory_set_attributes",
          "validation",
          "schema_invalid",
          "Entity metadata did not match its schema.",
          zodToWriteIssues(parsed.error, "entities.0."),
          args,
          stagedTotals(staged),
        );
      }
      const entityInternal = normalizeMemoryPatchInput(parsed.data);
      const entityValidation = validatePatch(entityInternal, {
        conversationId,
        mode,
      });
      const entityErrors = entityValidation.issues.filter(
        (issue) => issue.severity === "error",
      );
      if (entityErrors.length) {
        deps.onReject();
        return writeError(
          "memory_set_attributes",
          "validation",
          "semantic_invalid",
          "Entity metadata is well-formed but not acceptable.",
          semanticToWriteIssues(entityErrors),
          args,
          stagedTotals(staged),
        );
      }
      entityPatch = entityInternal;
      // Canonical echo of the entity, minus the hoisted entityKey (merged back
      // into the top-level `accepted` shape alongside the attributes).
      entityCanonical = dropKeys(parsed.data.entities![0], ["entityKey"]);
    }

    const acceptedPatches: MemoryPatchProposal[] = [];
    const acceptedItems: Record<string, unknown>[] = [];
    const results: Array<Record<string, unknown>> = [];
    const failureIssues: WriteIssue[] = [];
    let pairedEvents = 0;
    let redundantCount = 0;

    for (let i = 0; i < itemList.length; i += 1) {
      const raw = (itemList[i] ?? {}) as Record<string, unknown>;
      const { event, eventType, ...attr } = raw;
      const fail = (issues: WriteIssue[]) => {
        results.push({ index: i, staged: false, issues });
        for (const issue of issues) {
          failureIssues.push({
            ...issue,
            field: `attributes.${i}.${issue.field ?? ""}`.replace(/\.$/, ""),
          });
        }
      };

      if (
        !(typeof event === "string" && event.trim()) &&
        eventType !== undefined
      ) {
        fail([
          {
            field: "eventType",
            code: "event_type_without_event",
            message:
              "`eventType` only applies when a paired `event` summary is given.",
            hint: "Provide an `event` summary too, or omit `eventType`.",
          },
        ]);
        continue;
      }

      const factItems: Record<string, unknown>[] = [
        {
          kind: "attribute",
          ...(topEntityKey ? { entityKey: topEntityKey } : {}),
          ...attr,
        },
      ];
      let itemPaired = false;
      if (typeof event === "string" && event.trim()) {
        itemPaired = true;
        factItems.push({
          kind: "event",
          eventType:
            typeof eventType === "string" && eventType.trim()
              ? eventType
              : PAIRED_EVENT_DEFAULT_TYPE,
          summary: event,
          ...(topEntityKey ? { entityKey: topEntityKey } : {}),
        });
      }

      const parsed = MemoryPatchInputSchema.safeParse({ facts: factItems });
      if (!parsed.success) {
        fail(attributeItemWriteIssues(parsed.error));
        continue;
      }
      const internal = normalizeMemoryPatchInput(parsed.data);
      const validation = validatePatch(internal, { conversationId, mode });
      const errors = validation.issues.filter(
        (issue) => issue.severity === "error",
      );
      if (errors.length) {
        fail(semanticToWriteIssues(errors));
        continue;
      }
      // Cross-turn redundancy: if this exact entityKey+predicate+value (and
      // visibility/confidence) is already active in the initial packet,
      // re-asserting it changes nothing observable — commit supersedes the
      // prior identical observation in place. Skip it and give corrective
      // feedback — the cross-turn analogue of the same-run duplicate nudge. A
      // *changed* value (or a changed visibility/confidence) yields a different
      // signature and still stages (it supersedes). An item carrying a paired
      // `event` is exempt: the event is a fresh append-only timeline entry even
      // when the attribute is unchanged. Sign with the NORMALIZED staged fact
      // (`internal.facts[0]`), not the raw item + hoisted key: an item may
      // carry its own `entityKey` that overrides the batch key, so
      // `topEntityKey` could point at the wrong entity and falsely skip a
      // genuinely-new fact.
      const attrFact = internal.facts?.[0];
      if (
        !itemPaired &&
        attrFact &&
        deps.storedFactSignatures?.has(
          factSignature(
            attrFact.entityKey,
            attrFact.predicate,
            attrFact.value,
            attrFact.visibility,
            attrFact.confidence,
          ),
        )
      ) {
        redundantCount += 1;
        deps.onRedundant?.();
        results.push({
          index: i,
          staged: false,
          unchanged: true,
          note: "Already stored with this exact value in the initial packet; skipped (nothing new to record).",
        });
        continue;
      }
      acceptedPatches.push(internal);
      // Canonical input echo: the parsed attribute item (kind + the hoisted
      // entityKey removed) plus, if paired, the normalized event summary and
      // its eventType — including the defaulted "change" — folded back into
      // the single tool-input item shape.
      const attrItem = dropKeys(parsed.data.facts![0], ["kind", "entityKey"]);
      if (itemPaired) {
        const evFact = parsed.data.facts![1] as {
          summary?: unknown;
          eventType?: unknown;
        };
        attrItem.event = evFact.summary;
        attrItem.eventType = evFact.eventType;
      }
      acceptedItems.push(attrItem);
      if (itemPaired) pairedEvents += 1;
      results.push({ index: i, staged: true });
    }

    // Stage the entity first (it gated the whole call), then the accepted
    // attribute patches. A whole-call rejection above returned before reaching
    // here, so nothing partial is staged for an invalid entity.
    if (entityPatch) staged.push(entityPatch);
    for (const patch of acceptedPatches) staged.push(patch);
    const extra: Record<string, unknown> = { results };
    if (entityCanonical)
      extra.entity = { entityKey: topEntityKey, ...entityCanonical };
    if (pairedEvents) extra.pairedEvents = pairedEvents;
    if (redundantCount) extra.unchanged = redundantCount;

    if (failureIssues.length) {
      deps.onReject();
      // Redundant (unchanged) items are not failures — they staged nothing on
      // purpose — so exclude them from the "not staged" failure count.
      const failed = results.filter(
        (result) => !result.staged && !result.unchanged,
      ).length;
      return writeError(
        "memory_set_attributes",
        "validation",
        "batch_partial",
        `${failed} of ${itemList.length} attribute(s) were not staged.`,
        failureIssues,
        args,
        stagedTotals(staged),
        extra,
        `Staged the valid attribute(s)${entityCanonical ? " and the entity" : ""}; the items in \`results\` with "staged": false were NOT. Re-send ONLY those items (corrected), without the entity metadata — do not resend the whole batch, or the already-staged items would be duplicated.`,
      );
    }
    // The merged canonical echo: the hoisted entityKey, any entity metadata, and
    // the accepted attribute items, folded back into the single tool-input shape.
    // Echo `attributes` only when the caller actually supplied trait items (a
    // non-empty array) — a metadata-only call, or an empty `attributes: []`
    // alongside entity metadata, omits the key entirely. (When items were sent
    // but all proved redundant, acceptedItems is [] and we still echo [].)
    const accepted: Record<string, unknown> = {
      ...(topEntityKey ? { entityKey: topEntityKey } : {}),
      ...(entityCanonical ?? {}),
      ...(itemList.length > 0 ? { attributes: acceptedItems } : {}),
    };
    // When every attribute item was already stored unchanged (and no entity
    // metadata was recorded), nothing was staged: return a clear "already
    // stored" note instead of a plain success so the model learns to stop
    // re-asserting values present in the initial packet.
    const redundantNote = redundantCount
      ? acceptedItems.length === 0 && !entityCanonical
        ? `Every attribute you sent is already stored with that exact value (see the initial packet) — nothing new was recorded. Do not re-assert unchanged values; record only new or changed facts, or stop if nothing durable remains.`
        : `Staged the new/changed item(s). ${redundantCount} attribute(s) were already stored unchanged and were skipped — do not re-assert values already shown in the initial packet. Nothing commits until you finish.`
      : undefined;
    return writeSuccess(
      "memory_set_attributes",
      "created",
      accepted,
      stagedTotals(staged),
      [],
      extra,
      redundantNote,
    );
  };

  // memory_keep_loops: batch anti-aging reaffirm. Only handles for loops actually
  // presented this turn are staged; unknown handles are reported per-handle so
  // the model can correct them (partial success is first-class).
  const handleKeepLoops = async (rawArgs: unknown): Promise<string> => {
    deps.onProposeCall();
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const handles = args.handles;
    const isValidHandle = (handle: unknown): boolean =>
      (typeof handle === "string" && handle.length > 0) ||
      (typeof handle === "number" && Number.isInteger(handle) && handle > 0);
    if (
      !Array.isArray(handles) ||
      handles.length === 0 ||
      !handles.every(isValidHandle)
    ) {
      deps.onReject();
      return writeError(
        "memory_keep_loops",
        "validation",
        "schema_invalid",
        "`handles` must be a non-empty array of open-loop handle strings.",
        [
          {
            field: "handles",
            code: "invalid_handles",
            message: "`handles` must be a non-empty array of strings.",
            hint: "Pass the [id=...] handle of each still-live presented loop.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }
    const known: Array<string | number> = [];
    const unknown: Array<string | number> = [];
    const results = (handles as Array<string | number>).map((handle) => {
      const kept = isPresentedHandle(handle);
      (kept ? known : unknown).push(handle);
      return {
        handle,
        kept,
        ...(kept
          ? {}
          : { hint: "Not a presented open loop; see memory_get_open_loops." }),
      };
    });
    if (known.length) staged.push({ keepOpenLoops: known });
    if (unknown.length) {
      deps.onReject();
      return writeError(
        "memory_keep_loops",
        "execution",
        "unknown_handles",
        `${unknown.length} of ${handles.length} handle(s) are not presented open loops.`,
        unknown.map((handle) => ({
          field: "handles",
          code: "unknown_handle",
          message: `Unknown loop handle: ${handle}`,
          hint: "Call memory_get_open_loops to list valid handles.",
        })),
        args,
        stagedTotals(staged),
        { results },
      );
    }
    return writeSuccess(
      "memory_keep_loops",
      "kept",
      { handles: known },
      stagedTotals(staged),
      [],
      {
        results,
      },
    );
  };

  // memory_close_loop: retire one existing loop. Existence is checked via the same
  // key-or-id resolution validatePatch uses; an unresolved handle is surfaced
  // as an execution error (not silently staged as a no-op).
  const handleCloseLoop = async (rawArgs: unknown): Promise<string> => {
    deps.onProposeCall();
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const parsed = MemoryPatchInputSchema.safeParse({
      closeLoops: [
        { id: args.handle, status: args.status, reason: args.reason },
      ],
    });
    if (!parsed.success) {
      deps.onReject();
      const issues = zodToWriteIssues(parsed.error, "closeLoops.0.").map(
        (issue) =>
          issue.field === "id" ? { ...issue, field: "handle" } : issue,
      );
      return writeError(
        "memory_close_loop",
        "validation",
        "schema_invalid",
        "Arguments for memory_close_loop did not match its schema.",
        issues,
        args,
        stagedTotals(staged),
      );
    }
    const internal = normalizeMemoryPatchInput(parsed.data);
    const validation = validatePatch(internal, { conversationId, mode });
    const unknown = validation.issues.find(
      (issue) => issue.code === "open_loop_resolution_unknown_id",
    );
    if (unknown) {
      deps.onReject();
      return writeError(
        "memory_close_loop",
        "execution",
        "unknown_loop",
        `No open loop matches handle "${String(args.handle)}".`,
        [
          {
            field: "handle",
            code: "unknown_loop",
            message: unknown.message,
            hint: "Call memory_get_open_loops to list valid handles.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }
    const errors = validation.issues.filter(
      (issue) => issue.severity === "error",
    );
    if (errors.length) {
      deps.onReject();
      return writeError(
        "memory_close_loop",
        "validation",
        "semantic_invalid",
        "memory_close_loop arguments are well-formed but not acceptable.",
        semanticToWriteIssues(errors),
        args,
        stagedTotals(staged),
      );
    }
    staged.push(internal);
    // Canonical input echo: map the internal `id` field back to the tool's
    // `handle` field.
    const cl = parsed.data.closeLoops![0];
    const canonical: Record<string, unknown> = {
      handle: cl.id,
      status: cl.status,
    };
    if (cl.reason !== undefined) canonical.reason = cl.reason;
    return writeSuccess(
      "memory_close_loop",
      "closed",
      canonical,
      stagedTotals(staged),
      semanticToWriteIssues(
        validation.issues.filter((issue) => issue.severity !== "error"),
      ),
    );
  };

  // memory_forget_attribute: retire an existing ATTRIBUTE fact, addressed by handle
  // ([id=...]) or by entityKey+predicate. Resolution runs against committed
  // memory the same way commitPatch resolves it (re-checked again at commit, so
  // a handle a sibling call deletes this turn is skipped there too). Two
  // guardrails keep it attribute-only: a `predicate` of `directive` is refused
  // up front, and a handle that resolves to a directive fact is refused with a
  // redirect to memory_forget_directive.
  const handleForgetAttribute = async (rawArgs: unknown): Promise<string> => {
    deps.onProposeCall();
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const handle: string | number | undefined =
      typeof args.handle === "string" && args.handle.trim()
        ? args.handle.trim()
        : typeof args.handle === "number" &&
            Number.isInteger(args.handle) &&
            args.handle > 0
          ? args.handle
          : undefined;
    const entityKey =
      typeof args.entityKey === "string" && args.entityKey.trim()
        ? args.entityKey.trim()
        : undefined;
    const predicate =
      typeof args.predicate === "string" && args.predicate.trim()
        ? args.predicate.trim()
        : undefined;
    if (!handle && !(entityKey && predicate)) {
      deps.onReject();
      return writeError(
        "memory_forget_attribute",
        "validation",
        "schema_invalid",
        "Provide either `handle` (the fact's [id=...]) or BOTH `entityKey` and `predicate`.",
        [
          {
            field: "handle",
            code: "missing_selector",
            message: "No target selector was given.",
            hint: "Pass `handle`, or pass both `entityKey` and `predicate`.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }
    if (predicate && isDirectivePredicate(predicate)) {
      deps.onReject();
      return writeError(
        "memory_forget_attribute",
        "execution",
        "is_directive",
        "That predicate names a directive, not an attribute.",
        [
          {
            field: "predicate",
            code: "is_directive",
            message: "Directives are retired with memory_forget_directive.",
            hint: "Call memory_forget_directive with the directive's [id=...] handle instead.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }
    const target = handle ? { factId: handle } : { entityKey, predicate };
    const resolved = resolveForgetTarget(conversationId, target);
    if (!resolved) {
      deps.onReject();
      return writeError(
        "memory_forget_attribute",
        "execution",
        "unknown_fact",
        handle
          ? `No active fact matches handle "${handle}".`
          : `No active attribute "${predicate}" on ${entityKey}.`,
        [
          {
            field: handle ? "handle" : "predicate",
            code: "unknown_fact",
            message: "The forget target did not resolve to an active fact.",
            hint: "Check the packet/search for the fact's [id=...], or that entityKey+predicate is active.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }
    if (resolved.isDirective) {
      deps.onReject();
      return writeError(
        "memory_forget_attribute",
        "execution",
        "is_directive",
        "That handle points to a directive, not an attribute.",
        [
          {
            field: "handle",
            code: "is_directive",
            message: "Directives are retired with memory_forget_directive.",
            hint: "Call memory_forget_directive with this [id=...] handle instead.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }
    staged.push({ forgetFacts: [target] });
    const canonical: Record<string, unknown> = handle
      ? { handle }
      : { entityKey, predicate };
    return writeSuccess(
      "memory_forget_attribute",
      "forgotten",
      canonical,
      stagedTotals(staged),
      [],
    );
  };

  // memory_forget_directive: retire an existing DIRECTIVE fact by handle only
  // (directives are global, sharing the reserved `directive` predicate, so the
  // [id=...] handle is the sole selector). A handle that resolves to a
  // non-directive fact is refused with a redirect to memory_forget_attribute.
  const handleForgetDirective = async (rawArgs: unknown): Promise<string> => {
    deps.onProposeCall();
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const handle: string | number | undefined =
      typeof args.handle === "string" && args.handle.trim()
        ? args.handle.trim()
        : typeof args.handle === "number" &&
            Number.isInteger(args.handle) &&
            args.handle > 0
          ? args.handle
          : undefined;
    if (!handle) {
      deps.onReject();
      return writeError(
        "memory_forget_directive",
        "validation",
        "schema_invalid",
        "`handle` is required — the directive fact's [id=...] handle.",
        [
          {
            field: "handle",
            code: "missing_handle",
            message: "`handle` is required.",
            hint: "Pass the directive's [id=...] handle from the packet.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }
    const resolved = resolveForgetTarget(conversationId, { factId: handle });
    if (!resolved) {
      deps.onReject();
      return writeError(
        "memory_forget_directive",
        "execution",
        "unknown_fact",
        `No active fact matches handle "${handle}".`,
        [
          {
            field: "handle",
            code: "unknown_fact",
            message: "The handle did not resolve to an active fact.",
            hint: "Check the packet for the directive's [id=...] handle.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }
    if (!resolved.isDirective) {
      deps.onReject();
      return writeError(
        "memory_forget_directive",
        "execution",
        "not_directive",
        "That handle points to an attribute, not a directive.",
        [
          {
            field: "handle",
            code: "not_directive",
            message: "Attributes are retired with memory_forget_attribute.",
            hint: "Call memory_forget_attribute with this handle (or entityKey+predicate) instead.",
          },
        ],
        args,
        stagedTotals(staged),
      );
    }
    staged.push({ forgetFacts: [{ factId: handle }] });
    return writeSuccess(
      "memory_forget_directive",
      "forgotten",
      { handle },
      stagedTotals(staged),
      [],
    );
  };

  // Per-run signature -> times-seen counter. A tool-calling extractor can get
  // stuck re-issuing the same write (e.g. the same attributes on one entity)
  // every iteration; tracking exact-argument repeats lets us fold a nudge into
  // the result so the model notices it is looping and either moves on or stops.
  const writeCallCounts = new Map<string, number>();
  const withDuplicateNudge =
    (tool: WriteToolName, handler: (args: unknown) => Promise<string>) =>
    async (args: unknown): Promise<string> => {
      const result = await handler(args);
      const signature = `${tool}:${stableStringify(args)}`;
      const count = (writeCallCounts.get(signature) ?? 0) + 1;
      writeCallCounts.set(signature, count);
      return count > 1 ? annotateDuplicateCall(result, tool, count) : result;
    };

  // Per-run failure-id minter. Each rejected write gets a stable, short id
  // (`f1`,`f2`,…) the extractor loop tracks as outstanding; the model must
  // either clear it with a successful threaded retry or acknowledge it at
  // memory_end_extraction before the run can end cleanly.
  let failureCounter = 0;
  const nextFailureId = (): string => `f${(failureCounter += 1)}`;

  // Outermost wrapper: thread an optional inbound `failureId` through a write.
  // The field is stripped before the inner handler (and the duplicate-call
  // signature) sees it, so it never reaches content validation and a retry
  // carrying it still collapses against an identical earlier attempt. On
  // failure the envelope gains a `failureId` — the inbound one when retrying,
  // otherwise a fresh id. On success while retrying, the envelope echoes
  // `clearedFailureId` so the loop can drop it from the outstanding set.
  const withFailureId =
    (handler: (args: unknown) => Promise<string>) =>
    async (rawArgs: unknown): Promise<string> => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const inbound =
        typeof args.failureId === "string" && args.failureId.trim()
          ? args.failureId.trim()
          : undefined;
      const { failureId: _omit, ...rest } = args;
      void _omit;
      const result = await handler(rest);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(result) as Record<string, unknown>;
      } catch {
        // Non-JSON envelope (shouldn't happen for write tools); leave as-is.
        return result;
      }
      if (parsed.ok === false) {
        parsed.failureId = inbound ?? nextFailureId();
        return JSON.stringify(parsed);
      }
      if (parsed.ok === true && inbound) {
        parsed.clearedFailureId = inbound;
        return JSON.stringify(parsed);
      }
      return result;
    };

  const wrap = (
    tool: WriteToolName,
    handler: (args: unknown) => Promise<string>,
  ) => withFailureId(withDuplicateNudge(tool, handler));

  const handlers = new Map<string, (args: unknown) => Promise<string>>();
  for (const tool of Object.keys(
    SINGLE_FACT_WRITE_KINDS,
  ) as SingleFactWriteToolName[]) {
    handlers.set(tool, wrap(tool, handleSingleFactWrite(tool)));
  }
  handlers.set(
    "memory_set_attributes",
    wrap("memory_set_attributes", handleSetAttributes),
  );
  handlers.set("memory_keep_loops", wrap("memory_keep_loops", handleKeepLoops));
  handlers.set("memory_close_loop", wrap("memory_close_loop", handleCloseLoop));
  handlers.set(
    "memory_forget_attribute",
    wrap("memory_forget_attribute", handleForgetAttribute),
  );
  handlers.set(
    "memory_forget_directive",
    wrap("memory_forget_directive", handleForgetDirective),
  );
  return handlers;
}
