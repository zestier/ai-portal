/**
 * Prompt builders for the memory extractors. buildToolExtractorSystemPrompt is
 * the system prompt for the tool-calling extractor; buildExtractorPrompt +
 * extractorContextSections build the single-shot JSON extractor's prompt and the
 * shared turn-context block both extractors feed the model.
 */
import { loadConfig } from '$lib/server/config';
import { renderMemoryPacket } from '../engine';
import type { ExtractPatchInput } from './types';
import { truncate, redactSensitiveText } from './utils';

export function buildToolExtractorSystemPrompt(): string {
	return [
		'You are a dedicated background memory extractor. You run after each turn and your job is to durably store memory by calling tools. You are not answering the user; you are recording what should be remembered.',
		'Memory has only two concepts: entities (the durable referents) and facts (everything recorded about them). You record a fact by calling the matching write tool — there is no generic patch and no "kind" field to set; the tool you pick IS the classification:\n- remember_attributes: things to KNOW — durable current state (values, status, preferences, relationships, ownership, constraints). This is the default; most things are attributes. One call sets MANY attributes on one entity.\n- remember_directive: a standing rule for how YOU must behave going forward.\n- remember_loop: a NEW unresolved task/question to follow up on later.\n- remember_event: a point-in-time occurrence for the time-ordered log that is NOT current state (a deploy, a failed build, an approach tried, a clue revealed). Use sparingly — and when an occurrence is just the flip side of a state change, prefer recording the change via remember_attributes with that item\'s optional `event` summary rather than a standalone event.\nTwo distinctions cause most mistakes. (1) attribute vs directive: if the user is telling you how to ACT from now on it is a directive (however phrased); if it is something to know it is an attribute. (2) attribute vs event: prefer attribute. Reach for event ONLY when the occurrence and its ordering are the point and re-stating it later would add another log entry rather than update a value. A changed value is an attribute (it supersedes in place); "the change happened" is rarely worth a separate event. One-off work for this turn is neither directive nor event — record anything durable about it as an attribute.',
		'Be GRANULAR with attributes. remember_attributes takes a shared entityKey and an `attributes` array — put ONE distinct trait per item, never several collapsed into a single "description" value. A character described as "a tall woman with red hair who fears deep water and carries a brass key" becomes separate items: build=tall, hair=red, fears=deep water, carries=brass key. A one-line prose blurb (if any) goes in the entity\'s `summary` via remember_entity, NOT as a fact. Granular facts are individually searchable, supersedable, and countable; a mega-description is none of those.',
		'Retrieve before you write: a referent mentioned this turn is very often an entity you already stored under a different surface form. Before recording anything against a new entityKey, call memory_search (and memory_get_entity to confirm) for the person, object, place, file, component, or concept by name AND by likely key, and reuse the existing canonical entityKey instead of minting a near-duplicate. Treat short and long forms of a name as the same entity (e.g. a bare first name vs. a full name like "character.firstname" and "character.firstname_lastname", or "auth" and "auth_service"). For a genuinely new referent, call remember_entity to give it a type and display name, then attach facts to its entityKey.',
		'Each write tool takes a small flat object — just the fields that tool needs (e.g. remember_attributes: { entityKey, attributes: [{ predicate, value }] }; remember_directive: { rule }). You may call tools as many times as you need. Each call is validated and returns ok:true when staged or ok:false with `issues` (each carrying a `hint`) and an `expected.example` to copy when it is rejected — fix the named fields and call again. For remember_attributes, validation is per-item: valid items still stage and only the items listed in `results` with "staged": false need re-sending. Nothing commits until you finish, and a rejected call never loses what you already staged.',
		'Clean up duplicates you find: if a search reveals two entities that denote the same real referent (the classic case is a bare name vs. a fuller name, like character.firstname and character.firstname_lastname), call memory_merge_entities with from = the duplicate to retire and into = the canonical key to keep. Verify with memory_get_entity that they are truly the same before merging — never merge two genuinely distinct referents that merely share part of a name.',
		'Maintain open loops actively: call memory_get_open_loops to see existing loops, each shown with a stable handle (its [id=...], e.g. loop.find_attic_key). Pass every still-live loop\'s handle to keep_loops to keep it alive, and call close_loop (status "resolved" or "dropped") for any the turn resolved or superseded — e.g. when the user was offered options and chose one, drop the unchosen options. Use remember_loop only for genuinely NEW threads. Any presented loop you neither keep nor close is treated as stale and auto-dropped after a few passes.',
		'When you have stored everything durable from this turn, stop calling tools and write a brief final message summarizing what you recorded (or noting that nothing durable needed storing). That closing message is shown as the extraction session summary.'
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
 * The shared, instruction-light context block describing the turn to extract
 * from. Both the single-shot JSON extractor and the tool-calling extractor feed
 * this to the model; only the surrounding output instructions differ.
 */
export function extractorContextSections(input: ExtractPatchInput): string[] {
	return [
		'Your job: capture everything from this turn that could matter after it ends. Draw from every source — the user message, the assistant message, the recent transcript, and the tool calls — and record concrete specifics (names, exact values, conditions, qualifiers), never vague summaries. Err strongly toward over-capturing: a detail you record and never need costs little; one you drop is gone. When in doubt, include it.',
		'Memory has only TWO concepts. (1) entities: the durable referents (a person, object, file, component, topic, project concept) that things attach to. (2) facts: everything you record about them. Each fact is exactly one of four kinds — decide deliberately which each thing is:\n- attribute: something to KNOW — durable current state: a value, status, relationship, preference, constraint, location, ownership, role, capability, deadline, dependency, identifier, or numeric value. This is the default; most things are attributes.\n- directive: a standing rule for how YOU must behave going forward (your conduct, style, format, or process).\n- open_loop: an unresolved question, task, or thread awaiting follow-up.\n- event: a point-in-time occurrence for the time-ordered log that is NOT current state (something happened: a deploy, a failed build, an approach tried, a clue revealed). Use sparingly.',
		'Attributes supersede in place — you correct or replace one simply by re-asserting it (a new attribute with the same entityKey+predicate) and the prior value is retired automatically. Directives and events are append-only. Only open loops are explicitly kept alive or retired. So you never "close" anything except open loops.',
		'Two distinctions cause most errors. (1) attribute vs directive: ask whether the user is telling you how to ACT from now on (a directive) or telling you something to KNOW (an attribute). A directive is a standing rule regardless of phrasing — plain declarative policy ("All introduced characters are to be given names.", "Keep responses under 200 words.") counts exactly as much as "always …" / "never …". One-off work for this turn ("rename this variable", "fix the bug in foo()", "add a test") is NOT a directive — capture anything durable about it as an attribute. (2) attribute vs event: prefer attribute. A changed value is an attribute (it supersedes in place); reach for event only when the occurrence and its ordering are the point and re-stating it later would add another log entry rather than update a value — "the change happened" is rarely worth a separate event on top of the attribute. Directives are additive and persist until retired: record a new one per genuinely new rule, re-record identical text only when the user reaffirms it (duplicates are de-duped), and when the user overrides a prior rule, state the full replacement as a new directive (the old wording stays active until retired via the memory inspector).',
		'Keep attributes granular: split each distinct detail into its own fact rather than collapsing several together — e.g. a character "tall with red hair who fears deep water" is three separate attributes (build=tall, hair=red, fears=deep water), not one "description" value. A one-line prose blurb, if any, belongs in the entity summary, not in a fact. Attributes, events, and open_loops attach to an entity via its canonical entityKey (directives are global). Reuse an existing key from the initial packet whenever the referent already exists — do not mint a second entity for an alias, casing change, title, or partial/expanded name (a bare first name and a full name, e.g. character.firstname vs character.firstname_lastname, are the SAME entity). Create a new entity only for a durable referent not already represented, using a stable namespaced key (e.g. character.mara, object.attic_key, file.src_routes_api, component.memory_extractor, concept.append_only_migrations). An attribute with no natural entity is a last resort. If unsure whether two names are the same referent, reuse the existing key and note the uncertainty in diagnostics.',
		'Maintain open loops actively. Each open loop is shown with its handle as [id=...] (a stable, legible key like loop.find_attic_key). For every still-live loop, keep it alive. When this turn resolves, answers, or abandons a loop, retire it instead with status "resolved" for done/answered or "dropped" for abandoned/superseded — e.g. when the user picks one of several offered options, drop the unchosen ones. Any presented loop you neither keep nor retire is treated as stale and auto-dropped after a few passes; a loop close to that cutoff is flagged "[expires in N passes unless kept]", so treat that as a prompt to either reaffirm it (if still live) or retire it this turn — do not silently ignore a loop that is still relevant.',
		'Entities, facts, and events also show an [id=...] handle for precise reference, but only open loops are acted on by handle (keep/retire). To correct a fact, re-assert an attribute with the same entityKey and predicate (the prior value is superseded automatically); you never retire a fact or event by id.',
		'Never store credentials, tokens, secrets, raw tool output, or current repository state as timeless truth.',
		`Memory mode: ${input.mode}`,
		'Initial packet:',
		redactSensitiveText(
			input.initialPacket
				? renderMemoryPacket(input.initialPacket, {
						includeIds: true,
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
