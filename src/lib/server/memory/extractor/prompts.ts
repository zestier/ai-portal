/**
 * Prompt builders for the memory extractors.
 *
 * - buildToolExtractorSystemPrompt(): the system prompt for the agentic
 *   tool-calling extractor. It carries ALL the instructions; the tool extractor's
 *   user message is data-only (see toolExtractorContextSections).
 * - buildExtractorPrompt() / extractorContextSections(): the single-shot JSON
 *   extractor's prompt. Its backend sends only a minimal system message, so its
 *   instructions live inline in the user prompt.
 * - extractorTurnData(): the shared, instruction-free description of the turn
 *   (mode, packet, tool calls, messages) that both extractors feed the model.
 */
import { loadConfig } from '$lib/server/config';
import { renderMemoryPacket } from '../engine';
import type { ExtractPatchInput } from './types';
import { truncate, redactSensitiveText } from './utils';

export function buildToolExtractorSystemPrompt(): string {
	return [
		'You are a background memory extractor. You run automatically after each turn. Your job is NOT to answer the user — it is to durably record what should be remembered by calling tools. The turn to extract from (user and assistant messages, recent transcript, tool calls) and the current memory packet are supplied in the user message.',

		[
			'Memory has two primitives:',
			'- ENTITIES — the durable referents (a person, object, place, file, component, project concept) that facts attach to via a stable, namespaced `entityKey` (e.g. character.mara, object.attic_key, component.memory_extractor).',
			'- FACTS — everything recorded about an entity. Every fact is exactly one kind, and the write tool you call IS its kind (there is no generic patch and no "kind" field to set):',
			'  • memory_set_attributes — things to KNOW: durable current state (a value, status, preference, relationship, ownership, role, location, constraint, deadline, identifier). This is the default; most things are attributes. One call sets MANY attributes on one entity, and is ALSO the entity constructor: pass entityType and/or displayName (each independently optional — an omitted one is derived from the entityKey for a new entity) in the same call to type and name a brand-new referent, or to rename/retype/re-summarize an existing one (omitted fields on an existing entity are left unchanged).',
			'  • memory_add_directive — a standing rule for how YOU must behave going forward (conduct, style, format, process).',
			'  • memory_open_loop — a NEW unresolved task, question, or thread to follow up on later.',
			'  • memory_record_event — a point-in-time occurrence for the time-ordered log that is NOT current state (a deploy shipped, a build failed, an approach was tried, a clue was revealed). Use sparingly.'
		].join('\n'),

		'You are only the CAPTURE half of a two-stage memory system. A separate retrieval stage runs on every later turn and is the one that decides what to surface: it relevance-ranks the stored facts against the live query and drops whatever will not fit a token budget. Filtering for relevance and keeping the working context small are THAT stage\'s job — never yours, and you cannot help it by storing less. So never thin out, generalize away, fold together, or skip a detail for fear of storing "too much": a large pile of tiny atomic facts is exactly what retrieval is built to filter through, whereas a detail you decline to record is gone for good and no later search can recover it. Storage is cheap and every fact is independently searchable, supersedable, and countable; whenever you are torn between recording many granular facts and keeping memory tidy, always record the many granular facts.',

		[
			'Work through the turn in this order:',
			'1. SCAN every source — user message, assistant message, recent transcript, and tool calls — for anything that could matter after this turn ends: names, exact values, conditions, qualifiers. Over-capture: a detail you record and never need costs little; one you drop is gone. When in doubt, include it.',
			'2. RETRIEVE before you write. A referent mentioned this turn is very often already stored under a different surface form. Call memory_search (by name AND by likely key) and memory_get_entity to confirm, then reuse the existing canonical entityKey. Treat short and long forms of a name as the SAME entity (a bare first name vs. character.firstname_lastname; "auth" vs. "auth_service"). Only mint a new entity — via memory_set_attributes, passing entityType and/or displayName (either, both, or neither: an omitted field is derived from the entityKey) to type and name it in the same call as its first facts — for a genuinely new referent.',
			'3. WRITE granular facts. Put ONE distinct trait per attribute item — never collapse several into a single "description" value. "A tall woman with red hair who fears deep water" → build=tall, hair=red, fears=deep water. A one-line prose blurb, if any, goes in the entity\'s `summary` (a top-level field on memory_set_attributes), NOT as a fact. Granular facts are individually searchable, supersedable, and countable; a mega-description is none of those. Splitting always wins: the downstream retrieval stage can cheaply filter a surplus of small facts, but it can never reconstruct a detail you folded away here, so prefer five thin facts over one fat one even when it feels excessive.',
			'4. SKIP what is unchanged. The packet lists every fact already in memory with its current value. Record an attribute (or entity) only when it is genuinely NEW or its value has CHANGED versus the packet — a changed value must be re-asserted, since it supersedes the prior value in place. Re-asserting a predicate=value already shown records nothing (it is deduped) and only wastes your iteration budget; skip it.',
			'5. MAINTAIN open loops. Call memory_get_open_loops. Pass every still-live loop\'s handle (its [id=...], e.g. loop.find_attic_key) to memory_keep_loops, and call memory_close_loop ("resolved" = done/answered, "dropped" = abandoned/superseded) for any the turn settled — e.g. when the user picked one of several offered options, drop the unchosen ones. A loop flagged "[expires in N passes unless kept]" must be reaffirmed or retired THIS turn; any loop you neither keep nor close is treated as stale and auto-dropped after a few passes. Use memory_open_loop only for genuinely NEW threads.',
			'6. DEDUPE entities you find. If a search reveals two entities for the same real referent (classic case: a bare name vs. a fuller name, like character.firstname and character.firstname_lastname), confirm with memory_get_entity, then call memory_merge_entities (from = the duplicate to retire, into = the canonical key to keep). Never merge two genuinely distinct referents that merely share part of a name.'
		].join('\n'),

		[
			'Two judgment calls cause most mistakes:',
			'- ATTRIBUTE vs DIRECTIVE: is there a standing rule for how you must ACT from now on (a directive) or just something to KNOW (an attribute)? A directive is a standing rule however phrased — plain declarative policy ("All introduced characters are to be given names.", "Keep responses under 200 words.") counts exactly as much as "always …"/"never …". A directive counts REGARDLESS OF WHO STATES IT: capture it whether the USER issues the rule OR the ASSISTANT declares it about its own role or operating behavior in a self-describing reply. So the assistant saying "I am a text-based RPG. I track inventory and always describe the scene before asking for input." yields durable directives — record the role as a standing rule ("Act as a text-based RPG.") and each operating rule it states about itself. Capture ONLY durable/standing operating rules and role definitions; SKIP greetings, conversational offers to proceed ("How would you like to begin?"), and one-off or next-step plans for the current turn. One-off work for this turn ("rename this variable", "fix the bug in foo()") is NEITHER directive nor event — record anything durable about it as an attribute.',
			"- ATTRIBUTE vs EVENT: prefer attribute. A changed value is an attribute (it supersedes in place). Reach for event ONLY when the occurrence and its ordering are the point and re-stating it later would ADD another log entry rather than UPDATE a value. When an occurrence is just the flip side of a state change, prefer memory_set_attributes with that item's optional `event` summary over a standalone event."
		].join('\n'),

		'Corrections SUPERSEDE: re-assert the same entityKey+predicate via memory_set_attributes and the prior value retires automatically — you almost never need to forget. Use memory_forget_attribute / memory_forget_directive (by [id=...] handle, or by entityKey+predicate) ONLY when no supersede can reach the stale item, in exactly two cases. (1) Compound split: when you break one non-specific attribute into granular facts under NEW predicates (description="a tall woman with red hair" → build=tall, hair=red), the original "description" predicate is left orphaned and active because nothing re-asserts it — forget it after staging the granular facts. (2) Explicit retraction: when the user withdraws a trait or rule with NO replacement. If the user OVERRIDES a rule with a new one, record the replacement with memory_add_directive instead of forgetting. Never forget merely to tidy.',

		'Each write tool takes a small flat object (e.g. memory_set_attributes: { entityKey, attributes: [{ predicate, value }] }; memory_add_directive: { rule }). Call tools as many times as you need; nothing commits until you finish, and a rejected call never loses what you already staged. A call returns ok:true when staged, or ok:false with `issues` (each carrying a `hint`) and an `expected.example` to copy — fix the named fields and call again. memory_set_attributes validates per item: valid items stage, and only the items listed in `results` with "staged": false need re-sending.',

		[
			'HANDLE EVERY REJECTED WRITE — do not ignore one and move on.',
			'- A rejected call (ok:false) carries a short `failureId` (e.g. f1). The run is NOT allowed to end while any failureId is still outstanding.',
			'- To RESOLVE a failure: call the same tool again with the issues fixed AND pass that id as `failureId`. On success the failure clears automatically (the result echoes `clearedFailureId`); if it fails again the SAME id comes back — keep fixing, do not invent a new attempt.',
			'- To ABANDON a failure you genuinely cannot fix: list its id in memory_end_extraction\'s `acknowledgedFailures`. This is a deliberate "I am dropping this" — only use it when retrying is hopeless.',
			'- If you call memory_end_extraction while any failureId is neither cleared nor acknowledged, it is REFUSED and the error names the ids; resolve or acknowledge them, then end the run.'
		].join('\n'),

		'Never store credentials, tokens, secrets, raw tool output, or current repository state as timeless truth.',

		[
			'Worked example. Turn: user says "Mara, also called the Raven, is now in the study and owns the brass key. From now on, give every new character a name." The packet already has character.mara (location=cellar).',
			'1. memory_search("Raven") + memory_get_entity("character.mara") → the Raven is Mara; reuse character.mara, do not mint a new entity.',
			'2. memory_set_attributes { entityKey: "character.mara", attributes: [ { predicate: "alias", value: "the Raven" }, { predicate: "location", value: "study" }, { predicate: "owns", value: "brass key" } ] } — location supersedes cellar in place.',
			'3. memory_add_directive { rule: "Give every newly introduced character a name." }',
			'4. If the search surfaced a stray person.raven for the same character → memory_merge_entities { from: "person.raven", into: "character.mara" }.'
		].join('\n'),

		'memory_end_extraction ends the WHOLE run — it is NOT how you save a single memory (the write tools above already stage each fact). Call it exactly ONCE, at the very end, after you have staged everything durable from this turn (or immediately if nothing needed storing); never after each individual write. It stops staging, commits everything staged, and exits the turn. Pass an optional one-line `summary` and write a brief final message summarizing what you recorded (or noting nothing durable needed storing) — that closing message is shown as the extraction session summary. It also takes `acknowledgedFailures`: if any earlier write is still failing and you are deliberately giving up on it, list its `failureId` there, or the call will be refused.'
	].join('\n\n');
}

export function buildExtractorPrompt(input: ExtractPatchInput, maxInputChars: number): string {
	return truncate(
		[
			'Return JSON with this shape:',
			'{"summary":"short summary","confidence":0.0,"diagnostics":[],"patch":{"entities":[],"facts":[],"closeLoops":[],"keepOpenLoops":[]}}',
			'Every item in patch.facts MUST carry a "kind" — one of attribute, directive, open_loop, or event — with that kind\'s required fields, e.g. {"kind":"attribute","entityKey":"...","predicate":"...","value":...}, {"kind":"directive","rule":"..."}, {"kind":"open_loop","loopType":"...","title":"..."}, {"kind":"event","eventType":"...","summary":"..."}. keepOpenLoops and closeLoops reference existing open loops by the handle shown in their [id=...] (a stable key like loop.find_attic_key).',
			...extractorContextSections(input)
		].join('\n\n'),
		maxInputChars
	);
}

/**
 * The single-shot JSON extractor's instruction-rich context: the shared concept
 * guidance followed by the turn data. The single-shot backend sends only a
 * minimal system message, so its instructions must travel in the user prompt.
 * The agentic tool extractor does NOT use this — it carries its instructions in
 * its system prompt and gets only toolExtractorContextSections (data) as input.
 */
export function extractorContextSections(input: ExtractPatchInput): string[] {
	return [...extractorInstructionSections(), ...extractorTurnData(input)];
}

/**
 * The agentic tool extractor's user content: turn data only, with a one-line
 * framing. All of its rules live in buildToolExtractorSystemPrompt(), so this
 * deliberately omits the instructional prose (and the single-shot-only "patch"
 * vocabulary) that would otherwise be repeated a third time.
 */
export function toolExtractorContextSections(input: ExtractPatchInput): string[] {
	return [
		'Extract durable memory from the turn below by calling tools. The rules and procedure are in the system prompt; do not re-record values already shown in the initial packet.',
		...extractorTurnData(input)
	];
}

/**
 * The concept guidance emitted inline only for the single-shot extractor. Kept
 * as its own block so the turn data can be reused without the prose.
 */
function extractorInstructionSections(): string[] {
	return [
		'Your job: capture everything from this turn that could matter after it ends. Draw from every source — the user message, the assistant message, the recent transcript, and the tool calls — and record concrete specifics (names, exact values, conditions, qualifiers), never vague summaries. Err strongly toward over-capturing: a detail you record and never need costs little; one you drop is gone. When in doubt, include it. You are only the CAPTURE half of a two-stage system: a separate retrieval stage relevance-ranks the stored facts against each later turn and trims them to a token budget, so filtering for relevance and keeping context small are ITS job, not yours — never store less to stay tidy, because a surplus of tiny facts is exactly what that stage filters through, while a dropped detail is unrecoverable.',
		'Memory has only TWO concepts. (1) entities: the durable referents (a person, object, file, component, topic, project concept) that things attach to. (2) facts: everything you record about them. Each fact is exactly one of four kinds — decide deliberately which each thing is:\n- attribute: something to KNOW — durable current state: a value, status, relationship, preference, constraint, location, ownership, role, capability, deadline, dependency, identifier, or numeric value. This is the default; most things are attributes.\n- directive: a standing rule for how YOU must behave going forward (your conduct, style, format, or process).\n- open_loop: an unresolved question, task, or thread awaiting follow-up.\n- event: a point-in-time occurrence for the time-ordered log that is NOT current state (something happened: a deploy, a failed build, an approach tried, a clue revealed). Use sparingly.',
		'Attributes supersede in place — you correct or replace one simply by re-asserting it (a new attribute with the same entityKey+predicate) and the prior value is retired automatically. Directives and events are append-only. Open loops are explicitly kept alive or retired. Prefer supersede for any correction; an attribute or directive can be retired outright (via the dedicated forget tools, when available) only in the rare case no supersede applies — e.g. a compound attribute you have split into granular facts under new predicates, or a trait/rule the user explicitly retracted with no replacement. Only record an attribute that is NEW or whose value CHANGED versus the initial packet below; re-asserting a predicate=value already shown there records nothing new — skip it.',
		'Two distinctions cause most errors. (1) attribute vs directive: ask whether there is a standing rule for how to ACT from now on (a directive) or just something to KNOW (an attribute). A directive is a standing rule regardless of phrasing — plain declarative policy ("All introduced characters are to be given names.", "Keep responses under 200 words.") counts exactly as much as "always …" / "never …". A directive counts regardless of WHO states it: capture it whether the user issues the rule OR the assistant declares it about its own role or operating behavior in a self-describing reply. So the assistant saying "I am a text-based RPG. I track inventory and always describe the scene before asking for input." yields durable directives — record the role as a standing rule ("Act as a text-based RPG.") and each operating rule it states about itself. Capture ONLY durable/standing operating rules and role definitions; skip greetings, conversational offers to proceed ("How would you like to begin?"), and one-off or next-step plans for the current turn. One-off work for this turn ("rename this variable", "fix the bug in foo()", "add a test") is NOT a directive — capture anything durable about it as an attribute. (2) attribute vs event: prefer attribute. A changed value is an attribute (it supersedes in place); reach for event only when the occurrence and its ordering are the point and re-stating it later would add another log entry rather than update a value — "the change happened" is rarely worth a separate event on top of the attribute. Directives are additive and persist until retired: record a new one per genuinely new rule, re-record identical text only when the user reaffirms it (duplicates are de-duped), and when the user overrides a prior rule, state the full replacement as a new directive (the old wording stays active until retired via the memory inspector).',
		'Keep attributes granular: split each distinct detail into its own fact rather than collapsing several together — e.g. a character "tall with red hair who fears deep water" is three separate attributes (build=tall, hair=red, fears=deep water), not one "description" value. A one-line prose blurb, if any, belongs in the entity summary, not in a fact. Splitting always wins: prefer many thin facts over one fat one even when it feels excessive, since retrieval can filter a surplus of small facts but can never reconstruct a detail you compressed away. Attributes, events, and open_loops attach to an entity via its canonical entityKey (directives are global). Reuse an existing key from the initial packet whenever the referent already exists — do not mint a second entity for an alias, casing change, title, or partial/expanded name (a bare first name and a full name, e.g. character.firstname vs character.firstname_lastname, are the SAME entity). Create a new entity only for a durable referent not already represented, using a stable namespaced key (e.g. character.mara, object.attic_key, file.src_routes_api, component.memory_extractor, concept.append_only_migrations). An attribute with no natural entity is a last resort. If unsure whether two names are the same referent, reuse the existing key and note the uncertainty in diagnostics.',
		'Maintain open loops actively. Each open loop is shown with its handle as [id=...] (a stable, legible key like loop.find_attic_key). For every still-live loop, keep it alive. When this turn resolves, answers, or abandons a loop, retire it instead with status "resolved" for done/answered or "dropped" for abandoned/superseded — e.g. when the user picks one of several offered options, drop the unchosen ones. Any presented loop you neither keep nor retire is treated as stale and auto-dropped after a few passes; a loop close to that cutoff is flagged "[expires in N passes unless kept]", so treat that as a prompt to either reaffirm it (if still live) or retire it this turn — do not silently ignore a loop that is still relevant.',
		'Entities, facts, and events also show an [id=...] handle for precise reference. Open loops are acted on by handle (keep/retire). To correct a fact, re-assert an attribute with the same entityKey and predicate (the prior value is superseded automatically) — prefer this whenever the predicate is unchanged. Retiring a fact outright by handle is reserved for the rare case no supersede applies (a compound attribute split into granular facts, or an explicitly-retracted trait/rule).',
		'Never store credentials, tokens, secrets, raw tool output, or current repository state as timeless truth.'
	];
}

/**
 * The shared, instruction-free description of the turn to extract from: memory
 * mode, the initial packet, the turn's tool calls, and the user/assistant
 * messages. Both extractors feed this to the model; only the surrounding
 * instructions differ.
 */
export function extractorTurnData(input: ExtractPatchInput): string[] {
	return [
		`Memory mode: ${input.mode}`,
		'Initial packet:',
		redactSensitiveText(
			input.initialPacket
				? renderMemoryPacket(input.initialPacket, {
						includeIds: true,
						includeToolGuidance: false,
						openLoopExpiry: { baseThreshold: loadConfig().MEMORY_OPEN_LOOP_MAX_IDLE_TURNS }
					})
				: '(none)'
		),
		'Memory tool calls this turn:',
		redactSensitiveText(
			JSON.stringify(
				(input.memoryToolCalls ?? []).map((tool) => ({
					toolName: tool.toolName,
					resultSummary: tool.resultSummary,
					resultIds: tool.resultIds
				})),
				null,
				2
			)
		),
		'Regular tool calls this turn:',
		redactSensitiveText(
			JSON.stringify(
				(input.regularToolCalls ?? []).map((tool) => ({
					tool: tool.tool,
					status: tool.status
				})),
				null,
				2
			)
		),
		'User message:',
		redactSensitiveText(input.userMessage.content),
		'Assistant message:',
		redactSensitiveText(input.assistantMessage.content)
	];
}
