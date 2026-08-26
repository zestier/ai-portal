# Proc Tool Architecture

## Status

Implemented experimental semantic architecture whose frontier surface contains
only `proc` plus direct human interaction. It replaces the experimental
`resolve` boundary rather than becoming another general-purpose subagent.

The central hypothesis is:

> A strong frontier model can retain diagnosis, procedure, and decision
> ownership while a weaker worker tolerantly realizes a supplied procedure,
> keeps large intermediate values outside model context, and returns only
> intentional projections.

The feature remains experimental and is selected by the existing `semantic`
conversation architecture value.

## Motivation

The existing semantic tools leave an awkward gap:

- `program` is concise and deterministic, but exact JavaScript and tool
  contracts make complex or adaptive procedures brittle.
- `resolve` accepts an outcome and lets another model determine the method,
  which makes it structurally similar to a general-purpose subagent.

`proc` occupies the space between them. The frontier supplies the procedure,
selection rules, and output contract in tolerant natural-language pseudocode.
The proc worker may repair syntax, resolve capability contracts, choose batch
sizes, and carry data between program fragments. It may not invent the
procedure or choose a materially different result.

Proper goal-owning subagents, if added later, should be a separate feature with
an explicit user-facing identity and lifecycle.

## Frontier Surface

The experimental frontier receives:

- `proc`: realize one supplied procedure and return its requested projection;
- `ask_user`: preserve direct frontier-to-human interaction.

`resolve`, `resume`, direct `program`, schema lookup, and artifact readers are
not exposed. Program execution, state handles, projections, and traces are
implementation details behind `proc`. This intentionally forces the
experiment to test the proc boundary instead of falling back to adjacent
tools.

A representative call is:

```yaml
summary: Read key files for foo
goal: File names, relevant line ranges, and a few-word purpose.
procedure: |
  Search for foo, Foo, Oof, and Blanket.
  Group matches by file.
  Read context around each match.
  Keep only enclosing class or function definitions.
  Return one entry per definition.
output:
  mode: exact
  max_bytes: 12000
  store: false
```

`summary` is the user-visible label. `goal` specifies the final data contract,
not an open-ended objective. `procedure` describes the algorithm and relevance
criteria the worker must realize. The worker rejects requests that require it
to invent those elements.

## Decision Boundary

The frontier owns:

- the problem diagnosis and desired result;
- the procedure and meaningful branches;
- relevance, filtering, and stopping criteria;
- consequential product, design, and architecture decisions;
- the final output projection and context budget.

The proc worker owns only tolerant realization:

- translating procedure steps into executable atoms;
- resolving exact tool names and argument contracts;
- repairing syntax and equivalent mechanical failures;
- batching, pagination, and intermediate data plumbing;
- applying supplied criteria to inspected data;
- selecting equivalent implementation details that do not change the
  procedure or result.

The worker must not broaden the investigation, add goals, reinterpret
relevance, choose a different algorithm, or continue through missing
consequential instructions. It returns `cannot_execute` with the smallest
missing instruction instead. The frontier then issues a new `proc` call; there
is no durable `resume` conversation hidden inside the tool.

## Worker Surface

The proc worker receives only:

- `atom`: execute one program fragment against capabilities and stored state;
- `complete`: designate the final atom value and requested frontier
  projection;
- `cannot_execute`: stop with a precise unsupported or underspecified step.

It does not receive repository tools directly. Repository operations occur
inside atoms so the worker acts as a compiler and dataflow orchestrator rather
than a second repository agent.

### Atom capabilities and discovery

Atom capabilities are opt-in, not inferred from the ordinary portal tool
surface. Every atom-capable tool supplies `ProgramToolMetadata` with a compact
purpose, atom-specific input and result schemas, one canonical JavaScript
example, its read or mutation category, and any compatibility, permission, or
result adapters required when script and direct-tool contracts differ.

At proc start, the worker receives the complete manifest for every enabled atom
capability plus stable `fs`, `path`, and `command` facade signatures. This is
not a discovery call and does not include disabled capabilities. Supplying it
once with the procedure lets the worker generate valid source without guessing
or spending turns loading schemas.

The initial atom surface covers:

- file reads, writes, traversal, metadata, creation, and rename through `fs`;
- content and path search through `tools.grep` and `tools.find`;
- structured repository inspection through `tools.git_status` and
  `tools.git_diff`;
- validation and explicit argv execution through `command.run`;
- immutable intermediate values through `state[resultId]`.

Additional Git operations, tickets, memory, or other domains must not silently
appear in atoms. They require explicit metadata, contract tests, permission
tests, and an update to the capability audit. Human interaction is deliberately
not an atom capability: when the supplied procedure requires a human decision,
the worker calls `cannot_execute`; the frontier retains `ask_user` ownership
and may issue a new proc with the answer.

### Atom validation

The same metadata drives discovery and execution. Before dispatch, the runtime:

1. resolves the name against the enabled atom capability map;
2. applies the atom-specific compatibility normalizer;
3. validates canonical arguments with the atom-specific Zod schema;
4. derives permissions from those canonical arguments;
5. invokes the existing portal handler or atom-specific adapter;
6. validates JSON compatibility and the hard per-call result limit;
7. records the normalized call beneath the parent proc activity.

This separation is required because direct tools and synchronous script
functions often need different contracts. A tool is not atom-capable merely
because it is a `PortalTool`; missing metadata means unavailable, and unknown
calls fail closed with available-name suggestions.

There is no initial `inspect` tool. Inspection is an atom whose projection is
`exact`, for example:

```js
return state["RES_candidates"].slice(0, 12);
```

This keeps one composition primitive. A dedicated inspection operation may be
added later only if telemetry shows that trivial projection atoms create
material latency or complexity.

## Atom Contract

An atom runs JavaScript in the existing resource-limited program runtime. In
addition to audited filesystem and tool capabilities, it may read immutable
prior atom values through `state[resultId]`.

```yaml
source: |
  return tools.grep({ pattern: "foo", path: "src" });
output:
  mode: shape
  max_bytes: 4000
  store: true
```

Each atom output independently controls persistence and model visibility:

- `store: true` persists the exact JSON-compatible value and returns a
  transaction-scoped `result_id`.
- `store: false` discards the exact value after deriving the projection and
  returns no `result_id`.
- `mode: none` returns no projection and therefore requires `store: true`.
- `mode: shape` returns a compact observed description of the actual value.
- `mode: exact` returns the actual value within `max_bytes`.

`max_bytes` is required for `shape` and `exact`. A projection never exceeds its
declared budget. Exact overflow rejects the atom unless a later contract adds
an explicit lossy exact mode; silent truncation is not allowed.

A result envelope is:

```json
{
  "result_id": "RES_01...",
  "stored": true,
  "bytes": 284192,
  "projection": "array(318) of object { path: string, line: integer }",
  "projection_bytes": 58,
  "truncated": false
}
```

`bytes` measures the exact serialized value. `projection_bytes` measures what
entered worker context. `truncated` always describes the requested projection:
it is true only when projection limits forced that mode to omit information.
The stored value, when present, is exact regardless of projection mode.

Result ids are immutable, transaction- and conversation-scoped, inaccessible
across users, auditable to their producing atom, and garbage-collected with the
proc transaction. State access does not grant new authority: every repository
operation still crosses the normal capability and permission boundary.

## Shape Projection

`shape` exists to let the worker write the next atom correctly without placing
the intermediate value itself in model context. It is inferred solely from the
actual JSON-compatible value in state. It does not speculate from a producing
tool schema or describe values that are not present.

An empty array is therefore exactly:

```text
array(0)
```

There is no inferred element type. The next atom has no elements to consume,
so a hypothetical item contract would add context without actionable data.

Representative non-empty shapes are:

```text
object {
  files: array(318) of object {
    path: string
    matches: array(1..42) of object { line: integer, text: string }
  }
  totals: object { files: integer, matches: integer }
}
```

```text
array(120) of object {
  path: string
  line?: integer
  text?: string
  error?: string
}
```

The renderer compacts aggressively. Its purpose is consumability, not perfect
reconstruction of every observed variant. In particular, compatible object
variants should normally merge into one object with optional fields rather
than produce a large union. The module should prefer a concise safe
over-approximation when the next atom can still access every observed field.

### Normalization Laws

Shape inference and rendering live in a dedicated pure module. The following
properties are part of its contract:

1. **Observed only.** It describes only the supplied value. Empty collections
   do not acquire speculative item types.
2. **Deterministic.** Object insertion order, traversal order, and equivalent
   array permutations do not change the normalized shape or rendered text.
3. **Aggressively merged.** Object variants with compatible keys merge; keys
   absent from any merged member become optional.
4. **Type preserving.** Incompatible scalar types remain unions. Integers and
   non-integer numbers remain distinguishable when doing so fits the budget.
5. **Cardinality aware.** Arrays report exact length; nested array variants may
   report observed length ranges.
6. **Bounded.** Inference and rendering have depth, node, variant, and byte
   budgets independent of input size.
7. **Progressively compacted.** When the requested byte budget is exceeded,
   rendering merges variants, drops examples, coarsens nested detail, and
   finally omits low-value branches in a deterministic order.
8. **Explicitly lossy.** Any budget-driven omission sets `truncated: true` and
   is visibly marked in the projection.
9. **Safe for composition.** A rendered field is never presented as required
   when it was absent from an observed object included in that merged shape.
10. **Cycle independent.** Atom values are JSON-compatible and therefore
    acyclic; the shape module rejects non-JSON input rather than inventing
    cycle semantics.

No current dependency implements this exact normalization policy. Generic JSON
Schema inference libraries optimize for contract reconstruction and tend to
retain variants that this use case deliberately merges. The initial design
therefore favors a small purpose-built module over adding a schema dependency.
That decision should be revisited before implementation by evaluating candidate
libraries against the test corpus below, not by package popularity alone.

### Shape Test Specification

The module requires table-driven and property-oriented tests covering:

- every JSON scalar, including integer/number distinction and `null`;
- empty arrays and objects;
- homogeneous arrays and nested arrays;
- object variants differing by one or many missing keys;
- conflicting scalar and container types under the same key;
- heterogeneous arrays where optional-field merging is possible;
- variants that cannot be usefully merged;
- dynamic-key objects and very wide objects;
- deeply nested values and depth exhaustion;
- very large homogeneous arrays without input-size-proportional output;
- deterministic output under object-key and array permutation;
- exact byte-bound behavior at multibyte UTF-8 boundaries;
- progressive compaction at every stage;
- `truncated` changing only when information is omitted;
- rejection of `undefined`, functions, non-finite numbers, cycles, and other
  non-JSON values.

Property tests should assert determinism, byte bounds, permutation invariance,
and the optional-field safety law. Golden tests should be reserved for the
small stable text grammar; normalization behavior should primarily be tested
structurally so harmless formatting changes do not obscure regressions.

## Execution Flow

```text
frontier procedure
       |
       v
proc worker -- atom(source, output policy) --> program runtime
       ^                                      |
       |                                      v
       +------ handle + bounded projection -- state store
                                                      |
                         later atom: state[resultId] <-+
```

The worker normally requests `shape` for stored intermediate results, `none`
for mechanically chained values whose structure is already known, and bounded
`exact` only when applying a supplied criterion requires semantic inspection.
The final `complete` call projects an atom result according to the frontier's
original proc output contract.

## Initial Implementation Sequence

1. Implement and thoroughly test JSON value validation and shape
   normalization/rendering as pure modules.
2. Add transaction-scoped immutable atom storage and lifecycle cleanup.
3. Extend the program runtime with read-only `state[resultId]` access.
4. Add atom persistence and `none`/`shape`/`exact` projections with byte
   budgets and explicit `truncated` metadata.
5. Expose the low-level atom protocol in tests and measure state composition
   before introducing another model.
6. Add the constrained proc worker with only `atom`, `complete`, and
   `cannot_execute`.
7. Replace the semantic frontier surface with `proc` and `ask_user` for the
   experiment; remove `resolve` and its resume/artifact-reader surface.
8. Add deterministic stub scenarios and paired evaluations against standard
   mode.

## Open Questions

- Whether `store` should be required or default to `true`; the current proposal
  requires it so persistence is always intentional.
- Exact minimum and maximum projection byte budgets.
- Whether exact lossy projections are needed after real proc traces are
  available.
- State retention after a proc call completes, including whether a later proc
  may explicitly consume an earlier result id.
- Whether repeated trivial inspection atoms justify a later optimized
  `inspect` operation.
- How strict pre-execution procedure validation should be versus relying on
  `cannot_execute` after the worker attempts compilation.

## Evaluation

Evaluate a proc-only frontier on procedures that require:

- broad search followed by grouped contextual reads;
- mechanical filtering over large intermediate sets;
- semantic inspection of bounded candidate batches;
- multi-stage transformations using exact state without model reinjection;
- an empty intermediate collection;
- heterogeneous records that shape must compact;
- a deliberately underspecified decision that must return `cannot_execute`.

Measure correctness, frontier and worker context growth, atom count, exact
inspection frequency, shape bytes versus stored bytes, retries, latency, and
the frequency with which the worker attempts to broaden or rewrite the supplied
procedure.