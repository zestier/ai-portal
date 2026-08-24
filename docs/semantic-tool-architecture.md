# Semantic Tool Architecture

## Status

Implementation plan for an experimental, per-conversation agent architecture.
The existing architecture remains the default and must remain behaviorally
unchanged. The experiment is selected with `agentArchitecture`:

- `standard`: expose the portal's normal tools directly to the frontier model.
- `semantic`: expose a compact semantic and programmatic surface; delegate
  primitive workspace operations to an isolated worker or capability runtime.

The purpose is to measure whether a strong model can retain ownership of
diagnosis and design while avoiding expensive turns spent locating code,
constructing edits, and processing verbose tool output.

## Goals

1. Make standard and semantic conversations directly comparable.
2. Keep consequential decisions with the frontier model.
3. Collapse adaptive mechanical tool loops into bounded semantic transactions.
4. Let the frontier batch deterministic operations with programmatic tool
   calling (PTC) without exposing host APIs to generated programs.
5. Preserve permission prompts, auditability, cancellation, and nested activity.
6. Keep all raw evidence, changes, traces, and command output available without
   injecting them into frontier context by default.
7. Measure total cost, token use, latency, retries, and validation outcomes for
   the frontier and workers independently.

## Non-goals

- Replacing the standard architecture before measured results justify it.
- Giving semantic workers broad product, architecture, or diagnostic ownership.
- Giving semantic workers PTC. Their value comes from cheap sequential
  adaptation over a small primitive tool set.
- Reimplementing existing filesystem, git, shell, ticket, memory, interaction,
  or permission behavior.
- Treating `node:vm` as a security boundary for generated programs.

## Frontier Surface

Semantic conversations expose these tools:

| Tool | Purpose |
| --- | --- |
| `resolve` | Start one bounded semantic transaction. It may inspect, modify, and validate, but must escalate consequential ambiguity. |
| `resume` | Continue a suspended transaction with a frontier decision. |
| `program` | Execute a bounded JavaScript program against audited portal capabilities. |
| `read_evidence` | Retrieve selected grounding captured by a transaction. |
| `read_changeset` | Retrieve selected changes or a diff captured by a transaction. |
| `read_trace` | Retrieve worker actions, primarily for failure diagnosis. |
| `read_output` | Retrieve selected command or validation output. |
| `ask_user` | Preserve direct frontier-to-human interaction. |

The tools use separate, shallow schemas. They do not use tagged unions. Tool
results include compact previews and opaque handles so the frontier only reads
large artifacts when they could change its next decision.

`resolve` has one intent field plus optional constraints and completion
conditions. It does not require the frontier to predict whether the transaction
will need read, write, or execute authority. Each delegated primitive operation
is permission-checked normally.

## Decision Boundary

The worker may determine how to obtain or realize a specified result. It may
not decide which materially different result the system should want.

Valid intents include:

- Find the controlling implementation and its direct callers.
- Rewrite a named function to supplied pseudocode while preserving its API.
- Apply a supplied signature change to direct call sites and run a named test.
- Find the narrowest tests covering a specified behavior.

Invalid intents include:

- Diagnose why a subsystem is unreliable.
- Choose an authentication design and implement it.
- Refactor a persistence layer.
- Decide which of two user-visible behaviors is preferable.

Workers reject broad intents before execution when possible. If consequential
ambiguity appears during execution, the transaction enters `decision_required`
and returns a compact question, options, and evidence handle. `resume` continues
the same durable worker context after the frontier answers.

## Runtime Shape

The existing portal tools are built once as raw `PortalTool` capabilities.
Architecture-specific assembly then either exposes them directly or closes over
them from the semantic/PTC layer:

```text
PortalTool capability builders
        |                      |
        v                      v
standard exposure       semantic exposure
PortalTool -> pi         resolve/resume/readers/program
                               |
                 +-------------+-------------+
                 |                           |
          semantic worker              PTC runtime
        sequential primitives     capability RPC only
```

The semantic implementation lives under `src/lib/server/semantic/`; PTC lives
under `src/lib/server/ptc/`. Shared production behavior remains in the existing
tool builders and permission gate. Standard mode must not import semantic
runtime state or expose experimental tool definitions.

## Worker Model And Prompt

Semantic mode has a per-conversation optional worker model. When unset, the
server chooses a configured cheap model; if no worker model is configured, the
frontier model is used so the architecture remains testable without a second
provider.

The worker receives:

1. A stable system prefix containing its role, decision boundary, tool-use
   protocol, escalation rules, and primitive tool definitions.
2. Stable repository context supplied by pi's normal context-file loading.
3. The transaction intent, constraints, completion conditions, and relevant
   continuation state at the end of the request.

The stable prefix must remain byte-for-byte stable across transactions for the
same worker tool set. Dynamic conversation ids, timestamps, intent text, and
artifact ids must not enter that prefix. Pi places the system prompt before
messages and tool definitions in provider requests; providers that support
prefix caching can therefore cache this common prefix. Provider-reported
`cacheRead` and `cacheWrite` usage is recorded separately for worker calls.

Worker guidance is intentionally short. Behavioral requirements belong in one
stable system block rather than being repeated across tool descriptions.
Primitive descriptions remain compact and factual.

## Permissions And Events

The outer semantic tools do not request blanket workspace permission. Every
worker primitive call uses the existing portal permission resolver with the
same user, conversation, policy, approval mode, grants, and workspace roots as
the frontier. A write prompt therefore names the actual write operation and
target rather than `resolve`.

Worker events are parented to the frontier semantic tool call and use the
existing nested tool/reasoning/edit persistence model. Permission requests are
emitted into the active parent turn queue. Cancellation of the parent turn
aborts the worker and any active primitive operation.

The transaction trace retains all primitive calls and permission outcomes.
Normal frontier results contain only counts, material findings, validation
summaries, and artifact handles.

## Transactions And Artifacts

Transactions are durable because a decision prompt may outlive a pooled pi
session or server process. Each transaction records:

- conversation, parent tool call, worker model, and worker session path;
- intent, constraints, completion conditions, and status;
- pending decision when suspended;
- evidence, changeset, trace, and output artifact references;
- timestamps and aggregate usage.

Artifacts are immutable, conversation-scoped, and tied to a workspace snapshot
or transaction revision. Readers authorize both the conversation and artifact
ownership. Large values are paginated by opaque cursor and token/byte budget.

Evidence and traces are structured JSON. Changesets store the base metadata and
unified diff. Large command output is stored outside SQLite using the portal's
scratch artifact convention, with metadata and ownership in SQLite.

## Programmatic Tool Calling

`program` accepts JavaScript authored by the frontier and runs it in a
resource-limited QuickJS/WASM isolate. The program has no ambient filesystem,
network, environment, module loading, child process, or host object access. It
can only call an asynchronous `tools` capability object and return
JSON-compatible data.

Each capability call dispatches through the same `PortalTool` handlers and
permission resolver used by standard mode. The PTC process enforces:

- wall-clock and operation-count budgets;
- output and per-operation result limits;
- cancellation propagation;
- JSON-only RPC messages;
- no semantic worker or recursive `program` capability.

The sandbox uses a separate JavaScript engine with explicit memory, stack,
operation-count, output-size, and wall-clock budgets. Node's in-process `vm`
context alone is not acceptable. The initial tool set is read-oriented plus
explicitly selected mutation and validation capabilities; interactive tools are
excluded.

## Persistence And UI

Add `agent_architecture` to conversations with default `standard`. Add an
optional `semantic_worker_model` selection. Both are copied on fork.

The conversation header exposes an `Architecture` segmented control and worker
model picker. Changes are rejected during an active turn and release the pooled
session because pi fixes the tool set at session creation. Existing mode,
approval, memory, and tool-group controls remain orthogonal.

The most reliable A/B workflow is to fork from the same message and choose a
different architecture on each branch. A mid-conversation toggle is useful for
manual testing but is not treated as a controlled comparison.

## Token And Cost Budgets

The semantic frontier definitions and their prompt guidance have regression
budgets. Initial targets are:

- at most nine frontier tools in semantic mode;
- at most 8 KiB serialized definitions for the semantic frontier surface;
- at most 6 KiB of semantic frontier system guidance;
- at most 24 KiB serialized primitive definitions for workers;
- no artifact body returned by default above 4 KiB;
- no worker trace returned to the frontier unless requested or failed.

These byte budgets are stable proxies, not token estimates. Tests report both
bytes and approximate tokens for review. Descriptions are expanded only when a
measured model failure demonstrates that additional in-context guidance is
needed.

Record per turn and per semantic transaction:

- model, architecture, input/output/cache-read/cache-write tokens, and cost;
- frontier turns, worker turns, primitive operations, and PTC operations;
- elapsed time, permission prompts, retries, suspensions, and artifact reads;
- validation commands and outcomes.

The evaluation metric is cost and latency per correctly completed task, not
schema size in isolation.

## Implementation Sequence

1. Persistence, shared types, API propagation, session recreation, and UI.
2. Split raw capability construction from standard pi exposure without changing
   standard behavior.
3. Compact semantic tool definitions and token-budget tests.
4. Worker loop with read-only capabilities, nested events, cancellation, usage,
   and permission propagation.
5. Worker mutation/validation capabilities and changeset capture.
6. Durable transactions, `resume`, and deterministic artifact readers.
7. Sandboxed PTC and capability RPC.
8. Stub-model integration tests, end-to-end architecture switching, paired-fork
   evaluation, documentation, and full verification.

## Acceptance Criteria

- Standard mode passes the existing full verification gate unchanged.
- Semantic and standard conversations expose disjoint expected tool surfaces.
- Architecture changes persist, fork correctly, and recreate idle sessions.
- Active-turn architecture changes return conflict without partial mutation.
- A semantic worker can inspect, edit, validate, suspend, and resume while all
  primitive permissions and nested events remain visible and auditable.
- Artifact readers cannot access another conversation's artifacts.
- PTC cannot directly read files, environment variables, network resources, or
  spawn processes, and every capability operation is permission checked.
- Token-size regression tests enforce the stated budgets.
- Usage records distinguish frontier, worker, and PTC costs.
- `pnpm run verify` passes.

## Evaluation

Use a fixed suite of local repository tasks in paired forks:

- bounded code-path discovery;
- supplied function rewrite;
- signature propagation;
- regression-test addition;
- adaptive wrapper traversal;
- one deliberately ambiguous task that must suspend.

Compare correctness, human interventions, total cost, wall time, frontier turns,
context growth, cache effectiveness, retries, and artifact expansion frequency.
The semantic architecture is successful only if quality remains comparable and
the total task economics improve; reducing visible frontier tokens alone is not
sufficient.