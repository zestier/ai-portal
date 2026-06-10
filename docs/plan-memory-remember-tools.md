# Plan: per-kind `remember_*` memory write tools (extractor redesign)

## Problem

The memory extractor stores durable memory by calling a single `memory_propose_patch`
tool whose `patch.facts[]` is a 5-way discriminated union on `kind`. Weak/local
backends (LM Studio etc.) struggle to emit the correct structure, loop in
unrecoverable error states, and the all-or-nothing batch parse discards a whole
batch when one item is malformed. Earlier work (flatten schema, targeted errors,
kind-as-key repair) treated the symptom. This plan removes the failure mode by
making classification = tool selection and each tool's args flat and tiny.

## Locked decisions

1. Loop lifecycle = three tools: `remember_loop` (create one), `keep_loops({handles[]})`
   (batch anti-aging reaffirm), `close_loop({handle,status,reason?})` (retire one).
   Keep-alive is NOT folded into remember_loop (must not restate content; is batch).
2. Main-model `memory_propose_patch`: make unreferenced in Phase 1; delete as
   follow-up. Ticket filed: 01KTNPJVFN1S34G08QHH2RWM5E.
3. `MEMORY_EXTRACTOR_TOOL_CHOICE = auto | required` knob; default `auto`.
4. Explicit keep-loops (persist only when reaffirmed); aging unchanged.

## Write surface (replaces extractor's memory_propose_patch)

- remember_attribute { entityKey?, predicate, value, visibility?, confidence? }
- remember_directive { rule, entityKey? }
- remember_event     { eventType, summary, entityKey?, payload?, visibility?, confidence? }
- remember_loop      { loopType, title, description?, priority?, relatedEntityKeys? }
- remember_entity    { entityKey, entityType, displayName, summary?, metadata? }
- keep_loops         { handles: string[] }
- close_loop         { handle, status: 'resolved'|'dropped', reason? }

NOTE: remember_entity was added during implementation (not in the original
4-tool spec). Without it the new surface had no way to set an entity's
entityType/displayName — facts auto-mint a bare entity from entityKey as a
backstop, but explicit entity creation (esp. for story mode) needed a tool.

Read/maintenance tools unchanged: memory_search, memory_get_entity,
memory_get_open_loops, memory_merge_entities.

`decision` dropped entirely from the write surface. Genuine choices -> attribute
(predicate "decision") or directive. Existing decision rows still render
(read-only legacy); stop writing new ones (also remove from heuristic extractor).

## Staging & commit

Each write call appends to an in-memory MemoryPatchProposal accumulator and
returns immediately. One commitPatch per turn at the end (unchanged downstream:
secret filtering, entity canonicalization, ageOpenLoops). Per-item acceptance is
inherent (one bad call can't reject a valid one).

Accumulator routing:
- remember_attribute -> facts[] (directive -> facts[] w/ DIRECTIVE_PREDICATE)
- remember_event     -> events[]
- remember_loop      -> openLoops[]
- keep_loops         -> keepOpenLoops[]
- close_loop         -> resolveOpenLoops[]

## Tool result envelopes (shared builder)

Success:
{ ok:true, tool, action:'created'|'kept'|'closed', accepted:{normalized},
  staged_totals:{attributes,directives,events,loops}, issues?:[warnings], note }

Error:
{ ok:false, tool, error:{ kind:'validation'|'execution',
  code:'schema_invalid'|'semantic_invalid'|'exception', message },
  issues:[{field,code,message,hint}], expected:{schema:THIS tool only, example},
  received:{echoed args truncated}, staged_totals, note }

keep_loops error carries per-handle results[] (partial success first-class).

Rules: `ok` is authoritative (fixes activityResultOk bug — key on ok===false);
errors are per-tool scoped (no 5-way union dump); validation vs execution
distinguished; per-issue hint; echo received; staged_totals on errors too.

## Constrained decoding (#1)

Standard OpenAI `tools` (works in LM Studio). Flat per-tool schemas are the
load-bearing robustness win; grammar enforcement is a bonus we don't depend on.
Add MEMORY_EXTRACTOR_TOOL_CHOICE (auto|required) + optional guided-param
pass-through.

## Telemetry / eval (#7)

Per write call log {tool, ok, aliased, action}; per rejection tag
invalid-json | wrong-field-for-tool. Fixed eval set scored on stored-correctness,
right-tool, churn — run against the real local model. (Spec'd; build may be a
follow-up.)

## Blast radius

- extractor.ts: replace buildStagingToolSpec + stageProposal with tool family +
  accumulator; rewrite system prompt (tool-selection + one example/tool); fix
  activityResultOk; delete buildPatchSchemaRejection + MEMORY_FACT_KIND_* family
  + coercion primary-field map.
- engine.ts: drop `decision` from PatchFactItemSchema + heuristic output (~line 993);
  internal MemoryPatchProposal/commitPatch/validatePatch/ageOpenLoops UNCHANGED.
- tools/memory.ts: make memory_propose_patch unreferenced (Phase 1).
- single-shot extractor + MEMORY_EXTRACTOR_JSON_SCHEMA: drop `decision`.
- tests/memory.test.ts: rewrite extractor cases to new tools; add envelope +
  partial-acceptance + keep/close + decision-removal cases.
- tests/tool-schema-errors.test.ts: update/remove the memory_propose_patch case.

## Verification

pnpm run check; pnpm run test (full); pnpm run lint. Reproduce original symptom
(malformed fact) and confirm targeted per-tool error + no batch loss.
