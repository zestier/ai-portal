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
| `load_program_tools` | Load the contracts for selected portal-specific capabilities and make them eligible for use by `program`. |
| `read_evidence` | Retrieve selected grounding captured by a transaction. |
| `read_changeset` | Retrieve selected changes or a diff captured by a transaction. |
| `read_trace` | Retrieve worker actions, primarily for failure diagnosis. |
| `read_output` | Retrieve selected command or validation output. |
| `ask_user` | Preserve direct frontier-to-human interaction. |

The tools use separate, shallow schemas. They do not use tagged unions. Tool
results include compact previews and opaque handles so the frontier only reads
large artifacts when they could change its next decision.
`load_program_tools` replaces `describe_capabilities`; semantic mode does not
expose both. There is no list mode or compatibility alias. Available names and
tiny usage descriptions come from the system-prompt catalog, while the loader
is the only path that discloses complete program-tool contracts.
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
can only use explicitly installed compatibility facades and loaded capabilities,
and it can return only JSON-compatible data.

### Native-like compatibility facades

Common operations should be exposed with familiar JavaScript APIs where the
portal can preserve their expected semantics. Initial candidates include
Promise-based file operations such as `fs.readFile`, `fs.writeFile`,
`fs.readdir`, and `fs.stat`, plus `fetch`. These names are installed directly in
the program environment rather than under `tools`, so generated programs look
and behave like ordinary JavaScript:

```js
const source = await fs.readFile("src/index.ts", "utf8");
const response = await fetch("https://example.test/data");
return { source, text: await response.text() };
```

#### Initial facade contract

The first implementation installs these globals in every program without a
load step:

```ts
interface ProgramFs {
   readFile(path: string, encoding: "utf8" | "utf-8"): Promise<string>;
   writeFile(
      path: string,
      data: string,
      options?: { encoding?: "utf8" | "utf-8" },
   ): Promise<void>;
   readdir(
      path: string,
      options?: { withFileTypes?: false },
   ): Promise<string[]>;
   stat(path: string): Promise<ProgramStats>;
}

interface ProgramStats {
   size: number;
   mtimeMs: number;
   isFile(): boolean;
   isDirectory(): boolean;
   isSymbolicLink(): boolean;
}

declare const fs: ProgramFs;

declare function fetch(
   input: string,
   init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      redirect?: "follow" | "error" | "manual";
   },
): Promise<ProgramResponse>;

interface ProgramResponse {
   readonly ok: boolean;
   readonly status: number;
   readonly statusText: string;
   readonly url: string;
   readonly redirected: boolean;
   readonly headers: ProgramHeaders;
   text(): Promise<string>;
   json(): Promise<unknown>;
}

interface ProgramHeaders {
   get(name: string): string | null;
   has(name: string): boolean;
   entries(): IterableIterator<[string, string]>;
}
```

Only these signatures are promised. The first version has no binary encodings,
`Buffer`, request or response streams, abort signal crossing, file descriptors,
recursive directory options, or synchronous APIs. Unsupported arguments fail
with an error naming the unsupported surface; they must not be silently ignored.

The QuickJS bootstrap implements `ProgramStats`, `ProgramResponse`, and
`ProgramHeaders` as isolate-local JavaScript objects over JSON RPC results. The
host never passes a Node object into the isolate. `Response.text()` may be
called repeatedly; `Response.json()` parses the cached text and reports normal
`JSON.parse` errors. Response bodies are read and size-limited on the host
before the RPC resolves. This deliberately differs from native single-consume
body streams and must appear in stable program guidance.

Each facade method maps to a named internal capability adapter. Adapters reuse
the same path normalization, workspace containment, network policy, permission
resolver, event emission, cancellation, result-size limit, and audit record as
the corresponding portal tool. Facades do not call Node `fs` or host `fetch`
directly from the sandbox bridge. Internal adapter names are not visible to the
frontier and cannot be invoked through `tools`.

The stable semantic system prompt includes the facade names, the declaration
above in compact form, and the documented deviations. Facade availability is
versioned with the semantic tool surface; changing a signature is a contract
change covered by prompt-size and runtime tests.
These are compatibility facades, not references to Node or host objects. Every
operation crosses the same JSON-only capability RPC boundary and is authorized
by the existing permission resolver. The facade grants no ambient filesystem
or network access. Synchronous Node APIs are excluded because host capability
calls are asynchronous.

Facade signatures should match the established API closely enough that a model
can use them from existing JavaScript knowledge without loading a schema. Where
an exact match cannot cross the isolate boundary, the difference must be small,
explicit, and covered by the stable program guidance. Host objects such as
`Buffer`, streams, file handles, and the native `Response` cannot cross the RPC
boundary directly. The runtime may provide JSON-safe polyfills, such as a
text-oriented `Response` with familiar methods, while binary and streaming
support remain out of scope.

### Portal-specific program tools

Capabilities without a standard JavaScript analogue remain available under
`tools.<name>`. The semantic frontier system prompt contains only each available
name and a very short description of when to use it. It does not include their
full schemas.

Before using one of these capabilities, the frontier calls
`load_program_tools({ names: [...] })`. The result provides the complete input
contract, the JSON-safe result contract, and a compact usage example for each
requested name. Loading is intentionally distinct from authorization: it means
that the API contract has been delivered to the frontier and that the runtime
may expose the name to a subsequent program; each operation still passes
through normal permission checks.

The frontier API is:

```ts
load_program_tools({ names: string[] }): {
   receipt: string;
   tools: Array<{
      name: string;
      description: string;
      parameters: JsonSchema;
      result: JsonSchema;
      example: string;
      contractVersion: string;
   }>;
};

program({
   source: string;
   tools?: string[];
   receipts?: string[];
}): {
   value: unknown;
   operations: number;
};
```

`load_program_tools` is all-or-nothing. It canonicalizes and deduplicates names,
rejects unknown or non-programmable capabilities, and returns one receipt for
the exact sorted set. A tool contract consists of its name, description, input
schema, output schema, example, and contract version. Every program-capable
portal tool must define all of these fields; it cannot be added to the compact
catalog otherwise. The output schema describes the actual JSON value returned
inside the program, not the portal UI rendering.

The compact catalog is generated from currently enabled programmable
capabilities and inserted into semantic frontier guidance as one line per tool:

```text
Program tools (load before use): grep — search workspace text; git_diff — read repository changes.
```

This catalog is discovery metadata only. It contains no schemas, examples, or
permission implications. The `load_program_tools` description and result both
say explicitly that the returned receipt must be supplied to `program`.

`program.tools` declares the complete set of portal-specific names the source
may invoke. `program.receipts` supplies the contracts on which the source was
authored. The union of valid receipts must cover exactly the declared names;
extra loaded names are rejected as stale or accidental exposure, and duplicate
receipts are rejected. Programs using only `fs`, `fetch`, and JavaScript may
omit both fields.

`program` must reject a portal-specific capability that has not been loaded,
with an actionable error such as:

```text
Program tool "grep" is not loaded. Call load_program_tools({ names: ["grep"] })
before using it.
```

This check is enforced dynamically at the capability proxy, including computed
property access. Static inspection of `tools.<name>` may provide an earlier
diagnostic but is not an enforcement boundary.

#### Receipt and ancestry model

Loaded state is derived from persisted transcript provenance, never from a
pooled pi session or process-global set. A receipt has this versioned payload:

```ts
interface ProgramToolReceiptV1 {
  version: 1;
  nonce: string;
  names: string[]; // sorted and unique
  contractsHash: string;
  capabilityFingerprint: string;
}
```

The serialized payload is authenticated with a server-side HMAC and encoded as
an opaque string. `contractsHash` covers the canonical full contracts returned
by the load. `capabilityFingerprint` covers the enabled tool groups, facade
contract version, and names and contract versions of all currently programmable
capabilities. The random nonce makes separate load events distinguishable even
when their contracts are identical. Receipts contain no conversation or
database IDs so a fork can inherit one without rewriting the visible result.

Successful `load_program_tools` calls are ordinary persisted tool calls. Before
running a program, the server:

1. Authenticates and decodes every receipt.
2. Queries completed `load_program_tools` calls in the current conversation's
   persisted message prefix up to, but not including, the current assistant
   message.
3. Extracts receipts from their stored successful results and requires an exact
   string match for every supplied receipt.
4. Recomputes the current capability fingerprint and each referenced contract
   hash.
5. Requires the receipt union to equal `program.tools`.
6. Constructs the runtime capability map from the declared names only.

Step 2 is the context-presence check. Forking clones retained tool calls and
their result JSON into new rows, so inherited receipts remain discoverable even
though message and tool-call IDs change. Rewinding deletes suffix messages and
their tool calls, so receipts loaded only in that suffix cease to validate.
Session recreation has no special path because validation reads the same
persisted transcript each time. A receipt copied from another conversation is
cryptographically valid but fails context presence unless its load result is
also in the current inherited prefix.

The current assistant message is excluded to make parallel tool calls
deterministic: a `program` call cannot observe a sibling `load_program_tools`
call issued in the same model response, regardless of execution order. The
frontier must load in one response and run the program in a later response.
This costs one model round trip but gives the contract a clear causal position
in model-visible context.

These rules satisfy the required history invariants:

- a fork inherits only loads present in its inherited message ancestry;
- rewinding before a load removes that load from eligibility;
- session recreation reconstructs the same loaded set deterministically;
- capability or tool-group changes invalidate incompatible loads;
- concurrent calls cannot observe loads from a different branch or history;
- traces identify both the declared tool set and the contract version loaded.

Changing enabled tool groups, a programmable tool contract version, or the
facade contract version changes the capability fingerprint and invalidates old
receipts. The resulting error lists the names that must be loaded again but
does not return their schemas. Architecture changes release the pi session as
they do today; no receipt cache needs clearing.

#### Runtime call and result semantics

The QuickJS `tools` proxy accepts any property syntactically but checks each
call against the declared runtime map before dispatch. An undeclared call
returns this actionable failure without invoking a portal handler:

```text
Program tool "grep" is not declared and loaded. Call
load_program_tools({ names: ["grep"] }), then pass its receipt and
tools: ["grep"] to program.
```

Tool calls resolve to a normalized JSON result rather than the internal
`ToolResult` envelope:

```ts
type ProgramToolResult<T> =
   | { ok: true; value: T }
   | { ok: false; error: { message: string; code?: string; details?: unknown } };
```

The loader's output schema describes `T`; stable guidance documents the wrapper
once. Permission denial and normal tool failure resolve to `ok: false` so a
program may branch or aggregate failures. RPC failures, invalid JSON,
cancellation, and exhausted budgets reject the capability Promise and abort the
program. This distinction must be implemented in one shared adapter rather
than independently by each tool.

Every operation emits the existing nested tool lifecycle and permission events.
The parent `program` trace records source hash, supplied receipt hashes,
declared names, facade operations, portal-tool operations, duration, outcome,
and budget consumption. Raw receipt values are retained in persisted tool
arguments but omitted from routine summaries and logs.

Each capability call dispatches through the same `PortalTool` handlers and
permission resolver used by standard mode. The PTC process enforces:

- wall-clock and operation-count budgets;
- output and per-operation result limits;
- cancellation propagation;
- JSON-only RPC messages;
- loaded and declared portal-specific capability sets;
- no semantic worker or recursive `program` capability.

The sandbox uses a separate JavaScript engine with explicit memory, stack,
operation-count, output-size, and wall-clock budgets. Node's in-process `vm`
context alone is not acceptable. The initial tool set is read-oriented plus
explicitly selected mutation and validation capabilities; interactive tools are
excluded.

### PTC implementation plan

1. Extend `PortalTool` with optional `program` metadata containing the result
   schema, compact catalog description, example, and explicit contract version.
   Mark the initial programmable tools and keep interaction, permission-control,
   semantic, artifact-reader, and recursive program tools excluded.
2. Replace `describe_capabilities` with `load_program_tools` in the semantic
   frontier. Remove the old tool definition, guidance, tests, and summaries;
   do not retain an alias. Add canonical contract serialization, capability
   fingerprinting, and authenticated receipt encoding.
3. Add a repository query that finds successful load receipts in completed
   assistant messages before the current assistant message. Pass the current
   message identity into semantic tool handlers through `ToolStreamContext` so
   validation has an unambiguous upper bound.
4. Change the `program` schema to require declared names and receipts when
   portal-specific tools are used. Validate provenance and fingerprints before
   creating QuickJS or performing any operation.
5. Restrict the QuickJS capability proxy to the validated declared map and
   normalize portal results to `ProgramToolResult`.
6. Add the `fs` facade over existing filesystem capability adapters. Ship
   `readFile`, `writeFile`, `readdir`, and `stat` together so the advertised
   namespace is not partial.
7. Add text-only `fetch`, `ProgramResponse`, and `ProgramHeaders` polyfills
   after a host network capability and permission scope exist. Until then,
   omit `fetch` from both globals and guidance rather than exposing a stub.
8. Update semantic guidance, token budgets, tool summaries, audit views, and
   the stub model's semantic scenarios.

The implementation should introduce focused modules under
`src/lib/server/ptc/`: `contracts.ts` for metadata canonicalization and hashes,
`receipts.ts` for encoding and authentication, `provenance.ts` for transcript
validation, `facades.ts` for host adapters, and `bootstrap.ts` for isolate-local
polyfills. `program.ts` remains responsible for budgets and QuickJS lifecycle.
Semantic frontier definitions stay in `src/lib/server/semantic/tools.ts`.

No new persistence table is required. The persisted load tool call and result
are the provenance record, existing fork logic copies them, and existing rewind
logic removes them. Receipt authentication uses a key derived for this purpose
from the configured server encryption key; the derivation label and receipt
version are stable constants. A missing encryption key follows the portal's
existing development-key policy rather than introducing an independent secret.

### PTC test specification

Unit tests must cover:

- canonical contract hashing and receipt authentication and tamper rejection;
- catalog filtering by enabled tool groups and program eligibility;
- unknown, duplicate, excluded, and mixed-validity load requests;
- absence of `describe_capabilities` from semantic frontier tools and guidance;
- exact declared-name coverage across one or several receipts;
- stale contract and capability fingerprints;
- undeclared direct and computed-property calls before handler dispatch;
- normalized success, tool failure, permission denial, RPC failure, and abort;
- operation, output, memory, stack, and wall-clock budgets;
- facade signatures, unsupported options, path containment, and permission
  derivation;
- text response methods, headers, redirects, body limits, and malformed JSON.

Integration tests must persist real message and tool-call rows and prove:

- a normal later turn can use a load receipt;
- a sibling load and program call in one assistant message cannot race;
- a fork after the load inherits it;
- a fork or rewind before the load rejects it;
- cloned message and tool-call IDs do not invalidate an inherited receipt;
- a receipt copied from an unrelated conversation is rejected;
- session release and recreation do not change validation;
- changing enabled tool groups or contract versions requires reloading;
- every facade and loaded operation passes through the permission resolver and
  appears as nested activity under `program`.

An end-to-end semantic-mode scenario must have the stub model load a tool, use
the returned receipt in a later program call, fork on each side of the load,
and assert the corresponding accepted and rejected branches. The full
`pnpm run verify` gate remains required.

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