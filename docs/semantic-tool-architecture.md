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
| `get_program_tool_schemas` | Retrieve full contracts for selected program capabilities when names and compact descriptions are insufficient. |
| `read_evidence` | Retrieve selected grounding captured by a transaction. |
| `read_changeset` | Retrieve selected changes or a diff captured by a transaction. |
| `read_trace` | Retrieve worker actions, primarily for failure diagnosis. |
| `read_output` | Retrieve selected command or validation output. |
| `ask_user` | Preserve direct frontier-to-human interaction. |

The tools use separate, shallow schemas. They do not use tagged unions. Tool
results include compact previews and opaque handles so the frontier only reads
large artifacts when they could change its next decision.
`get_program_tool_schemas` replaces `describe_capabilities`; semantic mode does
not expose both. There is no list mode or compatibility alias. Available names
and tiny usage descriptions come from the system-prompt catalog, while schema
lookup is an optional precision and recovery path rather than a prerequisite
for execution.
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

`program` runs model-authored JavaScript in a resource-limited QuickJS/WASM
isolate. The program has no ambient filesystem,
network, environment, module loading, child process, or host object access. It
can only use explicitly installed compatibility facades and program
capabilities, and it can return only JSON-compatible data.

### Native-like compatibility facades

Common operations should be exposed with familiar JavaScript APIs where the
portal can preserve their expected semantics. The initial facade includes
Promise-based file operations `fs.readFile`, `fs.writeFile`, `fs.readdir`,
`fs.stat`, `fs.mkdir`, and `fs.rename`. Filesystem operations are not repeated
under `tools`; edits use read-transform-write. A text-only `fetch` is reserved
for a later version after the portal has an audited network capability and
permission scope. Facades are installed directly in the program environment,
so generated programs look and behave like ordinary JavaScript:

```js
const source = await fs.readFile("src/index.ts", "utf8");
await fs.writeFile("tmp/source.txt", source);
return { source };
```

#### Initial facade contract

The first implementation installs `fs` in every program without a load step:

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
   mkdir(path: string): Promise<void>;
   rename(oldPath: string, newPath: string): Promise<void>;
}

interface ProgramStats {
   size: number;
   mtimeMs: number;
   isFile(): boolean;
   isDirectory(): boolean;
   isSymbolicLink(): boolean;
}

declare const fs: ProgramFs;

declare const path: {
   join(...parts: string[]): string;
   dirname(path: string): string;
   basename(path: string, suffix?: string): string;
   extname(path: string): string;
   normalize(path: string): string;
   relative(from: string, to: string): string;
   isAbsolute(path: string): boolean;
};

declare const command: {
   run(
      executable: string,
      args?: string[],
      options?: {
         cwd?: string;
         stdin?: string;
         timeoutMs?: number;
      },
   ): Promise<{ stdout: string; stderr: string }>;
};
```

These globals are predeclared; programs must not use `import`, `require`, or
module loading. `path` uses POSIX separators and intentionally omits `resolve`:
filesystem calls accept workspace-relative paths and enforce their own root.
Programs return their final value directly, such as `return { results }`; they
must not use `console` output or pre-serialize the value with `JSON.stringify`.
Returned values must be JSON-compatible, and completing with `undefined` is an
error rather than an empty successful result.

Only these signatures are promised. The first version has no binary encodings,
`Buffer`, abort signal crossing, file descriptors, recursive directory options,
or synchronous APIs. Unsupported arguments fail with an error naming the
unsupported surface; they must not be silently ignored.

`command.run` executes an explicit argv without shell parsing. Its optional
bounded string `stdin` supports program-level composition; nonzero exits,
timeouts, cancellation, and output over the bridge limit throw. Direct-mode
`bash` remains available outside `program` but is not a program capability.

The QuickJS bootstrap implements `ProgramStats` as an isolate-local JavaScript
object over JSON RPC results. The host never passes a Node object into the
isolate.

Each facade method maps to a named internal capability adapter. Adapters reuse
the same path normalization, workspace containment, permission resolver, event
emission, cancellation, result-size limit, and audit record as the corresponding
portal tool. Facades do not call Node `fs` directly from the sandbox bridge.
Internal adapter names are not visible to the model and cannot be invoked
through `tools`.

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
`tools.<name>`. The system prompt contains each available name and a short
description, but not its full schema.

Every catalogued program tool in the conversation's current enabled capability
set is installed in the `tools` proxy for every `program` call. The model may
call it directly by guessing the object argument from its name and compact
description. There is no load state, receipt, declaration list, ancestry check,
or extra authority associated with schema lookup. Forks, rewinds, session
recreation, and parallel tool calls therefore need no special schema-state
handling.

Program tool calls return their successful result directly and throw on tool,
validation, or permission failure. They do not expose the portal's `{ ok,
result }` transport envelope inside the isolate:

```js
const matches = await tools.grep({ pattern: "ProgramArgs", path: "src" });
return matches;
```

When the name is ambiguous, the first guessed call fails validation, or exact
result handling matters, the model may request full contracts:

```ts
get_program_tool_schemas({ names: string[] }): {
   tools: Array<{
      name: string;
      description: string;
      parameters: JsonSchema;
      result: JsonSchema;
      example: string;
      contractVersion: string;
   }>;
};

program({ source: string }): {
   value: unknown;
   operations: number;
};
```

`get_program_tool_schemas` canonicalizes and deduplicates names and returns an
entry for every requested name. Unknown or non-programmable names produce
per-name errors alongside suggestions rather than failing the whole lookup. A
tool contract consists of its name, description, canonical input schema,
output schema, example, and contract version. Every program-capable portal tool
must define at least the canonical input and output contracts; it cannot be
added to the compact catalog otherwise. The output schema describes the actual
JSON value returned inside the program, not the portal UI rendering.

The compact catalog is generated from currently enabled programmable
capabilities and inserted into semantic guidance as one line per tool:

```text
Program tools: grep — search workspace text; git_diff — read repository changes.
```

This catalog is discovery metadata only. It contains no schemas, examples, or
permission implications. `get_program_tool_schemas` is deliberately optional;
guidance recommends it after uncertainty or validation failure, but does not
require a separate discovery turn before an obvious call.

#### Program compatibility forms

Program tools may accept a small number of additional argument forms designed
for likely model guesses. These forms exist only at the PTC boundary and do not
change the normal portal tool schema. For example, a program `grep` adapter may
accept all of these:

```js
await tools.grep({ pattern: "ProgramArgs", path: "src" });
await tools.grep({ query: "ProgramArgs", include: "src/**" });
await tools.grep({ regex: "ProgramArgs", cwd: "src" });
```

Each programmable tool has one pure normalizer that maps every accepted form to
its canonical portal arguments before Zod validation, permission derivation,
handler dispatch, audit logging, and tracing. Permission checks use only the
normalized canonical arguments. Compatibility aliases must not broaden target
scope, weaken validation, infer authority-bearing options, or alter operation
semantics. Ambiguous combinations fail with an error showing the canonical
form and recommending `get_program_tool_schemas`.

Compatibility should target high-confidence vocabulary variants, not attempt
to recognize arbitrary objects. Accepted forms are hidden implementation
details, not part of schema lookup or the public tool contract. They are covered
by equivalence tests proving that canonical and compatibility forms produce
identical validated arguments. The runtime may evolve this tolerance without a
contract-version change as long as canonical behavior and authority remain
unchanged.

The first implementation defines compatibility normalizers only for built-in
portal tools. Allowing a custom tool to replace a built-in program capability,
add accepted forms, or supply its own normalization function is deferred. A
future extension design must define naming conflicts, trust and isolation of
normalizer code, versioning, audit presentation, and whether custom forms may
affect permission derivation before exposing such a hook.

#### Runtime call and result semantics

The QuickJS `tools` proxy accepts any property syntactically and checks the name
against the current program capability map before dispatch. An unknown or
disabled call returns an actionable failure without invoking a portal handler:

```text
Unknown program tool "search". Available related tools: grep. Call
get_program_tool_schemas({ names: ["grep"] }) for its exact contract.
```

Tool calls resolve to a normalized JSON result rather than the internal
`ToolResult` envelope:

```ts
type ProgramToolResult<T> =
   | { ok: true; value: T }
   | { ok: false; error: { message: string; code?: string; details?: unknown } };
```

The schema lookup's output contract describes `T`; stable guidance documents
the wrapper once. Permission denial and normal tool failure resolve to
`ok: false` so a program may branch or aggregate failures. RPC failures,
invalid JSON, cancellation, and exhausted budgets reject the capability Promise
and abort the program. This distinction must be implemented in one shared
adapter rather than independently by each tool.

Every operation emits the existing nested tool lifecycle and permission events.
The parent `program` trace records source hash, invoked names, compatibility
forms used, normalized argument hashes, facade operations, portal-tool
operations, duration, outcome, and budget consumption.

Each capability call dispatches through the same `PortalTool` handlers and
permission resolver used by standard mode. The PTC process enforces:

- wall-clock and operation-count budgets;
- output and per-operation result limits;
- cancellation propagation;
- JSON-only RPC messages;
- enabled program-capability filtering and argument normalization;
- no semantic worker or recursive `program` capability.

The sandbox uses a separate JavaScript engine with explicit memory, stack,
operation-count, output-size, and wall-clock budgets. Node's in-process `vm`
context alone is not acceptable. The initial tool set is read-oriented plus
explicitly selected mutation and validation capabilities; interactive tools are
excluded.

### PTC implementation plan

1. Extend `PortalTool` with optional `program` metadata containing the result
   schema, compact catalog description, example, internal compatibility
   normalizer, and explicit contract version.
   Mark the initial programmable tools and keep interaction, permission-control,
   semantic, artifact-reader, and recursive program tools excluded.
2. Replace `describe_capabilities` with `get_program_tool_schemas` in the semantic
   frontier. Remove the old tool definition, guidance, tests, and summaries;
   do not retain an alias. Generate the compact catalog from program metadata
   and return exact contracts only for requested names.
3. Install every enabled programmable capability in each `program` call. Route
   arguments through the program normalizer, canonical validator, permission
   resolver, and existing handler in that order.
4. Normalize portal results to `ProgramToolResult` and add actionable unknown
   name and invalid-arguments errors that point to schema lookup.
5. Add the `fs` facade over existing filesystem capability adapters. Ship
   `readFile`, `writeFile`, `readdir`, and `stat` together so the advertised
   namespace is not partial.
6. Add text-only `fetch`, `ProgramResponse`, and `ProgramHeaders` polyfills
   after a host network capability and permission scope exist. Until then,
   omit `fetch` from both globals and guidance rather than exposing a stub.
7. Update semantic guidance, token budgets, tool summaries, audit views, and
   the stub model's semantic scenarios.

The implementation should introduce focused modules under
`src/lib/server/ptc/`: `contracts.ts` for program metadata and schema lookup,
`normalize.ts` for compatibility forms, `facades.ts` for host adapters, and
`bootstrap.ts` for isolate-local polyfills. `program.ts` remains responsible
for budgets and QuickJS lifecycle. Semantic frontier definitions stay in
`src/lib/server/semantic/tools.ts`. No new persistence or cryptographic state is
required.

### PTC test specification

Unit tests must cover:

- catalog filtering by enabled tool groups and program eligibility;
- unknown, duplicate, excluded, and mixed-validity schema requests;
- absence of `describe_capabilities` from semantic frontier tools and guidance;
- availability of obvious tools without a prior schema request;
- direct and computed-property unknown calls before handler dispatch;
- compatibility-form equivalence and ambiguous-form rejection;
- normalization before validation, permission derivation, audit, and dispatch;
- normalized success, tool failure, permission denial, RPC failure, and abort;
- operation, output, memory, stack, and wall-clock budgets;
- facade signatures, unsupported options, path containment, and permission
  derivation;
- text response methods, headers, redirects, body limits, and malformed JSON.

Integration tests must prove:

- a program can guess and call an obvious tool without schema lookup;
- schema lookup followed by a program call works across normal turns, forks,
   rewinds, and session recreation without runtime state;
- disabled tool groups remove names from both catalog, lookup, and runtime;
- canonical and compatibility forms derive identical permission requests;
- every facade and program-tool operation passes through the permission
   resolver and appears as nested activity under `program`.

End-to-end semantic-mode scenarios must exercise both paths: one where the stub
model directly guesses an obvious tool shape, and one where an invalid guess
causes it to request the exact schema and retry successfully. The full
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