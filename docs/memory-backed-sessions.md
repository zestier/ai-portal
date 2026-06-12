# Memory-backed stateless sessions

## Summary

This document proposes an optional memory-backed session mode for the portal. In
this mode, every assistant turn is generated from a fresh context assembled from
durable session memory, retrieved history, and explicit memory tools rather than
from a long-running model context window.

The core goal is to make long-running chats more reliable across domains:

- coding sessions that need to remember decisions, failed approaches, and open
  tasks without treating stale memory as current repository truth
- story and role-playing sessions that need stable world state, character
  continuity, and recall of small details
- mystery or investigation sessions that need strict timelines, clue tracking,
  knowledge boundaries, and contradiction checks
- research, planning, and support sessions that need durable decisions,
  evidence, unresolved questions, and provenance

The important design principle is that memory should be explicit, typed,
inspectable, reversible, and scoped. The model remains the language and reasoning
engine; the portal becomes the continuity and state-management layer.

## Implementation status

The portal now includes the full production-oriented foundation described here:

- opt-in memory-backed turns with fresh context, initial packets, and mandatory
  memory tools
- typed session memory tables, patch audit trails, validation issues, global
  memory, and FTS (full-text) search
- memory inspector workflows for edit, delete, wipe, and individual
  patch-item approve/reject review
- per-conversation controls for memory mode, harvester backend + model override,
  and explicit global-memory tool opt-in (with user-level seed defaults in
  Settings → General)
- model-backed extraction metadata, strict-mode validators, and timeline/alibi
  conflict checks
- custom memory profile persistence and settings UI groundwork for user-authored
  schemas/instructions
- relevance-conditioned packet injection: facts/entities/events are ranked
  against the current turn (user message + recent transcript) using the FTS
  ranking that powers `memory_search`, with a token-budgeted body,
  an always-present entity-key index, and a server-side auto-search prestep
- source-side consolidation as a projection derivation: each observation is one
  `fact.create` event, and a consolidation pass (run live and on every rebuild)
  derives the active set — deduping re-observations and superseding single-valued
  predicates. Supersession is never stored, so a rebuild re-derives the correct
  active facts for free. A `pinned` flag plus confidence/recency form the
  salience used to rank by durable importance instead of bare `updated_at`

## Non-goals

- Do not replace the existing default chat flow. Memory-backed sessions should be
  opt-in.
- Do not start with cross-session memory. Per-session memory is the safe default.
- Do not treat extracted memories as unquestionable truth. Every durable memory
  needs provenance, status, and correction paths.
- Do not let coding memory override current files or tool results. Repository
  memory is advisory until revalidated.
- Do not hide memory behavior from users. The system must expose what it
  remembered and allow users to correct it.

## High-level architecture

Memory-backed sessions use a fresh model context per request:

```text
user message
  -> classify turn and memory profile
  -> retrieve relevant durable memory
  -> expose memory tools for targeted recall
  -> assemble initial turn packet
  -> model response generation in a fresh context
  -> model may call memory tools during generation
  -> extract candidate memory changes
  -> validate memory patch
  -> commit accepted memory changes transactionally
  -> expose memory diff and validation issues to the user
```

The memory engine is a server-side subsystem with a small API boundary:

```ts
interface MemoryEngine {
  buildInitialPacket(input: BuildInitialPacketInput): Promise<TurnMemoryPacket>;
  listTools(input: ListMemoryToolsInput): Promise<MemoryToolDefinition[]>;
  executeTool(input: ExecuteMemoryToolInput): Promise<MemoryToolResult>;
  extractPatch(input: ExtractMemoryPatchInput): Promise<MemoryPatch>;
  validatePatch(input: ValidateMemoryPatchInput): Promise<MemoryValidationResult>;
  commitPatch(input: CommitMemoryPatchInput): Promise<CommittedMemoryPatch>;
}
```

The chat pipeline should not contain story-, coding-, or mystery-specific logic.
Domain behavior belongs in memory profiles and validators.

## First-pass requirement: memory tools are mandatory

If the portal implements fresh-context sessions, memory tools should be part of
the first implementation rather than a later enhancement.

Fresh-context generation without tools creates a brittle failure mode: the
initial packet must predict everything the model will need. That is especially
weak for older details, user corrections, coding attempts, timeline questions,
and mystery clues. A short packet is useful as a working set, but it cannot be
the only recall mechanism.

The first pass should therefore include a minimal, mandatory memory-tool surface:

| Tool | Purpose |
| --- | --- |
| `memory.search` | Search durable facts, events, decisions, and open loops by text, tags, entities, and time range. |
| `memory.get_entity` | Fetch the canonical state and provenance for one entity. |
| `memory.get_open_loops` | Fetch unresolved tasks, plot threads, clues, questions, or commitments. |
| `memory.get_recent_events` | Fetch recent or relevant event-log entries with source turns. |
| `memory.check_claims` | Validate proposed factual claims against known memory and return conflicts or unknowns. |
| `memory.merge_entities` | Fold a duplicate entity into a canonical one — reassigning its facts, events, and open-loop links — to clean up two keys that denote the same referent (e.g. `character.firstname` vs `character.firstname_lastname`). |
| `memory_set_attributes` / `memory_add_directive` / `memory_record_event` / `memory_open_loop` | Durable-write tools used by the background extractor. Each takes a small, flat argument object (or, for `memory_set_attributes`, a shared `entityKey` plus an array of flat trait items, and optional top-level entity metadata to construct the referent); the tool name *is* the classification (no `kind` discriminator). The server validates and stages each call; everything staged across the turn commits once at the end. |
| `memory_keep_loops` / `memory_close_loop` | Open-loop lifecycle: batch-reaffirm still-live loops (anti-aging) and retire a resolved/dropped loop by handle. |
| `memory_forget_attribute` / `memory_forget_directive` | Retire (tombstone) a stale attribute or directive fact that has no natural supersede — the compound-split case or an explicit user retraction. Prefer supersede when the predicate is unchanged. |
| `memory_finish` | Control tool (not a write) the extractor calls to end its run, with an optional `summary`. The only clean way to stop — a tool-call-free turn is nudged toward this rather than treated as "done". Stages nothing and is never dispatched to a write handler, but is surfaced as a tool card so the run visibly ends on an explicit model decision. |

These tools should be available to the model during the main response call for
memory-backed sessions. The model should be instructed to call them whenever a
claim depends on prior state that is not present in the initial packet.

Examples of mandatory recall triggers:

- the user asks whether something happened earlier
- the assistant is about to say "you remember", "previously", or "last time"
- an NPC, character, or stakeholder references past knowledge
- an object, file, task, clue, decision, or promise changes state
- a coding response depends on prior commands, prior failures, or earlier design
  decisions
- a story response depends on character location, inventory, relationship, or
  world rules
- a strict session response depends on timeline, alibi, clue, or visibility
  boundaries

The tool layer gives fresh-context sessions a reliable escape hatch: "not in the
packet" means "query memory", not "invent a plausible continuation."

## Memory profiles

Memory profiles define schema, retrieval behavior, validation strictness, and UI
copy. A session has at most one active profile at a time.

### Off

The current chat behavior. No structured memory extraction, no memory tools, and
no memory packet injection.

### Lightweight

General-purpose memory for ordinary chats.

Stores:

- durable decisions
- user-stated preferences scoped to the session
- open loops
- important facts
- compact running summary

Validation is light. The primary goal is usability without much latency.

### Project

Coding- and research-aware memory.

Stores:

- implementation decisions
- prior attempted fixes
- commands run and their historical results
- unresolved bugs or tasks
- relevant files and concepts
- constraints stated by the user
- design tradeoffs

Important rule:

> Project memory may guide where to inspect, but it must not be treated as
> current repository truth unless revalidated against files, tools, or command
> output.

Project memory should distinguish historical observations from current facts.
For example, "tests failed with error X on turn 12" remains useful, but it does
not mean tests still fail.

### Story

Narrative continuity memory.

Stores:

- characters
- locations
- objects
- relationships
- world rules
- narrator style
- scene state
- player-facing knowledge
- unresolved plot threads

Validation catches obvious continuity problems such as duplicated objects,
impossible appearances, forgotten promises, or inconsistent locations.

### Strict

High-integrity continuity mode for mystery, investigation, simulation, or any
session where small details matter.

Stores everything in Story mode plus:

- timeline
- clue ledger
- per-character knowledge
- secrets and visibility boundaries
- alibis
- evidence provenance
- contradiction-sensitive facts

Strict mode prefers correctness over speed. It should call memory tools more
aggressively and may require memory validation before streaming final claims.

### Future: custom

Custom schemas may eventually allow specialized profile definitions. This should
not be part of the first implementation because schema authoring, migration, UI,
and validation complexity are high.

## Data model

Use both event sourcing and materialized state.

The event log records immutable changes and observations. Materialized state
provides fast current lookup.

Suggested tables:

```text
memory_profiles
memory_entities
memory_events
memory_facts
memory_open_loops
memory_patches
memory_patch_items
memory_validation_issues
memory_tool_calls
```

Potential later tables:

```text
memory_embeddings
memory_entity_links
memory_fact_links
memory_visibility_subjects
```

### `memory_profiles`

Stores the selected mode and profile configuration for a session.

Important fields:

- `session_id`
- `mode`
- `enabled`
- `profile_config_json`
- `created_at`
- `updated_at`

### `memory_entities`

Stores addressable entities.

Examples:

- `character.elias`
- `object.silver_key`
- `file.src_routes_chat`
- `decision.auth_storage`
- `topic.memory_engine`

Important fields:

- `id`
- `session_id`
- `entity_key`
- `entity_type`
- `display_name`
- `summary`
- `status`
- `metadata_json`
- `created_at`
- `updated_at`

### `memory_events`

Immutable event log.

Important fields:

- `id`
- `session_id`
- `turn_id`
- `event_type`
- `occurred_at`
- `actor_entity_id`
- `target_entity_id`
- `summary`
- `payload_json`
- `visibility`
- `confidence`
- `source_message_id`
- `source_tool_call_id`
- `created_at`

Events should not be edited in place. Corrections should append compensating
events or supersede derived facts.

### `memory_facts`

Current and historical facts.

Important fields:

- `id`
- `session_id`
- `entity_id`
- `predicate`
- `value_json`
- `status`
- `visibility`
- `confidence`
- `source_event_id`
- `supersedes_fact_id`
- `pinned` — facts that must always survive packet ranking
- `created_at`
- `updated_at`

`status` (active vs `superseded`) is **derived**, not authored. Each `addFact`
appends one `fact.create` event recording a raw observation; supersession and
dedupe are computed by the projection's consolidation pass (see below), which is
re-run on every rebuild. Nothing stores "this fact superseded that one", so a
projection rebuilt from a stream that omits some observations re-derives the
correct active set on its own.

Status values:

- `active`
- `superseded`
- `disputed`
- `deleted`

### `memory_open_loops`

Unresolved tasks, promises, mysteries, story threads, research questions, and
follow-ups.

Important fields:

- `id`
- `session_id`
- `loop_type`
- `title`
- `description`
- `status`
- `priority`
- `related_entity_ids_json`
- `source_event_id`
- `created_at`
- `updated_at`

Open loops are pruned, not just appended. The extractor retires a loop by
calling `memory_close_loop` — `{ handle, status: "resolved" | "dropped", reason? }` —
which flips an existing loop's `status` so superseded threads stop crowding the
packet. This is how the extractor closes the unchosen options when the user
picks one of several offered choices (`resolved` = done/answered, `dropped` =
abandoned/superseded; the optional `reason` is appended to the loop's
description). Resolutions are recorded as `resolve` patch items for audit and
per-item review.

Attributes and directives can likewise be retired when no natural supersede
applies. The extractor calls `memory_forget_attribute` (`{ handle }` or
`{ entityKey, predicate }`) or `memory_forget_directive` (`{ handle }`) to **tombstone**
an existing fact (`status='deleted'`). The motivating case is the *compound
split*: when the extractor breaks a non-specific attribute
(`description="tall, red hair, fears water"`) into granular facts under new
predicates (`build`, `hair`, `fears`), the original `description` predicate is
never superseded, so it is forgotten directly. The other case is an attribute or
directive the user **explicitly retracted** with no replacement. Forgetting is
recorded as a `forget` patch item for audit and per-item review; an unresolved
target (a stale handle, or an `entityKey`+`predicate`
with no active fact) is a blocking diagnostic rather than a silent no-op. Same
predicate → prefer supersede (re-assert via `memory_set_attributes`); never forget
merely to tidy.

### Open-loop liveness ("touch-to-keep")

Explicit closing is not enough on its own: closing a loop requires the model to
notice that a thread is *no longer* live, and LLMs are far better at reacting to
what is present than at detecting an absence — so historically loops accumulated
forever. Liveness inverts the burden. Every model-backed extraction pass the
extractor is shown all currently-open loops (each with its stable handle) and
reaffirms the ones that are still live via `memory_keep_loops`. A loop that
was **presented but neither kept nor closed** accrues an idle turn, and once it
has been ignored for
`MEMORY_OPEN_LOOP_MAX_IDLE_TURNS + max(0, priority)` consecutive passes it is
auto-dropped. Only presented loops are eligible, so a loop beyond the packet's
open-loop cap is never silently culled, and higher-priority loops get
proportionally more grace.

To make the cutoff actionable rather than silent, the extractor's view of each
open loop is annotated with an `[expires in N passes unless kept]` hint once the
loop is within a couple of passes of its effective threshold (`idle_turns`
relative to `MEMORY_OPEN_LOOP_MAX_IDLE_TURNS + max(0, priority)`). This is purely
a rendering nudge — it changes no state — but it surfaces the pending auto-drop
to the model so it can deliberately reaffirm a still-live loop or close a dead
one this turn. The hint is part of the extractor-only render mode (see
[Packet rendering](#packet-rendering)) and is never shown to the main-turn agent.

Liveness is fully event-sourced. Each pass appends one `open_loop.liveness`
event carrying `{ presented, kept, baseThreshold }`; the per-loop `idle_turns`
column and the terminal auto-drop are *derived* by replaying those events when
the projection is (re)built — exactly like fact supersession — so fork and
rewind reconstruct idle counts and auto-drops faithfully instead of losing them.
The decay threshold is captured in the event payload so a later config change
never rewrites historical decay. The auto-drop itself flows through the normal
open-loop projection, so it is audited and reversible like any other resolution.

Because the tool-calling extractor may spread its keeps across several
`memory_keep_loops` calls, the kept handles are unioned when the staged proposals are
collapsed, and liveness runs once on that collapsed patch (gated to
a cleanly committed, model-backed pass — the heuristic extractor emits no keep
signal, so it never ages loops). The extractor is always handed a freshly built
initial packet so it can see existing entity keys and open-loop ids even on the
production path, which previously passed no packet at all.

### `memory_patches`

Every post-turn extraction should create a patch record, even if no changes are
committed.

Important fields:

- `id`
- `session_id`
- `turn_id`
- `status`
- `summary`
- `raw_patch_json`
- `validation_result_json`
- `created_at`
- `committed_at`

Status values:

- `draft`
- `committed`
- `partially_committed`
- `rejected`
- `needs_review`

### `memory_tool_calls`

Audit trail for model memory-tool usage.

Important fields:

- `id`
- `session_id`
- `turn_id`
- `tool_name`
- `arguments_json`
- `result_summary`
- `result_ids_json`
- `created_at`

This is useful for debugging why the model remembered or asserted something.

## Memory primitives

At the write boundary memory has only **two concepts** — _entities_ (the durable
referents) and _facts_ (everything recorded about them). The extractor records
each item by calling a dedicated per-kind tool, so the classification is the
tool it picks rather than a `kind` field it must set:

The extractor records durable memory by calling **per-kind write tools** — one
flat tool per concept, where the tool name *is* the classification (there is no
`kind` discriminator and no generic patch argument for the model to misassemble):

| Write tool | Meaning | Required fields |
| --- | --- | --- |
| `memory_set_attributes` | Things to KNOW about ONE entity **and** the sole entity constructor: durable current state — values, status, relationships, preferences, constraints, ownership, roles, deadlines, identifiers. Takes a shared top-level `entityKey` and an `attributes` array with one item per **distinct trait** (granular, never one collapsed "description"). To record a brand-new referent, also pass top-level `entityType` + `displayName` (+ optional `summary`/`metadata`) in the same call so it is typed and named instead of auto-minted bare; for an existing referent just pass the changed `attributes`. `attributes` may be omitted for a metadata-only call (a call must supply attributes and/or entity metadata). Entity metadata is a whole-call gate — if it is present but invalid, nothing stages. Each item may carry a thin paired event (`event` summary + optional `eventType`, default `"change"`). Items are validated independently (partial acceptance). | `attributes[]` of `{predicate, value}` and/or entity metadata (`entityType`+`displayName`); optional top-level `entityKey` (required for entity metadata), `summary`, `metadata`; per-item `event`, `eventType` |
| `memory_add_directive` | A per-session standing rule for how the agent must behave going forward ("always do X", "from now on Y", "never Z"). Captured whether the user issues the rule or the assistant declares it about its own role/operating behavior. | `rule` |
| `memory_open_loop` | Open a NEW unresolved task, promise, question, clue, or plot thread. | `loopType`, `title` |
| `memory_record_event` | A point-in-time occurrence for the time-ordered log that is NOT current state (a deploy, failed build, approach tried, clue revealed). Recency-ranked and capped, so used sparingly. | `eventType`, `summary` (+ optional `entityKey`) |
| `memory_keep_loops` | Batch-reaffirm presented open loops that are still live. | `handles[]` |
| `memory_close_loop` | Retire one existing loop by handle. | `handle`, `status` (`resolved`/`dropped`) |
| `memory_forget_attribute` | Retire (tombstone) an existing **attribute** fact that has no natural supersede — the compound-split case (after breaking a non-specific attribute into granular facts under new predicates, forget the orphaned original) or a trait the user explicitly retracted. Prefer supersede (re-assert same `entityKey`+`predicate`) when the predicate is unchanged. | `handle` **or** `entityKey`+`predicate` |
| `memory_forget_directive` | Retire (tombstone) an existing **directive** the user explicitly retracted with no replacement, by handle only (directives are global). When a rule is overridden, record the replacement with `memory_add_directive` instead. | `handle` |

`memory_keep_loops.handles[]` and `memory_close_loop.handle` are **loop handles**: each open
loop carries a stable, human-legible `loop_key` (a slug of its title, e.g.
`loop.find_attic_key`, unique within the conversation) that is rendered as its
`[id=…]` in the extractor's packet. References resolve by key or by raw id, so
both forms work; the key is what the model sees, which keeps loop references
legible instead of opaque ULIDs.

There is deliberately **no `decision` concept**: a settled choice is recorded as
an `attribute` (e.g. `predicate: "decision"`) or, when it is forward-looking, a
`directive`. Dropping it removes the hardest classification boundary
(attribute vs directive vs decision).

Only open loops have an explicit lifecycle. `attribute` facts supersede in place
— re-asserting one (same `entityKey`+`predicate`) retires the prior value
automatically — and `directive`/`event` are append-only, so the extractor never
"closes" anything except open loops. This asymmetry is stated explicitly to the
model.

Events are deliberately kept scarce: they feed a recency-ranked, hard-capped
`recentEvents` window and never supersede, so an over-eager extractor that logged
every state change as an event would both flood that window and lose the
"current value" view that attributes provide. The extractor is therefore steered
hard toward `attribute` as the default, with `event` reserved for genuine
log-worthy occurrences. Because a state change is *also* often a notable
occurrence, each `memory_set_attributes` item accepts an optional thin paired event
(`event` summary + optional `eventType`, default `"change"`, inheriting the
batch's `entityKey`): the model logs both in one deliberate call rather than
choosing between current state and timeline, and the event stays model-gated so
the window is never auto-flooded.

Attributes are recorded in **batches** rather than one per call, for a structural
reason: with one-item-per-call tools, granularity is *expensive* (six traits =
six round-trips), so a model rationally collapses a character description into one
big `description` value — defeating per-trait search, supersession, and counting.
`memory_set_attributes` hoists `entityKey` to the top level and takes an
`attributes` array of flat `{predicate, value, …}` items, making granular cheap;
the advertised example and prompt both demonstrate decomposition (a "tall woman
with red hair who fears water" → `build=tall`, `hair=red`, `fears=water`), and the
prose blurb is steered to the entity `summary`. Items are validated
**independently** — valid traits stage and only the items flagged `staged: false`
in the result's `results[]` need re-sending — so one malformed trait never sinks
the batch.

Each write tool validates and **stages** what it records (one item, or a batch of
attributes), returning a uniform envelope (`ok`, `accepted`/`error`,
`staged_totals`, …) so a rejected call gives targeted, per-tool feedback without
discarding anything already staged.
Everything staged across the turn commits via a single `commitPatch` at the end.
Internally these still fan out into the same storage tables: an `attribute`
becomes a fact, a `directive` becomes a pinned fact under the reserved
`directive` predicate, and `open_loop` / `event` land in their respective
tables. The per-kind tools are purely a write-time data model that forces the
classification decision; nothing about persistence, the memory inspector, or the
editable `memory/[kind]` routes changes. Each stored item also keeps its
provenance (source message/turn/event), visibility, confidence, and status
(active, superseded, disputed, deleted, needs review).

### Per-session directives (standing rules)

Directives are standing instructions that must flow into **every**
future memory-backed turn for a conversation — for example, while telling a story
the user says _"when creating new characters, give them names."_ A directive is
captured regardless of **who** states it: it may be a rule the user issues, or one
the assistant declares about its own role or operating behavior in a
self-describing reply (e.g. _"I am a text-based RPG; I track inventory and always
describe the scene before asking for input"_ yields a role directive plus each
operating rule it states). Only durable role definitions and standing operating
rules are captured — greetings, conversational offers to proceed, and one-off
next-step plans for the current turn are not. Unlike facts
and open loops (which describe state/history and compete for the packet
token budget), and unlike global memories (user-scoped, pulled in only on demand),
a directive is an always-on behavioral instruction that is never dropped.

- **Storage:** reuse the `memory_facts` table with the reserved predicate
  `directive` and forced `pinned = true`. This inherits pinning, salience ranking,
  the FTS search index, supersede semantics, and the patch/commit pipeline.
- **Scope:** conversation-scoped (per session). Inherited by forks/rebuilds via the
  existing per-conversation memory-copy path (pinned directive facts are carried
  over). Not user-global in v1.
- **Creation:** automatic — the extractor captures durable, forward-looking
  instructions via the `memory_add_directive` tool / commit flow, whether they are
  issued by the user or declared by the assistant about its own role/behavior.
  Extraction guidance stays conservative (only standing instructions and role
  definitions, not one-off asks or transient self-talk).
- **Injection:** every active directive is rendered verbatim in a dedicated
  `standing directives` packet header block, exempt from the token budget — they are
  never elided regardless of how many other facts exist.
- **Modes:** available in all profiles except `off` (`lightweight`, `project`,
  `story`, `strict`); the profile primitive lists advertise `directive`.
- **Retire / countermand:** directives are **additive** — two directives with
  different wording both stay active (only identical re-assertions are
  de-duplicated), so replacing a rule does not auto-remove the prior one. A user
  countermand deactivates a directive via the Memory Inspector "Directives"
  section, which tombstones the fact (status `deleted`) so it stops being
  injected.
- **Distinct from `world_rule`:** a story `world_rule` describes in-fiction world
  state; a `directive` is an agent-behavior instruction. They are kept separate, and
  `directive` is also unrelated to the permissions system's auto-allow/deny "rules".

## Retrieval and packet assembly

The memory engine should build an initial turn packet before the main model call.
This packet is not expected to contain everything; it is a compact working set
plus instructions for tool-based recall.

Example:

```json
{
  "memory_mode": "project",
  "session_summary": "The user is designing memory-backed stateless sessions.",
  "relevant_decisions": [
    {
      "id": "decision_12",
      "subject": "fresh_context",
      "decision": "Use a fresh context window per request.",
      "source_turn_id": "turn_8"
    }
  ],
  "open_loops": [
    {
      "id": "loop_5",
      "title": "Define first-pass memory tools",
      "status": "active"
    }
  ],
  "relevant_facts": [],
  "recent_events": [],
  "tool_guidance": {
    "must_query_when_missing_prior_state": true,
    "available_tools": [
      "memory.search",
      "memory.get_entity",
      "memory.get_open_loops",
      "memory.get_recent_events",
      "memory.check_claims"
    ]
  }
}
```

Retrieval should combine:

- symbolic entity lookup
- profile-specific query expansion
- recency
- open-loop priority
- text search
- eventual vector search
- explicit visibility constraints

### Relevance-conditioned, token-budgeted assembly

`buildInitialPacket(conversationId, mode, opts)` selects the packet for the
current turn rather than emitting a flat, recency-ordered dump of every memory
type. The selection pipeline is:

1. **Relevance ranking.** When `opts.query` is provided (the prompt builder
   passes the user message plus recent transcript), facts, entities, and events
   are ranked against a single per-turn `memory_search` call (the same FTS
   ranking the tool exposes); its top hits also feed the
   auto-search section below, so only one search runs per turn. Relevance
   dominates; salience (for facts) and recency (for events/entities) break ties
   and order anything the query did not match.
2. **Salience.** Facts carry a salience derived from `pinned`, confidence, and
   recency, so important facts outrank merely recent ones even without a query.
3. **Always-present entity-key index.** Every queryable entity is listed
   compactly (`entityKey (type) [status] (N facts)`), bounded by a count cap and
   independent of the body budget. This guarantees the model knows what is
   queryable by name even when a fact's body is dropped. `entityKey` values are
   preserved verbatim for downstream consumers.
4. **Token budget.** Open loops are pinned as cheap, high-value
   continuity. The remaining token budget (per-mode, overridable via
   `opts.tokenBudget`) is spent on relevance-ranked facts, then events, then
   entity summaries, so total packet size stays bounded regardless of how much
   total memory exists.
5. **Auto-search prestep.** The top hits of the per-turn search are injected as
   an `auto-retrieved for this turn` section (retrieval-augmented), so the "query
   as needed" goal is met without relying on weak models to self-initiate tool
   calls.

### Packet rendering

`renderMemoryPacket(packet, options)` turns the assembled packet into the compact
text actually injected into a prompt. The same packet is rendered for two
different audiences, and the differences are a single explicit
`RenderMemoryPacketOptions` object rather than per-primitive special-casing:

- **`includeIds`** — surfaces stable `[id=...]` handles on every primitive
  (entities, facts, events, open loops). The main-turn agent renders
  without ids (they are noise it cannot act on); the post-turn extractor enables
  them so it can reference items precisely. Open loops render their legible
  `loop_key` (e.g. `loop.find_attic_key`) in the `[id=...]` slot rather than a raw
  ULID, and `memory_keep_loops`/`memory_close_loop` accept that key (or the id). Note that
  only open loops are *acted on* by handle — a fact is corrected by re-asserting
  an attribute with the same `entityKey`+`predicate`, which supersedes the prior
  value automatically (see [Source-side consolidation](#source-side-consolidation-event-derived)).
- **`openLoopExpiry`** — when set (extractor only, carrying
  `MEMORY_OPEN_LOOP_MAX_IDLE_TURNS`), annotates open loops within a couple of
  passes of auto-drop with an `[expires in N passes unless kept]` hint. This is a
  pure rendering nudge tied to [open-loop liveness](#open-loop-liveness-touch-to-keep);
  it changes no state.

Keeping the agent/extractor split in one options object means the rendering
contract is a single self-documenting decision instead of a scatter of booleans.

**Render-time dedupe.** Two sections used to re-emit content already present in
the same packet, inflating token cost every turn:

- The detailed `entities & facts` block and the standalone `entity index` block
  overlapped — the index was a superset of the entities shown in detail, so every
  shown key/type was printed twice. The index is now merged into the entities
  section: detailed entities render as before, then a single compact `also on
  record (queryable by name)` remainder lists only the indexed entities **not**
  already shown. The union of the two still equals the full index set, so no
  entity becomes unqueryable by name even when its fact bodies are dropped under a
  tight budget.
- `auto-retrieved for this turn` printed the top search hits verbatim, but the
  same per-turn search ranks the pools, so the highest-scoring hits are usually
  already rendered in `entities & facts` / `recent events`. Hits whose `itemId`
  already appears above (across facts, events, entities, open loops, and
  directives) are now suppressed.

Both are pure render-time dedupes: selection, caps, and the token budget are
unchanged. When dedupe empties a section, its header is omitted entirely rather
than printing an empty `(0)` block.

### Source-side consolidation (event-derived)

The event log is the source of truth; `memory_facts` is a projection rebuilt by
replaying the log. Consolidation is therefore a **projection derivation**, not a
stored mutation. `addFact` appends a single `fact.create` event per observation
and then runs `consolidateFactGroup`, which is also invoked on edits/deletes and
during replay so the same rule applies live and on rebuild:

- **Single-valued predicates** (`location`, `status`, `state`, `place`,
  `position`): only the newest observation in the `(entity, predicate)` group
  stays `active`; older ones become `superseded`.
- **Other predicates:** the newest observation of each distinct value stays
  active; older identical observations become `superseded` (dedupe).

Because supersession is never written to the event stream, **consolidation needs
no special handling on a rebuild**: a full `rebuildSessionMemoryProjection`
replays the surviving `fact.create` events and re-derives the active set from
them — promoting a previously superseded sibling back to active where
appropriate — since the projection is purely a function of the event stream.

`pinned` (migration `035_memory_fact_salience.sql`) feeds the injector's salience
score.

## Tool behavior

### `memory.search`

Search durable memory by text, type, entity, tag, source, visibility, and time
range.

Inputs:

- `query`
- `types`
- `entity_ids`
- `status`
- `visibility`
- `limit`

Output:

- compact result objects
- source IDs
- confidence
- visibility
- "more results available" flag

### `memory.get_entity`

Fetch canonical state for one entity.

Output should include:

- entity metadata
- active facts
- recent events
- open loops
- provenance
- status

### `memory.get_open_loops`

Fetch unresolved loops relevant to the current turn.

Supports filters:

- `loop_type`
- `entity_ids`
- `priority`
- `visibility`

### `memory.get_recent_events`

Fetch recent or entity-specific events.

Useful for continuity and conversational flow.

### `memory.check_claims`

Validate proposed claims before they are stated or committed.

Input:

```json
{
  "claims": [
    {
      "subject": "object.silver_key",
      "predicate": "location",
      "value": "study_desk"
    }
  ]
}
```

Output:

- `supported`
- `contradicted`
- `unknown`
- relevant source facts/events

### Durable-write tools (`remember_*`, `memory_keep_loops`, `memory_close_loop`, `forget_*`)

The background extractor records durable memory by calling **per-kind write
tools** — `memory_set_attributes` (also the entity constructor),
`memory_add_directive`, `memory_record_event`, and `memory_open_loop`, plus
`memory_keep_loops`/`memory_close_loop` for open-loop lifecycle and
`memory_forget_attribute`/`memory_forget_directive` for retiring a stale attribute or
directive that has no natural supersede. Each takes a small, flat argument
object (`memory_set_attributes` takes a shared `entityKey`, optional entity
metadata, plus an array of flat trait items); the tool name *is* the
classification (no `kind` discriminator). The server validates and stages each
call, returning a uniform `{ ok, accepted | error, staged_totals, … }` envelope
so a rejected call gives
targeted, per-tool feedback without discarding anything already staged.
Everything staged across the turn commits once at the end. The model never
writes directly to canonical memory.

The extractor ends its run by calling a dedicated control tool,
**`memory_finish`** (optional `summary`). This is the only clean way to
stop: a completion that simply returns no tool call is **not** treated as
"done" — reasoning models routinely close a step with chain-of-thought and no
tool call, which would otherwise end the run prematurely (often at the second
thinking block) having stored nothing. An empty turn is instead nudged toward
either further writes or an explicit `memory_finish`, bounded by a small cap
(`MAX_EMPTY_TURN_NUDGES`) so a model that never cooperates still terminates well
before the iteration/wall-clock budgets. `memory_finish` is a control
signal, not a write: it stages nothing and is never dispatched to a write
handler, but it _is_ surfaced as a tool card so the run visibly ends on an
explicit model decision rather than appearing to stop on its own. Its optional
`summary` seeds the extraction session summary (falling back to the turn's final
visible text) and is echoed in the finish card's result.

## Extraction and commit flow

After a response, the extractor stages a memory patch across its write-tool
calls, which collapses to:

```json
{
  "entities": [],
  "events": [],
  "facts": [],
  "openLoops": [],
  "resolveOpenLoops": [],
  "keepOpenLoops": [],
  "forgetFacts": []
}
```

The validator checks the patch. The committer writes accepted changes in a
transaction. Rejected or uncertain changes remain visible as validation issues.

Commit rules:

- every committed item must have source provenance
- no direct mutation of immutable events
- fact changes supersede prior facts rather than deleting them
- low-confidence items are either discarded or marked `needs_review`
- strict-mode conflicts block commit unless explicitly resolved

## Model-backed extraction design

The heuristic extractor is useful as a fallback, but the full design should add
a model-backed extraction backend behind the existing patch lifecycle. The
extractor must never write directly to canonical memory. It proposes a
`MemoryPatchProposal`; the existing validator, patch log, patch item tracker,
and committer remain the only mutation path.

### Avoiding and cleaning up duplicate entities

Entities are keyed by a free-form `entityKey` the model chooses, so the same
referent can end up stored twice under different surface forms (the classic
case is a bare name vs. a fuller name, e.g. `character.firstname` and
`character.firstname_lastname`). Two defenses keep this in check:

- **Prevention.** The extractor is instructed to reconcile every referent
  against existing entities before minting a new one — searching by name and by
  likely key and reusing the canonical `entityKey` — and the deterministic
  `canonicalizeEntityKeys` pass collapses obvious within-patch duplicates that
  match a known entity by display name, key tail, or typed name.
- **Cleanup.** When a duplicate has already been committed, the extractor can
  call `memory.merge_entities` to fold the duplicate into the canonical entity.
  The merge reassigns the duplicate's facts, events, and open-loop links onto
  the canonical entity through the append-only session memory log (so projection
  rebuilds and forks reconstruct the merged state) and retires the
  duplicate. Whether two keys are the *same* referent is a semantic judgment
  left to the model; fuzzy names are never auto-merged, because a shared partial
  name can denote genuinely distinct referents.

### Extractor interface

```ts
export interface MemoryExtractor {
  extractPatch(input: ExtractPatchInput): Promise<ExtractPatchResult>;
}

export interface ExtractPatchInput {
  conversationId: string;
  userId: string;
  mode: MemoryMode;
  turnId: string;
  userMessage: {
    id: string;
    content: string;
    createdAt: number;
  };
  assistantMessage: {
    id: string;
    content: string;
    createdAt: number;
  };
  initialPacket: TurnMemoryPacket;
  memoryToolCalls: MemoryToolCall[];
  regularToolCalls: ToolCallRecord[];
  recentTranscript: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    createdAt: number;
  }>;
}

export interface ExtractPatchResult {
  patch: MemoryPatchProposal;
  confidence: number;
  summary: string;
  diagnostics: Array<{
    severity: "info" | "warning" | "error";
    code: string;
    message: string;
  }>;
  rawModelOutput?: unknown;
}
```

The first implementation can use the same configured provider/model used for the
conversation. Longer term, extraction should have a separate configurable model
so users can choose a cheaper or more deterministic backend.

### Extractor prompt contract

The extractor prompt should be boring and schema-first:

```text
You extract durable memory changes from one completed assistant turn.

Return only JSON matching the unified memory patch shape
({ entities[], facts[], closeLoops[] }, every fact tagged with its kind).
Do not summarize the whole conversation.
Do not create facts for transient wording, speculation, or rejected ideas.
Do not store secrets, credentials, raw tool output, or private tokens.
Mark uncertain items with low confidence or omit them.
For coding/project mode, mark repository and test observations as historical.
For story/strict mode, preserve entity state, knowledge, timeline, clues,
objects, locations, and unresolved plot threads.

Input:
- memory profile
- initial memory packet
- recent transcript
- user message
- assistant message
- memory tool calls
- regular tool calls summarized
```

The model response is parsed with `MemoryPatchProposalSchema`, which accepts the
unified write shape (entities + kind-tagged facts + closeLoops) and normalizes it
into the internal table-shaped patch. Invalid JSON or schema errors create a
`memory_validation_issues` row and fall back to heuristic extraction only when
the profile allows fallback.

### Execution modes

| Profile | Extraction timing | Failure behavior |
| --- | --- | --- |
| Lightweight | Async after stream | Log issue, skip patch or heuristic fallback |
| Project | Async after stream | Log issue, preserve historical command/tool summaries |
| Story | Async after stream, quick | Log issue; user can correct in inspector |
| Strict | Synchronous before final `done` or review-gated | Block commit on conflicts; surface `needs_review` |

For responsive streaming, the assistant answer should stream first in most
modes. Extraction status is then emitted as memory events:

```text
memory.status extracting
memory.status validating
memory.status committed | needs_review | skipped
```

When the `openai-compatible-tools` extractor is active, its work is surfaced as
a **subagent**, indistinguishable from a real one to the lower layers. The turn
runner emits the same event vocabulary a Copilot `task` subagent produces — a
parent `task` tool call, a `subagent.lifecycle` (running → completed/failed)
with an agent id, and threaded children via `parentToolCallId` — all routed
through the normal dispatch/persistence path. Only the parent's
`agent_type: "memory-extractor"` arg distinguishes it, and that is used purely
for presentation (the 🧠 icon); no lower-layer component special-cases it.
Through the optional `onActivity` emitter on `ExtractPatchInput` the extractor
surfaces:

- its **input** — the context handed to the background agent — as a leading
  `input` activity, which the turn runner threads onto the parent card as its
  `prompt` so the UI shows what the extractor was asked to work from, just like
  a real subagent's prompt;
- its **thoughts** — provider reasoning fields (`reasoning` / `reasoning_content`)
  and inline `<think>…</think>` — as threaded child reasoning blocks;
- its **spoken content** — as threaded child content blocks, interleaved with
  its thoughts and tools (see "Fully-featured nested agents" below);
- each **retrieval** (`memory_search`, `memory_get_entity`, …) and **write**
  (`memory_set_attributes`, `memory_keep_loops`, …) call, with its validation feedback, as a threaded
  child tool call; and
- its **closing summary** — `memory_finish`'s `summary` arg, or the turn's
  final visible text — as the parent tool result → the card's Response
  (`ExtractPatchResult.response`).

The extractor's chat requests use `stream: true`, so reasoning and content are
surfaced **token-by-token** as they arrive (the `ExtractorChatComplete` seam
takes an optional `onDelta`). Inline `<think>` markers are split from spoken
text across chunk boundaries and tool-call argument fragments are reassembled
from streamed deltas, so a turn can be watched live as it forms — making
failures diagnosable instead of appearing only as a finished block.

Extractors that don't call tools (heuristic / single-shot JSON) emit nothing and
no card is created.

### Fully-featured nested agents

Sub-agents (real Copilot `task` agents *and* the memory extractor) render as
fully-featured nested agents: their **spoken content interleaves** with their
reasoning and tool calls inside the card, just like a top-level agent's body.

This is carried by two additions to the existing threading model:

- `message.delta` may carry an optional `parentToolCallId` + `segmentId`. When
  set, the delta is a sub-agent's content and is threaded into its card instead
  of appended to the outer assistant message body.
- `reasoning_blocks` gained a `kind` column (`'reasoning'` | `'content'`).
  Sub-agent content is stored as `kind = 'content'` rows (always with a
  `parent_tool_call_id`); the `SubagentCall` activity timeline renders them as
  prose, interleaved by timestamp with `'reasoning'` blocks and tool calls.

The SDK adapter previously dropped a sub-agent's visible deltas
(`if (ev.agentId) return`) and surfaced its answer only as the `task` tool
result. It now threads those deltas as content segments (opening content closes
any in-flight child reasoning so the two interleave in order). Top-level content
is unchanged — it still streams into the message body.

Strict mode is the exception. If the assistant makes continuity-sensitive claims
and did not call `memory_check_claims`, the turn runner may run extraction and
validation before emitting final completion.

### Provider abstraction

Add a small server-side provider-independent service:

```ts
interface MemoryExtractionProvider {
  completeJson(input: {
    model: string;
    system: string;
    prompt: string;
    schemaName: "MemoryPatchProposal";
    signal?: AbortSignal;
  }): Promise<unknown>;
}
```

Initial provider options:

1. Reuse the active backend provider when it supports non-streaming JSON calls.
2. Fall back to the existing chat provider with a synthetic internal prompt.
3. Fall back to heuristic extraction when no extraction backend is available.

The provider must run without exposing extraction prompts in the user transcript.
It should still write audit rows to `memory_patches` and
`memory_validation_issues`.

### Storage additions

The current `memory_patches.raw_patch_json` can store the proposed patch, but
model extraction needs auditable metadata:

```sql
ALTER TABLE memory_patches ADD COLUMN extractor_kind TEXT;
ALTER TABLE memory_patches ADD COLUMN extractor_model TEXT;
ALTER TABLE memory_patches ADD COLUMN extractor_confidence REAL;
ALTER TABLE memory_patches ADD COLUMN extractor_diagnostics_json TEXT NOT NULL DEFAULT '[]';
```

If avoiding another migration at first, this metadata can live in
`validation_result_json`. A dedicated migration is cleaner once the extractor is
productionized.

### Safety rules

- Never persist raw tool output wholesale.
- Never persist values that match secret/token patterns.
- Never promote a permission decision into a broad global preference unless the
  user explicitly asks.
- Never treat project/repository facts as current truth without revalidation.
- Never commit model output without schema validation.
- Never delete or supersede memory directly from extractor output without a
  patch item trail.

### Implementation steps

1. Add `src/lib/server/memory/extractor.ts` with `MemoryExtractor` and a
   heuristic fallback implementation.
2. Add a provider-backed implementation that calls a JSON completion helper.
3. Replace direct `extractHeuristicPatch` usage in the turn runner with
   `extractor.extractPatch`.
4. Store extractor diagnostics in the patch validation result.
5. Add profile-specific tests with transcript fixtures.
6. Add a settings flag for extractor backend/model once multiple choices exist.
   _(Done: per-conversation `memory_extractor_backend` + `memory_extractor_model`
   columns, user-level seed defaults in Settings → General, and chat-header
   selectors; NULL resolves to the server env defaults.)_

## Validation

Validation must be profile-specific.

### General validation

- missing provenance
- duplicate facts
- invalid entity references
- conflicting active facts
- stale observations
- low-confidence extraction
- visibility leakage

### Project validation

- file facts must be marked historical unless verified this turn
- test results must be historical
- tool output should not be persisted wholesale
- secrets should not be stored
- prior attempts should include outcome and source

### Story validation

- inconsistent entity locations
- impossible object duplication
- dead or unavailable characters appearing without explanation
- unresolved promises being contradicted
- player knowledge mismatches

### Strict validation

- timeline contradictions
- impossible travel or action ordering
- clue availability mismatches
- alibi conflicts
- secret leakage
- NPC knowledge impossible from observed events
- claims unsupported by player-facing evidence

## User interface

### Session setting

Expose a memory selector in session settings:

```text
Memory mode: Off / Lightweight / Project / Story / Strict
```

Suggested copy:

- **Off**: "Use only the current conversation context."
- **Lightweight**: "Remember decisions, preferences, facts, and open loops for
  this session."
- **Project**: "Track implementation context, prior attempts, and decisions.
  Repository claims are rechecked before use."
- **Story**: "Track characters, locations, objects, relationships, and plot
  continuity."
- **Strict**: "Use detailed memory tools and validation for timelines, clues,
  secrets, and fine-grained continuity."

#### Extractor backend + harvester model

Two further per-conversation controls live in the chat header alongside the
memory mode selector (shown only when memory is enabled):

- **Backend** — `Server default backend` (NULL) / `Heuristic (local)` /
  `OpenAI-compatible (single-shot)` / `OpenAI-compatible (tools)`. Persisted to
  `conversations.memory_extractor_backend`. NULL resolves to the server env
  `MEMORY_EXTRACTOR_BACKEND` at runtime. The choice flows into
  `isModelBackedExtractorConfigured`: a `heuristic` backend keeps the main model
  owning memory writes, while an OpenAI-compatible backend hands writes to the
  background extractor.
- **Harvester** — the per-conversation extractor model override
  (`conversations.memory_extractor_model`); NULL means "use the server default
  model".

Both controls have **user-level seed defaults** in Settings → General
(`default_memory_extractor_backend` / `default_memory_extractor_model`). Like
the other General defaults (provider/model/mode), they are **seed-only**: copied
onto each conversation at creation and never retroactively applied. Resolution
precedence is therefore: per-conversation column → (seeded from) user default →
server env. An OpenAI-compatible backend without `OPENAI_COMPATIBLE_BASE_URL`
and a model still degrades to the heuristic extractor (logged as
`memory.extractor.fallback_heuristic`); the UI surfaces a non-blocking hint but
does not prevent saving.

### Memory inspector

The inspector is required for trust and debugging.

Tabs:

- Facts
- Events
- Entities
- Open loops
- Tool calls
- Validation issues
- Patches

Actions:

- edit supported mutable records
- mark wrong
- delete or hide
- pin
- wipe session memory
- export memory

### Retry extraction (latest turn)

The live memory-extractor subagent card for the **latest** turn carries a
"Retry extraction" control. It re-runs **only** the extraction step for that
turn, reusing the stored user + assistant messages — it does not re-prompt the
model, start a new turn, or regenerate the assistant response.

Flow (`POST /api/conversations/[id]/memory`):

1. Authorize against the conversation owner; no-op/blocked when memory mode is
   disabled (`400`).
2. Block with `409` if a turn (or its extraction) is already running.
3. Resolve the latest turn server-side (most recent assistant message + the
   user message that triggered it).
4. Re-run `extractAndCommitMemory` for the latest turn. Only once the
   re-extraction yields a *committable* (validated) patch is the latest turn's
   prior committed patch undone — immediately before the replacement is
   applied, so the commit still lands cleanly with no double-counting. The undo
   appends the inverse mutations for the prior patch's items (delete what it
   created, reopen what it resolved, restore what it forgot) and rebuilds the
   projection, so the active set is re-derived from the event log rather than
   hand-maintained. A failed, timed-out, aborted, or `needs_review` retry never
   runs the undo, so the existing memory is preserved. If the prior extraction
   committed nothing (failed / `needs_review` / cancelled), or the latest turn
   cannot be pinned to a stable turn id (legacy/stub turns), there is nothing to
   undo.

The retry runs under a fresh streaming turn so the card reflects live status
(`extracting` -> `validating` -> `committed`/`needs_review`) via the same
`memory.status` SSE events, and a fresh extractor card/result is emitted exactly
as in a normal post-turn extraction. The committed patch is grouped under the
latest turn's stable turn id, so repeated retries each undo the previous one
cleanly. Only the latest turn is retryable — older turns' cards do not show the
control, and the "is latest" check is enforced server-side, not just in the UI.

### Memory diff

After each turn in memory-backed mode, show a collapsed memory update summary:

```text
Memory updated: 2 facts, 1 open loop
```

Expanded view:

```diff
+ Open loop: Define memory tool schemas.
~ Fact: Memory mode MVP scope updated.
```

### Responsiveness indicators

Use small, honest status labels:

- "Checking memory..."
- "Searching prior session state..."
- "Validating memory changes..."
- "Memory update needs review"

Avoid blocking the user on post-turn extraction except in strict mode when a
conflict would make the answer unreliable.

## Responsiveness and performance

Memory mode should not make ordinary chat feel slow.

### Fast path

For Lightweight and Project modes:

```text
pre-turn structured lookup
  -> initial packet
  -> stream response
  -> async extraction and validation
```

The model still has memory tools during generation. The initial lookup should be
cheap, and tool calls should be targeted.

### Strict path

For Strict mode:

```text
pre-turn retrieval
  -> mandatory validation of relevant constraints
  -> model response with memory tools
  -> post-turn extraction
  -> validation
  -> commit or review
```

Strict mode may add latency. That is acceptable if clearly communicated.

### Latency targets

Approximate added pre-stream latency, excluding model calls:

| Mode | Target |
| --- | --- |
| Lightweight | 100-250ms |
| Project | 250-500ms |
| Story | 250-750ms |
| Strict | correctness over speed |

### Caching

Useful caches:

- last turn packet
- recent open loops
- active facts by entity
- profile configuration
- recent memory search results within a turn

Do not cache across visibility or session boundaries.

## Storage and retrieval technologies

Start with SQLite.

Recommended first implementation:

- normalized tables for entities, facts, events, decisions, open loops, patches
- JSON columns for profile-specific payloads
- SQLite FTS for lexical search
- indexes on `session_id`, `entity_id`, `status`, `visibility`, `created_at`,
  and `updated_at`

Defer embeddings until there is enough real memory data to evaluate retrieval
quality.

Later options:

- `sqlite-vec` or similar local vector extension
- provider embeddings with local cache
- hybrid symbolic + lexical + vector retrieval

Avoid starting with an external vector database unless deployment requirements
change. It adds operational and privacy complexity before the product value is
proven.

## Hybrid vector retrieval design

The current memory search stack should evolve into hybrid retrieval:

```text
symbolic entity lookup
  -> active facts / open loops
  -> SQLite FTS lexical recall
  -> vector similarity recall
  -> profile-specific reranking
  -> compact provenance bundle
```

Vector retrieval should not replace structured lookup. It is an additional
recall path for fuzzy references like "that candle detail", "the auth decision",
or "the thing we tried before the database migration".

### Embedding provider interface

```ts
export interface MemoryEmbeddingProvider {
  embed(input: {
    texts: string[];
    purpose: "index" | "query";
    signal?: AbortSignal;
  }): Promise<EmbeddingResult>;
}

export interface EmbeddingResult {
  model: string;
  dimensions: number;
  vectors: number[][];
}
```

Provider choices should be explicit:

| Provider | Use case |
| --- | --- |
| `none` | Default; structured + FTS only |
| local OpenAI-compatible embeddings | Local/private deployments |
| hosted provider embeddings | Higher quality, explicit opt-in |
| future SQLite extension model | Fully local vector generation |

The embedding provider must be independent from chat model providers. A user may
use Copilot for chat and a local embedding model for memory.

### Storage schema

Use a base table plus either a vector extension table or a JSON fallback.

```sql
CREATE TABLE memory_embeddings (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL, -- session | global
  item_type       TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  dimensions      INTEGER NOT NULL,
  text_hash       TEXT NOT NULL,
  text            TEXT NOT NULL,
  vector_json     TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(scope, item_type, item_id, embedding_model)
);
CREATE INDEX idx_memory_embeddings_session
  ON memory_embeddings(conversation_id, item_type);
CREATE INDEX idx_memory_embeddings_global
  ON memory_embeddings(user_id, item_type);
```

If `sqlite-vec` or another vector extension is available, add a parallel virtual
table keyed by `memory_embeddings.id`. Keep the base table regardless so export,
debugging, and fallback search remain simple.

### Indexable text

Every memory record needs a deterministic text representation:

| Item type | Text representation |
| --- | --- |
| Entity | key, type, display name, summary, metadata |
| Event | type, summary, payload, actor/target display names |
| Fact | entity display name, predicate, value, visibility |
| Open loop | type, title, description, status |
| Patch | summary, validation issues |
| Global memory | kind, key, value |

The text hash prevents unnecessary re-embedding when records are unchanged.

### Indexing flow

```text
memory record committed/updated
  -> enqueue embedding job
  -> compute index text + hash
  -> skip if same hash/model already indexed
  -> call embedding provider
  -> upsert memory_embeddings
  -> upsert vector-extension row when available
```

Indexing should be asynchronous. Retrieval must still work with structured/FTS
when embeddings lag or fail.

### Query flow

```ts
interface HybridMemorySearchInput {
  conversationId: string;
  userId: string;
  query: string;
  mode: MemoryMode;
  includeGlobal: boolean;
  types?: string[];
  limit: number;
}
```

Search steps:

1. Extract symbolic handles from the query (`character.elias`, file paths,
   clue IDs, explicit entity keys).
2. Fetch exact entity/fact/open-loop matches.
3. Run existing FTS search.
4. If embeddings are enabled, embed the query and run nearest-neighbor search.
5. Merge by item ID.
6. Score with weighted features:

```text
score =
  symbolicMatch * 10
  + activeStatus * 3
  + openLoopPriority * 2
  + ftsRank
  + vectorSimilarity * 5
  + recencyBoost
  + profileBoost
```

7. Return compact results with provenance, source event/message IDs, confidence,
   and retrieval reasons.

### Profile-specific reranking

| Profile | Boost |
| --- | --- |
| Project | decisions, failed attempts, current open loops, file/topic entities |
| Story | current scene, present characters, world rules, object locations |
| Strict | timeline, clue ledger, visibility/knowledge facts, contradictions |
| Lightweight | preferences, decisions, unresolved questions |

Strict mode should prefer exact symbolic and timeline results over pure vector
similarity. Vector-only matches in strict mode should be labeled as fuzzy recall,
not canonical truth.

### Tool changes

`memory_search` should become hybrid transparently:

```json
{
  "query": "blue candle",
  "types": ["fact", "event", "open_loop"],
  "includeGlobal": false,
  "limit": 20
}
```

Add optional diagnostics in tool output:

```json
{
  "results": [],
  "retrieval": {
    "fts": 4,
    "vector": 6,
    "symbolic": 1,
    "embeddingModel": "text-embedding-3-small",
    "vectorIndexAvailable": true
  }
}
```

### Privacy and control

- Embeddings are disabled by default.
- Hosted embeddings require explicit configuration.
- Global memory embeddings are separate from session embeddings.
- Deleting memory deletes embedding rows.
- Export includes embedding metadata, not necessarily vector values unless a
  debug/export option asks for them.
- Secret-filtering runs before indexing text is embedded.

### Implementation steps

1. Add `memory_embeddings` migration.
2. Add `src/lib/server/memory/embeddings.ts` provider interface.
3. Add deterministic `indexTextForMemoryItem` helpers.
4. Enqueue embedding updates from commit/update/delete paths.
5. Implement JSON-vector cosine fallback for small local datasets.
6. Optionally enable `sqlite-vec` acceleration when present.
7. Upgrade `memory.search` repository method into hybrid search.
8. Add recall-quality golden tests.

## Security, privacy, and isolation

Defaults:

- memory is per-session
- memory is off unless the user enables it or a profile explicitly creates a new
  memory-backed session
- cross-session memory is opt-in
- deleted sessions delete associated memory
- exported sessions include memory data
- users can wipe memory without deleting the chat
- memory respects existing auth boundaries

Sensitive data rules:

- do not persist secrets from files, command output, environment variables, or
  tool responses
- avoid storing raw tool output unless explicitly needed
- store compact summaries with source links instead
- mark permission-related facts narrowly; do not silently broaden them into
  future grants or preferences

## Forking and rewinding sessions

Editing an earlier user message or retrying an assistant message ("rewind")
forks the conversation: a new conversation is seeded with the message-transcript
prefix up to the rewind point (see `src/lib/server/fork.ts`). Because each
session's memory is keyed by `conversation_id`, the fork must also inherit the
durable memory the prefix produced — otherwise the fork would start with an
empty memory packet even though its visible transcript shows prior turns, and
the assistant would "forget" everything it had remembered.

Session memory is event-sourced: every mutation is appended to the
`memory_event_log` table (migration `033`), and the live `memory_*` tables are a
projection rebuilt from that log. `replaySessionMemoryLogForFork`
(`src/lib/server/db/repos/memory.ts`) replays the source's log into the fork
with these rules:

- **Scope by prefix membership.** A log entry is replayed when its
  `source_message_id` belongs to the kept prefix (translated through the cloned
  message-id map). Because extraction runs asynchronously after a turn, a prefix
  item can be committed after the next message's timestamp, so the message link —
  not `created_at` — is the primary classifier. Unlinked `*.create` entries fall
  back to the `created_at` boundary (the first discarded source message), and
  later unlinked mutations follow whichever item they target.
- **Full history, materialized.** The kept entries are replayed in order, so the
  fork's projection reflects the same superseded/deleted/closed transitions the
  prefix produced. The live-state queries (`listEntities`, `listFacts`, …) still
  surface only active/open rows.
- **References are remapped.** Each replayed item's own id is reissued;
  references to other items (`entity_id`, `actor`/`target_entity_id`,
  `source_event_id`, `supersedes_fact_id`, open-loop related entities, patch
  links) resolve to the fork's reissued id when the referenced item was also
  copied, and to `null` otherwise — links to rows left behind never dangle.
  `source_message_id` is translated to the fork's cloned message ids, and search
  and embedding indexes are rebuilt for the new conversation.
- **Fresh provenance.** Ephemeral `turn_id` values are dropped. Patch/issue/
  tool-call audit rows are replayed only when they belong to the kept prefix, and
  the fork continues appending to its own log thereafter.

The source conversation is never mutated, consistent with the non-destructive
fork model (the workdir is shared, not rolled back).

### Append-only chain, turn heads, and reference-counted GC

The `memory_event_log` is an **append-only parent chain**: every event stores a
`parent_id` pointing at the event that was the head when it was appended. There
is no mutable per-conversation head pointer. Instead, the head is derived from
the transcript:

- `memory_message_heads(conversation_id, message_id) -> head_event_id` records,
  for each message, the memory head as of that transcript point. The conversation's
  current memory state is simply the head of its most recent message (falling back
  to the cached projection head for message-less memory used in unit tests).
- `memory_heads(conversation_id) -> projection_event_id` caches which head the
  live `memory_*` projection currently reflects, so appends can advance the
  projection incrementally and detect when a full rebuild is required.

Rewinding (inline edit / tool rerun) does not delete log rows to move the head —
it drops the message heads for the truncated suffix and lets garbage collection
reclaim whatever those heads pinned. Reachability is tracked in a single generic
table:

- `memory_refs(ref_kind, source_key) -> target_event_id` holds **every incoming
  reference to an event**. `memory_parent` rows come from child events
  (`source_key` = child id); `message_head` rows come from messages
  (`source_key` = message id). The kind is intentionally open-ended for future
  sources (shared fork heads, audit roots).

GC is a backward walk: starting from the old tip, while an event has no row in
`memory_refs` referencing it, delete it (dropping its own `memory_parent` row)
and continue to its parent. The walk stops at the first event still referenced —
i.e. the kept prefix head, which a surviving message still pins. Cycles are
impossible by construction (a parent is always older than its child); a depth
guard only protects against corrupt data. `memory_message_heads` is kept
alongside `memory_refs` because it additionally answers the ordered "what did
memory know at this transcript point?" query that a flat reference table cannot.

## Migration and rollout

### Phase 0: design spike

- define database schema
- define memory engine interface
- define memory tool schemas
- identify chat pipeline integration points
- create UI mock for memory mode selector and inspector
- create transcript fixtures for extraction tests

### Phase 1: lightweight memory with mandatory tools

First production-capable slice:

- per-session memory mode: Off / Lightweight
- fresh-context request path for memory-backed sessions
- initial memory packet assembly
- mandatory memory tools:
  - `memory.search`
  - `memory.get_entity`
  - `memory.get_open_loops`
  - `memory.get_recent_events`
  - `memory.check_claims`
  - durable-write tools (extractor): `remember_*`, `memory_keep_loops`, `memory_close_loop`, `memory_forget_attribute`, `memory_forget_directive`
- post-turn extraction
- patch validation
- transactional commit
- read-only inspector
- session memory wipe
- memory diff summary after turns

### Phase 2: project profile

- coding-aware schemas
- historical command/test records
- implementation decisions
- unresolved bugs/tasks
- stale repository fact handling
- stronger secret filtering

### Phase 3: story profile

- character/location/object schemas
- scene packet assembly
- world rules
- style memory
- continuity validation

### Phase 4: strict profile

- timeline
- clue ledger
- per-character knowledge
- visibility solver
- strict contradiction checking
- review-required memory patches

### Phase 5: advanced retrieval

- SQLite FTS tuning
- optional embeddings
- retrieval scoring
- packet budget optimization
- evaluation suite for recall quality

### Phase 6: cross-session memory

Only after per-session memory is reliable.

- explicit opt-in
- project-scoped memory
- user-scoped preferences
- namespace controls
- global memory inspector

## Testing strategy

### Unit tests

- packet assembly
- tool argument validation
- memory search filters
- entity lookup
- fact supersession
- patch validation
- commit transactions
- wipe/delete behavior
- profile-specific validators

### Golden transcript tests

For each profile, maintain fixtures:

```text
transcript input
  -> expected memory patch
  -> expected packet on next turn
  -> expected tool result for targeted recall
```

Important cases:

- user corrects assistant memory
- old detail recalled via tool
- low-confidence extraction rejected
- open loop resolved
- coding test result becomes stale
- story object moves location
- strict-mode secret does not leak

### Integration tests

- memory-backed session streams a response
- memory tool calls are audited
- post-turn extraction commits patch
- inspector displays committed memory
- wipe removes session memory
- validation issue appears when conflict is detected

### Performance tests

Measure:

- packet build time
- tool call query time
- extraction time
- validation time
- end-to-first-token latency
- DB growth over long sessions

## Open design questions

- Should memory extraction use the same model as the chat response, a smaller
  model, or deterministic rules where possible?
- Should Strict mode block final streaming until `memory.check_claims` passes for
  important claims?
- How should the portal distinguish "assistant invented this" from "assistant
  established this as canon" in creative sessions?
- How should user edits to memory be represented: direct mutation, correction
  events, or both?
- What is the right default profile for a new coding chat, if any?
- Should memory tools be visible in the transcript, hidden, or shown in a
  developer/debug drawer?
- How much raw transcript should be kept in the initial packet for tone and
  conversational momentum?

## Recommended MVP cutline

The smallest version worth building:

1. Off and Lightweight modes.
2. Fresh-context path for memory-backed sessions.
3. Mandatory first-pass memory tools.
4. SQLite tables for entities, events, facts, decisions, open loops, patches,
   validation issues, and tool-call audits.
5. Initial packet assembly.
6. Post-turn extraction and transactional commit.
7. Read-only memory inspector.
8. Memory diff after turns.
9. Session memory wipe.
10. Golden tests for recall, correction, and patch validation.

The MVP should not include custom schemas, embeddings, cross-session memory, or a
full strict mystery validator. Those should follow after the core loop is stable.

## Success criteria

The feature is working when:

- a memory-backed session can answer questions about prior details by using
  memory tools rather than relying on hidden context
- users can inspect what was remembered and where it came from
- users can wipe or correct bad memory
- coding memories are treated as historical unless revalidated
- long story sessions preserve object, character, and world-state continuity
- strict sessions can detect at least basic contradictions before committing
  memory
- ordinary chats remain fast when memory is off
