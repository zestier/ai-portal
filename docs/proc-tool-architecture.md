# Proc Tool Architecture

## Status

Implemented experimental semantic architecture whose primary-agent surface contains
only `proc` plus direct human interaction. It replaces the experimental
`resolve` boundary rather than becoming another general-purpose subagent.

The central hypothesis is:

> Primary model owns diagnosis, procedure, and decisions. Worker realizes the
> procedure, keeps large intermediates in proc store, and returns projections.

The feature remains experimental and is selected by the existing `semantic`
conversation architecture value.

## Execution isolation

Proc model orchestration, permissions, persistence, event emission, and real
tool execution remain in the SvelteKit server process. QuickJS guest programs
run on one long-lived Node worker thread so CPU-bound guest code cannot block
HTTP, SSE, timers, or unrelated conversations on the server event loop.

Executions have a 1,000-call hard ceiling and worker feedback warns at 200
operations. This permits substantial fused reads while surfacing accidental
recursive `readdir`/`stat` loops early; procedures that approach either limit
should use fused `search.glob` or `search.grep` operations instead. Failed executions
retain individual capability calls in the nested
audit timeline, while worker-facing feedback groups effects by tool, category,
and outcome with a count. Model context therefore cannot grow linearly with the
number of audited calls.
The worker pool accepts at most 32 active and queued programs and executes them
in FIFO order. A single worker deliberately preserves serial execution and
bounds the memory cost of QuickJS/WASM contexts. Each program still receives a
fresh QuickJS context with the existing memory, stack, operation, payload, and
120-second runtime limits.

Guest capability calls use correlated request/response messages back to the
parent process. Only JSON-compatible arguments, tool results, stored values,
errors, and traces cross the thread boundary; live tool handlers, database
readers, permission resolvers, and event callbacks never leave the parent.
Cancellation uses a shared atomic flag so QuickJS can observe it even while the
worker's JavaScript event loop is occupied. The pool also aborts in-flight host
tool work and terminates the worker if it does not stop within the grace period.
A hard timeout or worker crash rejects the active program, starts a replacement,
and continues queued work.

## Motivation

The existing semantic tools leave an awkward gap:

- `program` is concise and deterministic, but exact JavaScript and tool
  contracts make complex or adaptive procedures brittle.
- `resolve` accepts an outcome and lets another model determine the method,
  which makes it structurally similar to a general-purpose subagent.

`proc` occupies the space between them. The primary agent supplies the procedure,
selection rules, and result requirements in tolerant natural-language pseudocode.
The proc worker may repair syntax, resolve capability contracts, choose batch
sizes, and carry data between program fragments. It may not invent the
procedure or choose a materially different result.

Proper goal-owning subagents, if added later, should be a separate feature with
an explicit user-facing identity and lifecycle.

## Primary-Agent Surface

The primary agent receives:

- `proc`: realize one supplied procedure and return its requested projection;
- `ask_user`: preserve direct primary-agent-to-human interaction.

`resolve`, `resume`, direct `program`, schema lookup, and artifact readers are
not exposed. Program execution, store keys, projections, and traces are
implementation details behind `proc`. This intentionally forces the
experiment to test the proc boundary instead of falling back to adjacent
tools.

A representative call is:

```yaml
summary: Read key files for foo
procedure: |
  Search for foo, Foo, Oof, and Blanket.
  Group matches by file.
  Read context around each match.
  Keep only enclosing class or function definitions.
  Return one entry per definition.
result_requirements: File names, relevant line ranges, and a few-word purpose; no other fields.
```

`summary` is the user-visible label. `result_requirements` specifies the final data
contract, not an open-ended objective. `procedure` describes the algorithm and
relevance criteria the worker must realize. The worker rejects requests that
require it to invent those elements.

The requirements are an allowlist: unrequested fields, records, and supporting
material stay inside proc.

Proc is a reduction boundary, not a context-smuggling mechanism. A valid
`result_requirements` derives focused evidence from a potentially large corpus:
paths, line
ranges, purposes, counts, selected records, or limited excerpts. Requests to
return multiple complete files or another raw corpus verbatim are rejected
before a
worker turn because they cannot satisfy the architecture's context objective.
A single complete value remains valid when the caller explicitly requires that
exact value.

Request enough detail for correct decisions and verification. Do not request
convenient bulk context.

## Decision Boundary

The primary agent owns:

- the problem diagnosis and desired result;
- the procedure and meaningful branches;
- relevance, filtering, and stopping criteria;
- consequential product, design, and architecture decisions;
- the exact final output contract.

The proc worker owns only tolerant realization:

- translating procedure steps into executable JavaScript;
- resolving exact tool names and argument contracts;
- repairing syntax and equivalent mechanical failures;
- internal batching and intermediate data plumbing;
- applying supplied semantic criteria to inspected data;
- selecting equivalent implementation details that do not change the
  procedure or result.

The worker must not broaden the investigation, add goals, reinterpret
relevance, choose a different algorithm, or continue through missing
consequential instructions. It returns `cannot_execute` with the smallest
missing instruction instead. The primary agent then issues a new `proc` call; there
is no durable `resume` conversation hidden inside the tool.

## Worker Surface

The proc worker receives only:

- `execute`: run fused JavaScript and choose who needs its returned value;
- `cannot_execute`: stop with a precise unsupported or underspecified step.

It does not receive repository tools directly. Repository operations occur
inside executions so the worker acts as a compiler and dataflow orchestrator rather
than a second repository agent.

The transcript makes this boundary visible. Proc protocol calls are persisted
as nested activity, and capability calls are parented beneath the execution that
caused them:

```text
proc: Map model routing
  finish: Return selected routing definitions
    grep
    read
```

The worker model receives `execute`, `view`, `finish`, and `cannot_execute`. Nested
`grep`, `read`, Git, filesystem, and command rows are
execution trace, not additional model-visible worker tools.

### Fusion and segmentation

The worker fuses adjacent mechanical steps into the largest reliable execution;
procedure steps are not turn boundaries. Intermediate values remain ordinary
JavaScript values inside an execution and do not enter model context.

`execute` continues the procedure. Its required nullable `store_into` field
names a value as `store.<key>` for later JavaScript; `null` does not retain the
return value. Storage is exact; feedback is a fixed bounded shape. `view`
returns exact worker evidence under an explicit byte ceiling and continues.
`finish` returns the final value to the proc caller and ends the procedure.
All three use the same JavaScript APIs. Every continuing call declares
`needed_for`: one short phrase stating the required outcome or decision.

Calls emitted in one model turn execute sequentially, so later calls may read
names saved by earlier calls. The first failure cancels every remaining call in
that batch instead of producing a chain of dependent failures.

This makes additional executions meaningful: they represent deliberate
segmentation, semantic inspection, or repair rather than the default way to
construct a pipeline.

### Program capabilities and discovery

Program capabilities are opt-in, not inferred from the ordinary portal tool
surface. Every program-capable tool supplies `ProgramToolMetadata` with a compact
purpose, program-specific input and result schemas, one canonical JavaScript
example, its read or mutation category, and any compatibility, permission, or
result adapters required when script and direct-tool contracts differ.

At proc start, the worker receives stable `search`, `fs`, `path`, `git`, and `command`
facade signatures plus the complete manifest for enabled capabilities that do
not have a first-class facade. This is not a discovery call and does not include
disabled capabilities. Supplying it once with the procedure lets the worker
generate valid source without guessing or spending turns loading schemas.

The initial program surface covers:

- file reads, writes, traversal, metadata, creation, and rename through `fs`;
- content and path search through `search.grep` and `search.glob`;
- structured repository inspection through `git.status`, `git.diff`,
  `git.log`, `git.show`, and `git.blame`;
- validation and explicit argv execution through `command.run`;
- immutable intermediate values through the read-only `store` object.

The `search`, `fs`, `git`, and `command` namespaces are the advertised interface. The
generic `tools` proxy remains an undocumented compatibility path for programs
generated against older manifests, but facade-backed capabilities are omitted
from the worker's tool manifest so new programs do not have to choose between
duplicate spellings. Filesystem methods are documented without Node's `Sync`
suffix and accept the corresponding suffixed spelling as a tolerant alias.
Non-recursive `fs.readdir` remains available as a compatibility escape hatch for
listing one directory and rejects directories above 1,000 entries. Repository
traversal should use the ripgrep-backed `search.glob`, which follows ripgrep's
ignore rules. Passing
`includeIgnored: true` bypasses ignore files and can deliberately search ignored
trees such as `node_modules`.

Reading a complete file inside an execution keeps it outside model context.
Stored values remain complete; only their bounded shape enters feedback.
`view` admits exact evidence when JavaScript cannot resolve the next semantic
decision. Its caller chooses the smallest sufficient byte ceiling up to the
hard guard. `console` methods are unsupported and their arguments are discarded.

Repeated zero-operation executions that load and re-save hidden values are
counted as non-progress. After two consecutive occurrences,
feedback tells the worker to stop re-saving and use `view` or `finish`.

`search.glob` returns all matching workspace-relative paths as `string[]`;
`search.grep` returns all matching lines as structured path, line, column, and text
records. Neither silently truncates. Capability data may consume the QuickJS
memory budget so the program can filter and aggregate it internally; only the
value returned from the VM is subject to the program-result and proc projection
limits. Grep accepts one glob or an array of ripgrep globs, each applied as a
repeated `--glob` filter.

Additional Git operations, tickets, memory, or other domains must not silently
appear in executions. They require explicit metadata, contract tests, permission
tests, and an update to the capability audit. Human interaction is deliberately
not a program capability: when the supplied procedure requires a human decision,
the worker calls `cannot_execute`; the primary agent retains `ask_user` ownership
and may issue a new proc with the answer.

### Capability validation

The same metadata drives discovery and execution. Before dispatch, the runtime:

1. resolves the name against the enabled program capability map;
2. applies the program-specific compatibility normalizer;
3. validates canonical arguments with the program-specific Zod schema;
4. derives permissions from those canonical arguments;
5. invokes the existing portal handler or program-specific adapter;
6. validates JSON compatibility and the hard per-call result limit;
7. records the normalized call beneath the parent proc activity.

This separation is required because direct tools and synchronous script
functions often need different contracts. A tool is not program-capable merely
because it is a `PortalTool`; missing metadata means unavailable, and unknown
calls fail closed with available-name suggestions.

When supplied rules cannot resolve a semantic question, `view` reduces the
corpus to distinguishing evidence:

```js
const { candidates } = store;
return candidates.slice(0, 12).map(({ id, signature }) => ({ id, signature }));
```

## Execution Contract

An execution runs JavaScript in the existing resource-limited program runtime.
In addition to audited filesystem and tool capabilities, it may lazily read
immutable stored values through `store.<key>`. The first
access fetches, parses, caches, and freezes that value inside the execution;
unused values are never loaded into QuickJS.

```yaml
tool: finish
javascript: |
  const matches = search.grep("foo", { path: "src" });
  return groupAndSelect(matches);
```

`execute` stores its exact return value when `store_into` is a store key and
returns a server-bounded shape. `view` returns exact data when it fits both its
requested ceiling and remaining transcript headroom; overflow rejects the call
without truncation. `finish` returns exactly the primary agent's result
requirements.

Exact evidence remains separate from stored data:

```yaml
tool: execute
needed_for: Preserve complete candidates
javascript: |
  return findCandidates();
store_into: store.candidates
---
tool: view
needed_for: Which candidate owns retry classification?
javascript: |
  return store.candidates.map(({ id, signature, retryBranch }) =>
    ({ id, signature, retryBranch }));
max_bytes: 12000
```

Only the `view` result enters the next worker turn. The complete candidates stay
in `store.candidates` for later JavaScript.

Store feedback is:

```json
{
  "store_into": "store.candidates",
  "value_bytes": 284192,
  "shape": "array(318) of object { path: string, line: integer }",
  "shape_bytes": 58,
  "shape_truncated": false,
  "operations": 12,
  "effects": [],
  "effects_total": 0
}
```

`value_bytes` measures exact serialized storage. `shape_bytes` measures execute
feedback. `view_bytes` measures exact evidence entering worker context.

Every execution requires a user-visible `needed_for`. The dedicated
proc card shows the primary-agent procedure and result requirements, each execution's
justification, store destination and JavaScript, operation count,
nested capability activity, partial-effect warnings, final usage, and the
exact evidence returned to the worker model.

Saved names are immutable and transaction- and conversation-scoped. Results
survive completion, failure, and `cannot_execute` for audit. Finished values are
not executable store inputs. Conversation deletion removes them by foreign-key
cascade. Saved-value access grants no new authority: repository operations still
cross normal capability and permission boundaries.

### Failure and effects

Arbitrary capabilities and commands cannot be made generally atomic. Proc does
not promise rollback. Each failed execution instead reports a coarse effect
ledger classifying attempted capability calls as `read`, `mutation`, or
`opaque`, together with whether each call succeeded.

An execution is safe to retry automatically only when every completed call was
a read. After a mutation or opaque command, the worker must not replay the
original program blindly. It writes a continuation that inspects current
repository state and performs only unfinished work, or returns
`cannot_execute`. Read-heavy discovery should therefore be fused before
effects, and opaque or non-idempotent operations should occur as late as
practical.

## Shape Projection

`shape` exists to let the worker write the next execution correctly without placing
the intermediate value itself in model context. It is inferred solely from the
actual stored JSON-compatible value. It does not speculate from a producing
tool schema or describe values that are not present.

An empty array is therefore exactly:

```text
array(0)
```

There is no inferred element type. The next execution has no elements to consume,
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
over-approximation when the next execution can still access every observed field.

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
10. **Cycle independent.** Saved values are JSON-compatible and therefore
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
primary-agent procedure
       |
       v
proc worker -- execute(needed_for, javascript, store_into) --> program runtime
            -- view(needed_for, javascript, max_bytes) ---> program runtime
            -- finish(javascript) ------------------------> program runtime
       ^                                      |
       |                                      v
  +------ store key, shape, or exact view -- stored-value store
                                                      |
             later execution: store.<key> <-------------+
```

The worker uses the fewest executions that preserve correctness, recoverability,
and clear data flow. Procedure steps alone never justify additional executions.

Small language-agnostic helpers for line ranges, line numbering, contextual
windows, indentation outlines, and common collection operations are suitable
future additions to the program environment. They should remove repetitive
and error-prone mechanics without replacing ordinary JavaScript or committing
the architecture to one language or LSP.

## Initial Implementation Sequence

1. Implement and thoroughly test JSON value validation and shape
   normalization/rendering as pure modules.
2. Add transaction-scoped immutable stored-value storage and lifecycle cleanup.
3. Extend the program runtime with lazy read-only
  `store.<key>` access.
4. Add execution persistence and bounded model feedback with
  hidden emergency transport guards.
5. Expose the low-level execution protocol in tests and measure saved-value composition
   before introducing another model.
6. Add the constrained proc worker with `execute`, `finish`, and
  `cannot_execute`.
7. Replace the semantic primary-agent surface with `proc` and `ask_user` for the
   experiment; remove `resolve` and its resume/artifact-reader surface.
8. Add deterministic stub scenarios and paired evaluations against standard
   mode.

## Open Questions

- Whether real traces reveal semantic decisions that need a more structured
  contract than `needed_for`.
- Which small source/text utilities most reduce retries without creating a
  language-specific query surface.
- How strict pre-execution procedure validation should be versus relying on
  `cannot_execute` after the worker attempts compilation.

## Evaluation

Evaluate a proc-only primary agent on procedures that require:

- broad search followed by grouped contextual reads;
- mechanical filtering over large intermediate sets;
- one semantic decision over mechanically reduced distinguishing evidence;
- multi-stage transformations using exact stored values without model reinjection;
- an empty intermediate collection;
- heterogeneous records that shape must compact;
- a deliberately underspecified decision that must return `cannot_execute`.

Measure correctness, primary-agent and worker context growth, first-execution
completion rate, execution count, console-evidence precision, attempts to page corpora through model turns,
stored-value reuse, retries, latency, partial-effect recoveries, and the
frequency with which the worker broadens or rewrites the supplied procedure.

Use paired evaluations. A mechanically decidable corpus with hundreds of
candidates must be reduced entirely in JavaScript. A genuinely semantic case
must return only evidence that distinguishes a small candidate set, then use
the saved exact value for subsequent code. Final-result cases must omit every
field not allowed by `result_requirements`.