import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as users from '../src/lib/server/db/repos/users';
import * as convs from '../src/lib/server/db/repos/conversations';
import * as messages from '../src/lib/server/db/repos/messages';
import * as memory from '../src/lib/server/db/repos/memory';
import {
	ageOpenLoops,
	buildInitialPacket,
	buildPromptWithMemory,
	commitPatch,
	renderMemoryPacket,
	validatePatch
} from '../src/lib/server/memory/engine';
import {
	extractAndCommitMemory,
	OpenAICompatibleMemoryExtractor,
	ToolCallingMemoryExtractor,
	type ExtractorActivity,
	type ExtractorAssistantTurn,
	type ExtractorChatMessage,
	type ExtractorToolSpec
} from '../src/lib/server/memory/extractor';
import { getMemoryProfile, listMemoryProfiles } from '../src/lib/server/memory/profiles';
import {
	buildToolExtractorSystemPrompt,
	buildExtractorPrompt
} from '../src/lib/server/memory/extractor/prompts';
import type { ExtractPatchInput } from '../src/lib/server/memory/extractor/types';
import * as memoryProfiles from '../src/lib/server/memory/profiles';
import { buildMemoryTools } from '../src/lib/server/tools/memory';
import type { ToolResult } from '../src/lib/server/tools/types';
import { PATCH as patchMemoryItem } from '../src/routes/api/conversations/[id]/memory/[kind]/[itemId]/+server';
import { getDb } from '../src/lib/server/db';
import { setupLocalEnv } from './helpers/env';

// The structured tool-result envelope is the model-visible payload; substring
// assertions check that serialized form, structured assertions read `result`.
function toolText(r: ToolResult): string {
	return JSON.stringify(r);
}
function toolData<T>(r: ToolResult): T {
	if (!r.ok) throw new Error(`expected ok envelope, got error: ${r.error.message}`);
	return r.result as T;
}

function routeEvent(
	conversationId: string,
	userId: string,
	kind: string,
	itemId: string,
	body: unknown
): Parameters<typeof patchMemoryItem>[0] {
	return {
		params: { id: conversationId, kind, itemId },
		locals: { userId },
		request: new Request('http://local.test', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		})
	} as Parameters<typeof patchMemoryItem>[0];
}

// Build a single-tool-call assistant turn for the tool-calling extractor's
// chatComplete double. The new write surface is one tool per fact kind plus
// keep_loops/close_loop, each taking a flat args object.
function writeCall(id: string, name: string, args: unknown): ExtractorAssistantTurn {
	return { content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

describe('memory-backed sessions', () => {
	beforeEach(async () => {
		await setupLocalEnv();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('round-trips memory mode on conversations', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });

		expect(conv.memoryMode).toBe('off');
		expect(convs.updateSessionSettings(conv.id, user.id, { memoryMode: 'project' })).toBe(true);
		expect(convs.get(conv.id, user.id)?.memoryMode).toBe('project');
		expect(
			convs.updateSessionSettings(conv.id, user.id, { memoryExtractorModel: 'harvester-a' })
		).toBe(true);
		expect(convs.get(conv.id, user.id)?.memoryExtractorModel).toBe('harvester-a');
		expect(convs.updateSessionSettings(conv.id, user.id, { memoryExtractorModel: null })).toBe(
			true
		);
		expect(convs.get(conv.id, user.id)?.memoryExtractorModel).toBeNull();
		expect(convs.updateSessionSettings(conv.id, user.id, { globalMemoryEnabled: true })).toBe(true);
		expect(convs.get(conv.id, user.id)?.globalMemoryEnabled).toBe(true);
	});

	it('filters facts by entity and predicate together', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const entity = memory.upsertEntity(conv.id, {
			entityKey: 'object.key',
			entityType: 'object',
			displayName: 'Key'
		});
		memory.addFact(conv.id, { entityId: entity.id, predicate: 'location', value: 'study' });
		memory.addFact(conv.id, { entityId: entity.id, predicate: 'color', value: 'brass' });

		const located = memory.listFacts(conv.id, { entityId: entity.id, predicate: 'location' });
		expect(located).toHaveLength(1);
		expect(located[0]?.predicate).toBe('location');
		expect(located[0]?.value).toBe('study');
	});

	it('centralizes built-in memory profile definitions for custom profile groundwork', () => {
		expect(listMemoryProfiles().map((profile) => profile.mode)).toEqual([
			'off',
			'lightweight',
			'project',
			'story',
			'strict'
		]);
		expect(getMemoryProfile('strict').validationFocus).toContain('character_knowledge');
		expect(getMemoryProfile('project').instructions).toContain('historical');
	});

	it('stores editable custom memory profiles', () => {
		const user = users.ensureLocalUser();
		const created = memoryProfiles.createCustomProfile(user.id, {
			name: 'Lore keeper',
			description: 'Tracks canon.',
			instructions: 'Remember lore and validate contradictions.',
			schema: { entities: ['character', 'faction'] }
		});
		expect(created.schema).toEqual({ entities: ['character', 'faction'] });

		const updated = memoryProfiles.updateCustomProfile(created.id, user.id, {
			name: 'Canon keeper',
			description: 'Tracks canon and secrets.',
			instructions: 'Remember canon, secrets, and visibility.',
			schema: { validation: ['secret_visibility'] }
		});
		expect(updated?.name).toBe('Canon keeper');
		expect(memoryProfiles.listCustomProfiles(user.id, { status: 'all' })).toHaveLength(1);
		expect(memoryProfiles.archiveCustomProfile(created.id, user.id)).toBe(true);
		expect(memoryProfiles.listCustomProfiles(user.id)).toHaveLength(0);
		expect(memoryProfiles.listCustomProfiles(user.id, { status: 'archived' })[0]?.name).toBe(
			'Canon keeper'
		);
	});

	it('renders packets as compact text without raw JSON noise', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });

		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{
						entityKey: 'character.mara',
						entityType: 'character',
						displayName: 'Mara',
						summary: 'A wary scout.'
					}
				],
				facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'the cellar' }],
				openLoops: [
					{
						loopType: 'task',
						title: 'Find the attic key',
						relatedEntityKeys: ['character.mara']
					}
				]
			}
		});

		const packet = buildInitialPacket(conv.id, 'story');
		const rendered = renderMemoryPacket(packet);

		// Compact, readable text rather than a pretty-printed JSON blob.
		expect(rendered).not.toContain('"createdAt"');
		expect(rendered).not.toContain('"conversationId"');
		expect(rendered).not.toContain('{\n');
		// Semantic content is preserved, including reusable entity keys.
		expect(rendered).toContain('character.mara (character) "Mara" — A wary scout.');
		// Facts render grouped beneath their owning entity, not as flat
		// "entityKey.predicate = value" lines.
		expect(rendered).not.toContain('character.mara.location = the cellar');
		expect(rendered).toMatch(/character\.mara[^\n]*\n {4}location = the cellar/);
		expect(rendered).toContain('Find the attic key');
		expect(rendered).toContain('[related: character.mara]');
		// The default (main-turn) rendering omits internal ids as noise.
		expect(rendered).not.toMatch(/\[id=/);
		// The extractor view opts into ids for every primitive so it can reference
		// and close items precisely instead of only opening them.
		const extractorRendered = renderMemoryPacket(packet, { includeIds: true });
		expect(extractorRendered).toMatch(/\[id=[^\]]+\] \(task, p\d+\) Find the attic key/);
		// Ids are surfaced on entities and facts too, not just loops.
		expect(extractorRendered).toMatch(/character\.mara[^\n]*\[id=[^\]]+\]/);
		expect(extractorRendered).toMatch(/location = the cellar \[id=[^\]]+\]/);

		const prompt = buildPromptWithMemory({
			conversationId: conv.id,
			mode: 'story',
			userMsg: messages.append(conv.id, { role: 'user', content: 'Where is Mara?' })
		});
		expect(prompt).toContain('<portal_memory_mode>');
		expect(prompt).not.toContain('"updatedAt"');
	});

	it('commits typed memory and retrieves it through packets and search', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });

		const committed = commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{
						entityKey: 'decision.memory_tools',
						entityType: 'decision',
						displayName: 'Mandatory memory tools'
					}
				],
				facts: [
					{
						entityKey: 'decision.memory_tools',
						predicate: 'status',
						value: 'mandatory_first_pass'
					}
				],
				openLoops: [{ loopType: 'implementation', title: 'Build strict profile validators' }]
			}
		});

		expect(committed.patch.status).toBe('committed');
		expect(
			memory.search(conv.id, { query: 'mandatory tools' }).map((row) => row.itemType)
		).toContain('entity');
		const packet = buildInitialPacket(conv.id, 'project');
		expect(packet.toolGuidance.mandatory).toBe(true);
		expect(packet.entities.map((entity) => entity.entityKey)).toContain('decision.memory_tools');
		expect(packet.openLoops[0]?.title).toContain('strict profile');
		expect(memory.listSnapshot(conv.id).patchItems.length).toBeGreaterThan(0);
	});

	it('reverts records created by a memory patch', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const committed = commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'object.key', entityType: 'object', displayName: 'Key' }],
				facts: [{ entityKey: 'object.key', predicate: 'location', value: 'study' }],
				openLoops: [{ loopType: 'clue', title: 'Find the key owner' }]
			}
		});

		const result = memory.revertPatch(conv.id, committed.patch.id);

		expect(result.reverted).toBeGreaterThanOrEqual(3);
		expect(result.patch?.status).toBe('reverted');
		expect(memory.listFacts(conv.id, { status: 'active' })).toHaveLength(0);
		expect(memory.listOpenLoops(conv.id)).toHaveLength(0);
		const searchAfterRevert = memory.search(conv.id, { query: 'study key owner' });
		expect(searchAfterRevert.map((row) => row.itemType)).not.toEqual(
			expect.arrayContaining(['entity', 'fact', 'open_loop'])
		);
	});

	it('resolves superseded open loops via resolveOpenLoops', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		// Offer three options as open loops, as story mode does when asking the
		// user what to do next.
		commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [
					{ loopType: 'choice', title: 'Option A: search the attic' },
					{ loopType: 'choice', title: 'Option B: question the maid' },
					{ loopType: 'choice', title: 'Option C: leave the manor' }
				]
			}
		});
		const loops = memory.listOpenLoops(conv.id);
		expect(loops).toHaveLength(3);
		const chosen = loops.find((l) => l.title.includes('Option A'))!;
		const dropped = loops.filter((l) => l.id !== chosen.id);

		// The user picked A; the unchosen options should be dropped.
		const committed = commitPatch({
			conversationId: conv.id,
			patch: {
				resolveOpenLoops: [
					{ id: chosen.id, status: 'resolved', reason: 'User chose to search the attic.' },
					{ id: dropped[0].id, status: 'dropped' },
					{ id: dropped[1].id, status: 'dropped' }
				]
			}
		});

		expect(committed.counts.resolvedOpenLoops).toBe(3);
		// No loops remain in the default ('open') view.
		expect(memory.listOpenLoops(conv.id)).toHaveLength(0);
		const resolved = memory.getOpenLoop(conv.id, chosen.id);
		expect(resolved?.status).toBe('resolved');
		expect(resolved?.description).toContain('User chose to search the attic.');
		expect(memory.getOpenLoop(conv.id, dropped[0].id)?.status).toBe('dropped');
	});

	it('ages out presented-but-untouched open loops while keeping touched ones alive', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [
					{ loopType: 'task', title: 'Keep me alive' },
					{ loopType: 'task', title: 'Forget me slowly' }
				]
			}
		});
		const loops = memory.listOpenLoops(conv.id);
		const keep = loops.find((l) => l.title.includes('Keep me'))!;
		const forget = loops.find((l) => l.title.includes('Forget me'))!;
		const presentedLoopIds = [keep.id, forget.id];

		// Pass 1: keep `keep`, ignore `forget`. With base threshold 2, the
		// untouched loop only accrues one idle turn — not yet dropped.
		let aged = ageOpenLoops(conv.id, {
			presentedLoopIds,
			keptLoopIds: [keep.id],
			baseThreshold: 2
		});
		expect(aged.dropped).toEqual([]);
		expect(memory.getOpenLoop(conv.id, forget.id)?.idleTurns).toBe(1);
		expect(memory.getOpenLoop(conv.id, keep.id)?.idleTurns).toBe(0);

		// Pass 2: same again — `forget` crosses the threshold and is auto-dropped,
		// while the continuously-kept loop stays open at idle 0.
		aged = ageOpenLoops(conv.id, { presentedLoopIds, keptLoopIds: [keep.id], baseThreshold: 2 });
		expect(aged.dropped).toEqual([forget.id]);
		expect(memory.getOpenLoop(conv.id, forget.id)?.status).toBe('dropped');
		expect(memory.getOpenLoop(conv.id, forget.id)?.description).toContain('auto-dropped');
		expect(memory.getOpenLoop(conv.id, keep.id)?.status).toBe('open');
		expect(memory.getOpenLoop(conv.id, keep.id)?.idleTurns).toBe(0);
		expect(memory.listOpenLoops(conv.id)).toHaveLength(1);
	});

	it('resets the idle counter when a stale loop is touched again', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: { openLoops: [{ loopType: 'task', title: 'Intermittently relevant' }] }
		});
		const loop = memory.listOpenLoops(conv.id)[0];
		const presentedLoopIds = [loop.id];

		ageOpenLoops(conv.id, { presentedLoopIds, baseThreshold: 3 });
		expect(memory.getOpenLoop(conv.id, loop.id)?.idleTurns).toBe(1);
		ageOpenLoops(conv.id, { presentedLoopIds, baseThreshold: 3 });
		expect(memory.getOpenLoop(conv.id, loop.id)?.idleTurns).toBe(2);
		// Reaffirmed this pass — idle resets, the accrued staleness is forgiven.
		ageOpenLoops(conv.id, { presentedLoopIds, keptLoopIds: [loop.id], baseThreshold: 3 });
		expect(memory.getOpenLoop(conv.id, loop.id)?.idleTurns).toBe(0);
		expect(memory.getOpenLoop(conv.id, loop.id)?.status).toBe('open');
	});

	it('never ages a loop the extractor was not shown', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [
					{ loopType: 'task', title: 'Presented and ignored' },
					{ loopType: 'task', title: 'Beyond the packet cap' }
				]
			}
		});
		const loops = memory.listOpenLoops(conv.id);
		const presented = loops.find((l) => l.title.includes('Presented'))!;
		const unseen = loops.find((l) => l.title.includes('Beyond'))!;

		// Only `presented` is in presentedLoopIds; with threshold 1 it drops at
		// once, but `unseen` — which the extractor never saw — must be untouched.
		const aged = ageOpenLoops(conv.id, { presentedLoopIds: [presented.id], baseThreshold: 1 });
		expect(aged.dropped).toEqual([presented.id]);
		expect(memory.getOpenLoop(conv.id, unseen.id)?.status).toBe('open');
		expect(memory.getOpenLoop(conv.id, unseen.id)?.idleTurns).toBe(0);
	});

	it('grants higher-priority loops more grace before aging out', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [
					{ loopType: 'task', title: 'Low priority chore', priority: 0 },
					{ loopType: 'task', title: 'High priority thread', priority: 3 }
				]
			}
		});
		const loops = memory.listOpenLoops(conv.id);
		const low = loops.find((l) => l.title.includes('Low'))!;
		const high = loops.find((l) => l.title.includes('High'))!;

		// One untouched pass at base threshold 1: the low-priority loop drops
		// immediately (1 >= 1), but the high-priority loop's effective threshold
		// is 1 + 3 = 4, so it only accrues idle and survives.
		const aged = ageOpenLoops(conv.id, {
			presentedLoopIds: [low.id, high.id],
			baseThreshold: 1
		});
		expect(aged.dropped).toEqual([low.id]);
		expect(memory.getOpenLoop(conv.id, high.id)?.status).toBe('open');
		expect(memory.getOpenLoop(conv.id, high.id)?.idleTurns).toBe(1);
	});

	it('renders an expiry warning for loops nearing auto-drop', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [
					{ loopType: 'task', title: 'Fading thread' },
					{ loopType: 'task', title: 'Fresh thread' }
				]
			}
		});
		const loops = memory.listOpenLoops(conv.id);
		const fading = loops.find((l) => l.title.includes('Fading'))!;
		const fresh = loops.find((l) => l.title.includes('Fresh'))!;
		const presentedLoopIds = loops.map((l) => l.id);

		// Age only `fading` so it sits one pass short of a base-threshold-3 drop;
		// `fresh` is reaffirmed each pass and stays at idle 0.
		ageOpenLoops(conv.id, { presentedLoopIds, keptLoopIds: [fresh.id], baseThreshold: 3 });
		ageOpenLoops(conv.id, { presentedLoopIds, keptLoopIds: [fresh.id], baseThreshold: 3 });
		expect(memory.getOpenLoop(conv.id, fading.id)?.idleTurns).toBe(2);
		expect(memory.getOpenLoop(conv.id, fresh.id)?.idleTurns).toBe(0);

		const packet = buildInitialPacket(conv.id, 'project');
		const rendered = renderMemoryPacket(packet, {
			includeIds: true,
			openLoopExpiry: { baseThreshold: 3 }
		});
		// effective threshold 3, idle 2 -> drops next pass: "expires in 1 pass".
		expect(rendered).toMatch(/Fading thread/);
		expect(rendered).toContain('[expires in 1 pass unless kept]');
		// The freshly-kept loop is nowhere near the cutoff, so it carries no warning.
		expect(rendered).not.toMatch(/\[expires in [^\]]+\] \(task, p\d+\) Fresh thread/);
		// Without the expiry option, no warning is rendered even when ids are on.
		expect(renderMemoryPacket(packet, { includeIds: true })).not.toContain('[expires in');
	});

	it('reconstructs idle counts and auto-drops when the projection is rebuilt', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const seed = messages.append(conv.id, { role: 'assistant', content: 'Tracking two threads.' });
		commitPatch({
			conversationId: conv.id,
			sourceMessageId: seed.id,
			patch: {
				openLoops: [
					{ loopType: 'task', title: 'Survivor loop' },
					{ loopType: 'task', title: 'Doomed loop' }
				]
			}
		});
		const loops = memory.listOpenLoops(conv.id);
		const survivor = loops.find((l) => l.title.includes('Survivor'))!;
		const doomed = loops.find((l) => l.title.includes('Doomed'))!;
		const presentedLoopIds = [survivor.id, doomed.id];

		const liveness = messages.append(conv.id, { role: 'assistant', content: 'Liveness pass.' });
		ageOpenLoops(conv.id, {
			presentedLoopIds,
			keptLoopIds: [survivor.id],
			baseThreshold: 2,
			sourceMessageId: liveness.id
		});
		ageOpenLoops(conv.id, {
			presentedLoopIds,
			keptLoopIds: [survivor.id],
			baseThreshold: 2,
			sourceMessageId: liveness.id
		});
		expect(memory.getOpenLoop(conv.id, doomed.id)?.status).toBe('dropped');

		// The idle counts and the auto-drop are derived from the liveness events,
		// not soft column state — a full projection rebuild must reproduce them
		// exactly (this is the property a non-event-sourced counter would lose).
		memory.rebuildSessionMemoryProjection(conv.id);
		expect(memory.getOpenLoop(conv.id, doomed.id)?.status).toBe('dropped');
		expect(memory.getOpenLoop(conv.id, survivor.id)?.status).toBe('open');
		expect(memory.getOpenLoop(conv.id, survivor.id)?.idleTurns).toBe(0);
	});

	it('does not age open loops under the heuristic extractor', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const seed = messages.append(conv.id, { role: 'assistant', content: 'Tracking a thread.' });
		commitPatch({
			conversationId: conv.id,
			sourceMessageId: seed.id,
			patch: { openLoops: [{ loopType: 'task', title: 'Should survive heuristic extraction' }] }
		});
		const loop = memory.listOpenLoops(conv.id)[0];
		const userMessage = messages.append(conv.id, { role: 'user', content: 'Anything new?' });
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'Not really.'
		});

		const result = await extractAndCommitMemory({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-heuristic',
			userMessage,
			assistantMessage
		});
		// The heuristic extractor emits no keep signal, so aging it would drop
		// everything — the wiring must gate liveness to model-backed extractors.
		expect(result.extractorKind).toBe('heuristic');
		expect(memory.getOpenLoop(conv.id, loop.id)?.status).toBe('open');
		expect(memory.getOpenLoop(conv.id, loop.id)?.idleTurns).toBe(0);
	});

	it('assigns a stable, legible loop key and addresses keep/close by it', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [
					{ loopType: 'task', title: 'Find the attic key' },
					// Two identical titles must get distinct, conversation-unique keys.
					{ loopType: 'task', title: 'Find the attic key' }
				]
			}
		});
		const loops = memory.listOpenLoops(conv.id);
		const keys = loops.map((l) => l.loopKey).sort();
		expect(keys).toEqual(['loop.find_the_attic_key', 'loop.find_the_attic_key_2']);

		// The extractor view renders the legible key as the handle, not a ULID.
		const packet = buildInitialPacket(conv.id, 'project');
		const rendered = renderMemoryPacket(packet, { includeIds: true });
		expect(rendered).toContain('[id=loop.find_the_attic_key]');

		// resolveOpenLoopId accepts either the key or the raw id.
		const first = loops.find((l) => l.loopKey === 'loop.find_the_attic_key')!;
		expect(memory.resolveOpenLoopId(conv.id, 'loop.find_the_attic_key')).toBe(first.id);
		expect(memory.resolveOpenLoopId(conv.id, first.id)).toBe(first.id);
		expect(memory.resolveOpenLoopId(conv.id, 'loop.nope')).toBeNull();

		// Closing a loop by its key resolves to the right row and retires it.
		commitPatch({
			conversationId: conv.id,
			patch: {
				resolveOpenLoops: [
					{ id: 'loop.find_the_attic_key', status: 'resolved', reason: 'found it' }
				]
			}
		});
		expect(memory.getOpenLoop(conv.id, first.id)?.status).toBe('resolved');
		expect(memory.getOpenLoop(conv.id, first.id)?.description).toContain('found it');
	});

	it('keeps a loop alive via liveness when reaffirmed by key', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [
					{ loopType: 'task', title: 'Kept by key' },
					{ loopType: 'task', title: 'Ignored thread' }
				]
			}
		});
		const loops = memory.listOpenLoops(conv.id);
		const kept = loops.find((l) => l.title.includes('Kept'))!;
		const ignored = loops.find((l) => l.title.includes('Ignored'))!;
		const presentedLoopIds = loops.map((l) => l.id);

		// keptLoopIds carries the model-facing key; liveness resolves it to the id
		// (presentedLoopIds are ids) so the kept loop stays at idle 0.
		const keptId = memory.resolveOpenLoopId(conv.id, kept.loopKey)!;
		ageOpenLoops(conv.id, { presentedLoopIds, keptLoopIds: [keptId], baseThreshold: 2 });
		ageOpenLoops(conv.id, { presentedLoopIds, keptLoopIds: [keptId], baseThreshold: 2 });
		expect(memory.getOpenLoop(conv.id, kept.id)?.status).toBe('open');
		expect(memory.getOpenLoop(conv.id, kept.id)?.idleTurns).toBe(0);
		expect(memory.getOpenLoop(conv.id, ignored.id)?.status).toBe('dropped');
	});

	it('warns but does not block when resolving an unknown open loop id', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const committed = commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [{ loopType: 'task', title: 'A real new loop' }],
				resolveOpenLoops: [{ id: 'loop_does_not_exist', status: 'dropped' }]
			}
		});

		// The unknown resolution is a no-op warning; the rest of the patch still commits.
		expect(committed.patch.status).toBe('committed');
		expect(committed.counts.openLoops).toBe(1);
		expect(committed.counts.resolvedOpenLoops).toBe(0);
		expect(memory.listOpenLoops(conv.id)).toHaveLength(1);
	});

	it('does not re-annotate or duplicate audit items when re-resolving a closed loop', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: { openLoops: [{ loopType: 'task', title: 'Investigate the noise' }] }
		});
		const loop = memory.listOpenLoops(conv.id)[0];
		const first = commitPatch({
			conversationId: conv.id,
			patch: { resolveOpenLoops: [{ id: loop.id, status: 'resolved', reason: 'Done.' }] }
		});
		expect(first.counts.resolvedOpenLoops).toBe(1);
		const afterFirst = memory.getOpenLoop(conv.id, loop.id);
		expect(afterFirst?.status).toBe('resolved');
		expect(afterFirst?.description).toContain('Done.');

		// Re-resolving the now-closed loop to the SAME status is a no-op: no
		// duplicate audit item, and the description doesn't grow.
		const again = commitPatch({
			conversationId: conv.id,
			patch: { resolveOpenLoops: [{ id: loop.id, status: 'resolved', reason: 'Done again.' }] }
		});
		expect(again.counts.resolvedOpenLoops).toBe(0);
		const afterSecond = memory.getOpenLoop(conv.id, loop.id);
		expect(afterSecond?.description).toBe(afterFirst?.description);
		expect(afterSecond?.description).not.toContain('Done again.');
	});

	it('reopens a resolved loop when its resolving patch is reverted', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: { openLoops: [{ loopType: 'task', title: 'Investigate the noise' }] }
		});
		const loop = memory.listOpenLoops(conv.id)[0];
		const resolving = commitPatch({
			conversationId: conv.id,
			patch: { resolveOpenLoops: [{ id: loop.id, status: 'dropped' }] }
		});
		expect(memory.listOpenLoops(conv.id)).toHaveLength(0);

		const result = memory.revertPatch(conv.id, resolving.patch.id);
		expect(result.reverted).toBe(1);
		expect(memory.getOpenLoop(conv.id, loop.id)?.status).toBe('open');
		expect(memory.listOpenLoops(conv.id)).toHaveLength(1);
	});

	it('reviews individual memory patch items', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const committed = commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ predicate: 'note', value: 'Reject stale item.' }] }
		});
		const item = memory
			.listPatchItems(conv.id, { patchId: committed.patch.id })
			.find((row) => row.itemType === 'fact')!;

		const approved = memory.reviewPatchItem(conv.id, item.id, 'approve');
		expect(approved.item?.reviewStatus).toBe('approved');
		expect(memory.listFacts(conv.id)).toHaveLength(1);

		const rejected = memory.reviewPatchItem(conv.id, item.id, 'reject');
		expect(rejected.item?.reviewStatus).toBe('rejected');
		expect(rejected.affected).toBe(true);
		expect(memory.listFacts(conv.id)).toHaveLength(0);
		expect(memory.search(conv.id, { query: 'stale item' })).toHaveLength(0);
	});

	it('validates profile-specific memory conflicts', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			mode: 'story',
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'study' }]
			}
		});

		const storyValidation = validatePatch(
			{ facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'garden' }] },
			{ conversationId: conv.id, mode: 'story' }
		);
		const strictValidation = validatePatch(
			{ facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'garden' }] },
			{ conversationId: conv.id, mode: 'strict' }
		);
		const strictShapeValidation = validatePatch(
			{
				facts: [
					{ predicate: 'knowledge:character.mara', value: 'Mara knows the candle was lit.' },
					{ predicate: 'clue', value: { status: 'revealed' } },
					{ entityKey: 'character.mara', predicate: 'secret.identity', value: 'Mara is the thief.' }
				],
				events: [{ eventType: 'timeline', summary: 'Mara entered the study.' }]
			},
			{ conversationId: conv.id, mode: 'strict' }
		);
		const strictTimelineValidation = validatePatch(
			{
				events: [
					{
						eventType: 'timeline',
						entityKey: 'character.mara',
						summary: 'Mara was in the study at midnight.',
						payload: { at: 'midnight', location: 'study' }
					},
					{
						eventType: 'alibi',
						entityKey: 'character.mara',
						summary: 'Mara was in the garden at midnight.',
						payload: { at: 'midnight', location: 'garden' }
					}
				]
			},
			{ conversationId: conv.id, mode: 'strict' }
		);
		const projectValidation = validatePatch(
			{ facts: [{ predicate: 'file.current_truth', value: 'src/lib/types.ts changed' }] },
			{ conversationId: conv.id, mode: 'project' }
		);

		expect(storyValidation.issues.map((issue) => issue.code)).toContain('location_conflict');
		expect(storyValidation.ok).toBe(true);
		expect(strictValidation.ok).toBe(false);
		expect(strictShapeValidation.ok).toBe(false);
		expect(strictShapeValidation.issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining([
				'strict_knowledge_without_entity',
				'strict_clue_shape_invalid',
				'strict_secret_visibility_required',
				'strict_event_without_entity'
			])
		);
		expect(strictTimelineValidation.ok).toBe(false);
		expect(strictTimelineValidation.issues.map((issue) => issue.code)).toContain(
			'strict_timeline_location_conflict'
		);
		expect(projectValidation.issues.map((issue) => issue.code)).toContain(
			'project_fact_must_be_historical'
		);
	});

	it('updates and deletes editable memory records', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const committed = commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ predicate: 'plan', value: 'Initial decision' }] }
		});
		const factItem = memory
			.listPatchItems(conv.id, { patchId: committed.patch.id })
			.find((item) => item.itemType === 'fact')!;

		const updated = memory.updateFact(conv.id, factItem.itemId, {
			value: 'Corrected decision'
		});
		expect(updated?.value).toBe('Corrected decision');
		expect(memory.deleteItem(conv.id, 'facts', factItem.itemId)).toBe(true);
		expect(memory.listFacts(conv.id)).toHaveLength(0);
	});

	it('updates global memories by id instead of upserting a body-selected key', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const first = memory.upsertGlobalMemory(user.id, {
			kind: 'preference',
			memoryKey: 'tone',
			value: 'noir'
		});
		const second = memory.upsertGlobalMemory(user.id, {
			kind: 'preference',
			memoryKey: 'pace',
			value: 'fast'
		});

		const response = (await patchMemoryItem(
			routeEvent(conv.id, user.id, 'globalMemories', first.id, {
				kind: 'preference',
				memoryKey: 'tone-updated',
				value: 'hopeful'
			})
		)) as Response;
		const body = (await response.json()) as { item: memory.GlobalMemory };

		expect(body.item.id).toBe(first.id);
		expect(body.item.memoryKey).toBe('tone-updated');
		expect(memory.listGlobalMemories(user.id, { status: 'active' }).map((row) => row.id)).toEqual(
			expect.arrayContaining([first.id, second.id])
		);
		expect(memory.searchGlobalMemories(user.id, { query: 'hopeful' })[0]?.itemId).toBe(first.id);
		await expect(
			patchMemoryItem(
				routeEvent(conv.id, user.id, 'globalMemories', first.id, {
					kind: 'preference',
					memoryKey: 'pace',
					value: 'conflict'
				})
			)
		).rejects.toMatchObject({ status: 409 });
	});

	it('rejects invalid editable memory payloads before persisting them', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const committed = commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ predicate: 'plan', value: 'Initial decision' }] }
		});
		const factItem = memory
			.listPatchItems(conv.id, { patchId: committed.patch.id })
			.find((item) => item.itemType === 'fact')!;

		await expect(
			patchMemoryItem(
				routeEvent(conv.id, user.id, 'facts', factItem.itemId, {
					status: 'invisible'
				})
			)
		).rejects.toMatchObject({ status: 400 });
		expect(memory.listFacts(conv.id)[0]?.status).toBe('active');
	});

	it('builds fresh-context prompts with durable memory and recent transcript', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		messages.append(conv.id, { role: 'user', content: 'Remember that Mara saw the blue candle.' });
		messages.append(conv.id, { role: 'assistant', content: 'Noted.' });
		const userMsg = messages.append(conv.id, { role: 'user', content: 'What did Mara see?' });

		const prompt = buildPromptWithMemory({
			conversationId: conv.id,
			mode: 'story',
			userMsg,
			includeRecentTranscript: true
		});

		expect(prompt).toContain('<portal_memory_mode>');
		expect(prompt).toContain('fresh model context');
		expect(prompt).toContain('Mara saw the blue candle');
		expect(prompt).toContain('What did Mara see?');
	});

	it('memory tools read and write without permission prompts', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const tools = buildMemoryTools({
			userId: user.id,
			conversationId: conv.id,
			mode: 'lightweight'
		});
		expect(tools.every((tool) => tool.permissionBehavior === 'never-prompt')).toBe(true);
		// The main model no longer has a direct write tool; durable writes are
		// owned by the extractor. Commit directly to seed searchable memory.
		commitPatch({
			conversationId: conv.id,
			mode: 'lightweight',
			patch: {
				facts: [
					{ entityKey: 'memory', predicate: 'policy', value: 'Tools are mandatory in the MVP.' }
				]
			}
		});

		const search = tools.find((tool) => tool.name === 'memory_search')!;
		const raw = await search.handler({ query: 'mandatory', limit: 5 });
		expect(toolText(raw)).toContain('Tools are mandatory');
	});

	it('recalls transcript, timeline, clues, character knowledge, and global memory via tools', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		messages.append(conv.id, { role: 'user', content: 'The blue candle was half burned.' });
		const committed = commitPatch({
			conversationId: conv.id,
			mode: 'strict',
			patch: {
				entities: [{ entityKey: 'character.elias', entityType: 'character', displayName: 'Elias' }],
				events: [
					{
						eventType: 'timeline',
						summary: 'Elias entered the study.',
						entityKey: 'character.elias'
					}
				],
				facts: [
					{ predicate: 'clue', value: { id: 'blue_candle', status: 'revealed' } },
					{
						predicate: 'knowledge:character.elias',
						entityKey: 'character.elias',
						value: 'Elias knows the candle was lit.'
					}
				],
				openLoops: [{ loopType: 'clue', title: 'Blue candle', description: 'Half burned candle.' }]
			}
		});
		expect(committed.patch.status).toBe('committed');

		const sessionOnlyTools = buildMemoryTools({
			userId: user.id,
			conversationId: conv.id,
			mode: 'strict'
		});
		expect(sessionOnlyTools.map((tool) => tool.name)).not.toContain('memory_global_remember');
		const tools = buildMemoryTools({
			userId: user.id,
			conversationId: conv.id,
			mode: 'strict',
			globalMemoryEnabled: true
		});
		const transcript = tools.find((tool) => tool.name === 'memory_transcript_lookup')!;
		const timeline = tools.find((tool) => tool.name === 'memory_query_timeline')!;
		const clues = tools.find((tool) => tool.name === 'memory_query_clues')!;
		const knowledge = tools.find((tool) => tool.name === 'memory_get_character_knowledge')!;
		const globalRemember = tools.find((tool) => tool.name === 'memory_global_remember')!;
		const globalSearch = tools.find((tool) => tool.name === 'memory_global_search')!;

		expect(toolText(await transcript.handler({ query: 'blue candle' }))).toContain('half burned');
		expect(toolText(await timeline.handler({ eventType: 'timeline' }))).toContain(
			'entered the study'
		);
		expect(toolText(await clues.handler({ status: 'all' }))).toContain('Blue candle');
		expect(toolText(await knowledge.handler({ characterEntityKey: 'character.elias' }))).toContain(
			'candle was lit'
		);
		await globalRemember.handler({
			kind: 'preference',
			key: 'story-tone',
			value: 'noir'
		});
		expect(toolText(await globalSearch.handler({ query: 'noir' }))).toContain('story-tone');
	});

	it('returns compact memory rows by default and full rows under verbose', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			mode: 'strict',
			patch: {
				entities: [{ entityKey: 'character.elias', entityType: 'character', displayName: 'Elias' }],
				events: [
					{
						eventType: 'timeline',
						summary: 'Elias entered the study.',
						entityKey: 'character.elias'
					}
				]
			}
		});
		const tools = buildMemoryTools({ userId: user.id, conversationId: conv.id, mode: 'strict' });
		const getEntity = tools.find((tool) => tool.name === 'memory_get_entity')!;

		const compact = toolData<{
			entity: Record<string, unknown>;
			events: Array<Record<string, unknown>>;
			_omitted?: string[];
		}>(await getEntity.handler({ id: 'character.elias' }));
		// Allowlisted fields survive; noisy provenance/timestamps are dropped.
		expect(compact.entity).toHaveProperty('displayName', 'Elias');
		expect(compact.entity).not.toHaveProperty('createdAt');
		expect(compact.entity).not.toHaveProperty('conversationId');
		expect(compact.events[0]).toHaveProperty('summary');
		expect(compact.events[0]).not.toHaveProperty('payload');
		// Passive marker lists dropped field names only when something was dropped.
		expect(Array.isArray(compact._omitted)).toBe(true);
		expect(compact._omitted).toContain('conversationId');
		expect(compact._omitted).not.toContain('summary');

		const verbose = toolData<{
			entity: Record<string, unknown>;
			_omitted?: string[];
		}>(await getEntity.handler({ id: 'character.elias', verbose: true }));
		// Verbose restores the full payload and omits the marker.
		expect(verbose.entity).toHaveProperty('createdAt');
		expect(verbose.entity).toHaveProperty('conversationId');
		expect(verbose._omitted).toBeUndefined();
	});

	it('does not check missing entity claims against unrelated predicate facts', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'study' }]
			}
		});
		const tools = buildMemoryTools({
			userId: user.id,
			conversationId: conv.id,
			mode: 'strict'
		});
		const checkClaims = tools.find((tool) => tool.name === 'memory_check_claims')!;

		const raw = await checkClaims.handler({
			claims: [{ entityKey: 'character.elias', predicate: 'location', value: 'study' }]
		});
		const parsed = toolData<{ results: Array<{ status: string; sources: unknown[] }> }>(raw);

		expect(parsed.results[0]?.status).toBe('unknown');
		expect(parsed.results[0]?.sources).toHaveLength(0);
	});

	it('extracts through the extractor service with auditable metadata', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Remember to investigate the locked attic later.'
		});
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'I will keep that as an open follow-up.'
		});

		const result = await extractAndCommitMemory({
			conversationId: conv.id,
			userId: user.id,
			mode: 'lightweight',
			turnId: 'turn-test',
			userMessage,
			assistantMessage
		});

		expect(result.extractorKind).toBe('heuristic');
		expect(result.patch.extractorKind).toBe('heuristic');
		expect(result.patch.extractorConfidence).toBeGreaterThan(0);
		expect(result.patch.validationResult).toMatchObject({
			extractor: { extractorKind: 'heuristic' }
		});
	});

	it('extracts model-backed memory with schema validation and secret filtering', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Remember that we chose append-only migrations.'
		});
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'Decision noted. token=abcdefghijklmnopqrstuvwxyz should not be stored.'
		});
		const extractor = new OpenAICompatibleMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'test-extractor',
			timeoutMs: 1_000,
			maxInputChars: 4_000,
			completeJson: async () => ({
				summary: 'Model extraction test.',
				confidence: 0.9,
				diagnostics: [{ severity: 'info', code: 'fixture', message: 'fixture model output' }],
				patch: {
					facts: [
						{
							kind: 'attribute',
							entityKey: 'migrations',
							predicate: 'decision',
							value: 'Use append-only migrations for schema changes.'
						},
						{
							kind: 'attribute',
							entityKey: 'secret',
							predicate: 'token',
							value: 'token=abcdefghijklmnopqrstuvwxyz'
						},
						{ kind: 'open_loop', loopType: 'project_task', title: 'Document migration decision' }
					]
				}
			})
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-test',
			userMessage,
			assistantMessage
		});
		const committed = commitPatch(
			{
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-test',
				sourceMessageId: assistantMessage.id,
				patch: extraction.patch,
				summary: extraction.summary
			},
			{
				extractorKind: extractor.kind,
				extractorModel: extractor.model,
				extractorConfidence: extraction.confidence,
				extractorDiagnostics: extraction.diagnostics
			}
		);

		expect(extraction.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			'sensitive_memory_items_removed'
		);
		expect(committed.patch.extractorKind).toBe('openai-compatible');
		expect(committed.patch.extractorModel).toBe('test-extractor');
		const migrationFacts = memory
			.listFacts(conv.id, { limit: 20 })
			.filter((fact) => fact.predicate === 'decision');
		expect(migrationFacts).toHaveLength(1);
		expect(String(migrationFacts[0]?.value)).toContain('append-only');
	});

	it('canonicalizes model-backed entity aliases while preserving granular facts', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		memory.upsertEntity(conv.id, {
			entityKey: 'character.mara',
			entityType: 'character',
			displayName: 'Mara'
		});
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content:
				'Mara, also called the Raven, is in the study, owns the brass key, and distrusts Elias.'
		});
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'I will remember those separate details about Mara.'
		});
		let prompt = '';
		const extractor = new OpenAICompatibleMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'test-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			completeJson: async (inputPrompt) => {
				prompt = inputPrompt;
				return {
					summary: 'Alias extraction test.',
					confidence: 0.9,
					patch: {
						entities: [
							{ entityKey: 'person.raven', entityType: 'character', displayName: 'Mara' },
							{ entityKey: 'character.the_raven', entityType: 'character', displayName: 'Mara' }
						],
						facts: [
							{
								kind: 'attribute',
								entityKey: 'person.raven',
								predicate: 'alias',
								value: 'the Raven'
							},
							{
								kind: 'attribute',
								entityKey: 'character.the_raven',
								predicate: 'location',
								value: 'study'
							},
							{ kind: 'attribute', entityKey: 'Mara', predicate: 'owns', value: 'brass key' },
							{
								kind: 'attribute',
								entityKey: 'person.raven',
								predicate: 'distrusts',
								value: 'Elias'
							}
						]
					}
				};
			}
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'story',
			turnId: 'turn-test',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'story')
		});
		commitPatch({
			conversationId: conv.id,
			mode: 'story',
			turnId: 'turn-test',
			sourceMessageId: assistantMessage.id,
			patch: extraction.patch,
			summary: extraction.summary
		});

		expect(prompt).toContain('Keep attributes granular');
		expect(prompt).toContain('Reuse an existing key from the initial packet');
		expect(extraction.patch.entities).toEqual([
			expect.objectContaining({ entityKey: 'character.mara' })
		]);
		expect(extraction.patch.facts?.map((fact) => fact.entityKey)).toEqual([
			'character.mara',
			'character.mara',
			'character.mara',
			'character.mara'
		]);
		expect(extraction.patch.facts).toHaveLength(4);
		expect(extraction.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining(['entity_keys_canonicalized', 'duplicate_entities_merged'])
		);
		expect(memory.listEntities(conv.id).map((entity) => entity.entityKey)).toEqual([
			'character.mara'
		]);
		expect(memory.listFacts(conv.id, { limit: 10 })).toHaveLength(4);
	});

	it('stores memory through the tool-calling extractor with per-call validation feedback', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Remember that we chose append-only migrations and that Mara owns the brass key.'
		});
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'Noted both of those.'
		});

		const seenToolNames: string[] = [];
		const feedback: unknown[] = [];
		let step = 0;
		const chatComplete = async (
			msgs: ExtractorChatMessage[],
			tools: ExtractorToolSpec[]
		): Promise<ExtractorAssistantTurn> => {
			for (const tool of tools) seenToolNames.push(tool.function.name);
			// Capture the tool-result feedback the agent receives mid-loop.
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				return {
					reasoning: 'Mara owns the brass key; migrations are append-only.',
					content: '<think>Let me record both facts.</think>Recording now.',
					toolCalls: [
						{
							id: 'call-1',
							name: 'remember_attributes',
							arguments: JSON.stringify({
								entityKey: 'character.mara',
								attributes: [{ predicate: 'owns', value: 'brass key' }]
							})
						}
					]
				};
			}
			return { content: 'Stored the migration decision and Mara key ownership.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 4,
			chatComplete
		});

		const activity: ExtractorActivity[] = [];
		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-tool',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project'),
			onActivity: (event) => activity.push(event)
		});

		// The background agent is offered both read tools and the durable-write tools.
		expect(seenToolNames).toContain('memory_search');
		expect(seenToolNames).toContain('remember_attributes');
		// Activity is surfaced so the extractor reads like a fully-featured
		// nested agent: a leading `input` event carries the context handed to
		// the extractor, then thoughts (reasoning + <think>) and spoken content
		// are separate threaded streams, interleaved with the staging tool call.
		expect(activity.map((event) => event.type)).toEqual([
			'input',
			'reasoning',
			'content',
			'reasoning.end',
			'tool.call',
			'tool.result',
			'content'
		]);
		const inputEvent = activity[0];
		expect(inputEvent).toMatchObject({ type: 'input' });
		if (inputEvent?.type === 'input') {
			expect(inputEvent.text.length).toBeGreaterThan(0);
		}
		const reasoning = activity.find((event) => event.type === 'reasoning');
		expect(reasoning).toMatchObject({ type: 'reasoning' });
		if (reasoning?.type === 'reasoning') {
			expect(reasoning.text).toContain('Mara owns the brass key');
			expect(reasoning.text).toContain('Let me record both facts.');
			// Visible (non-think) narration is NOT a thought — it streams as
			// separate threaded content.
			expect(reasoning.text).not.toContain('Recording now.');
			// The think tag must not leak into the surfaced thought text.
			expect(reasoning.text).not.toContain('<think>');
		}
		// Spoken content streams as threaded content blocks, interleaved with
		// the model's thoughts and tools.
		const contentText = activity
			.filter((event) => event.type === 'content')
			.map((event) => (event.type === 'content' ? event.text : ''))
			.join(' ');
		expect(contentText).toContain('Recording now.');
		expect(contentText).not.toContain('<think>');
		const activityCall = activity.find((event) => event.type === 'tool.call');
		const activityResult = activity.find((event) => event.type === 'tool.result');
		expect(activityCall).toMatchObject({ type: 'tool.call', tool: 'remember_attributes' });
		expect(activityResult).toMatchObject({ type: 'tool.result', ok: true });
		// The final spoken message is captured as the session response.
		expect(extraction.response).toBe('Stored the migration decision and Mara key ownership.');
		// It received validation feedback after staging.
		expect(feedback.some((entry) => String(entry).includes('"ok":true'))).toBe(true);
		expect(extraction.patch.facts).toEqual([
			expect.objectContaining({ entityKey: 'character.mara', predicate: 'owns' })
		]);
		expect(extraction.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
			'tool_calling_extractor'
		);

		const committed = commitPatch(
			{
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-tool',
				sourceMessageId: assistantMessage.id,
				patch: extraction.patch,
				summary: extraction.summary
			},
			{ extractorKind: extractor.kind, extractorModel: extractor.model }
		);
		expect(committed.patch.status).toBe('committed');
		expect(committed.patch.extractorKind).toBe('openai-compatible-tools');
		expect(memory.listFacts(conv.id, { limit: 10 })).toHaveLength(1);
	});

	it('stages across multiple per-kind tools and preserves staged totals through a rejection', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Mara owns the brass key. Keep replies short. Track a follow-up.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1)
				return writeCall('e1', 'remember_entity', {
					entityKey: 'character.mara',
					entityType: 'character',
					displayName: 'Mara'
				});
			if (step === 2)
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [{ predicate: 'owns', value: 'brass key' }]
				});
			if (step === 3) return writeCall('d1', 'remember_directive', { rule: 'Keep replies short.' });
			// A malformed event mid-stream must not drop the three already staged.
			if (step === 4) return writeCall('x1', 'remember_event', { summary: 'missing eventType' });
			if (step === 5)
				return writeCall('l1', 'remember_loop', { loopType: 'task', title: 'Follow up later' });
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 8,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-multi',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		// The rejection envelope echoes staged_totals proving prior work survived
		// (1 entity + 1 attribute + 1 directive already staged before the bad event).
		const rejection = feedback.find((entry) => entry.includes('"ok":false'));
		expect(rejection).toBeDefined();
		const parsedRejection = JSON.parse(rejection!);
		expect(parsedRejection.tool).toBe('remember_event');
		expect(parsedRejection.staged_totals).toMatchObject({ attributes: 1, directives: 1 });

		// All valid items across the different tools made it into the merged patch;
		// only the malformed event is missing.
		expect(extraction.patch.entities).toHaveLength(1);
		expect(extraction.patch.facts).toHaveLength(2); // attribute + directive
		expect(extraction.patch.openLoops).toHaveLength(1);
		expect(extraction.patch.events ?? []).toHaveLength(0);

		const committed = commitPatch(
			{
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-multi',
				sourceMessageId: assistantMessage.id,
				patch: extraction.patch,
				summary: extraction.summary
			},
			{ extractorKind: extractor.kind }
		);
		expect(committed.patch.status).toBe('committed');
		expect(memory.listOpenLoops(conv.id, { limit: 10 })).toHaveLength(1);
	});

	it('stages a paired event when a remember_attributes item carries an event summary', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Mara just picked up the brass key.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				// A state change that is also a notable occurrence: one item records
				// both the attribute and a paired timeline event.
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [
						{ predicate: 'owns', value: 'brass key', event: 'Mara picked up the brass key.' }
					]
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-paired',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		// The success envelope flags the pairing and counts both items.
		const ok = feedback.find((entry) => entry.includes('"ok":true'));
		expect(ok).toBeDefined();
		const parsedOk = JSON.parse(ok!);
		expect(parsedOk.pairedEvents).toBe(1);
		expect(parsedOk.staged_totals).toMatchObject({ attributes: 1, events: 1 });
		// `accepted` echoes the CANONICAL input: a hoisted entityKey plus flat
		// attribute items, with the paired event's defaulted `eventType: "change"`
		// surfaced (the normalized form the server consumed).
		expect(parsedOk.accepted).toEqual({
			entityKey: 'character.mara',
			attributes: [
				{
					predicate: 'owns',
					value: 'brass key',
					event: 'Mara picked up the brass key.',
					eventType: 'change'
				}
			]
		});

		// Both the attribute fact and the paired event landed in the patch, the
		// event defaulting to eventType "change" and inheriting the entityKey.
		expect(extraction.patch.facts).toEqual([
			expect.objectContaining({ entityKey: 'character.mara', predicate: 'owns' })
		]);
		expect(extraction.patch.events).toEqual([
			expect.objectContaining({
				eventType: 'change',
				summary: 'Mara picked up the brass key.',
				entityKey: 'character.mara'
			})
		]);
	});

	it('rejects a remember_attributes item with eventType but no event summary', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, { role: 'user', content: 'Cloak is red.' });
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'object.cloak',
					attributes: [{ predicate: 'color', value: 'red', eventType: 'change' }]
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-evttype',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const rejection = feedback.find((entry) => entry.includes('"ok":false'));
		expect(rejection).toBeDefined();
		const parsed = JSON.parse(rejection!);
		expect(parsed.issues[0].field).toBe('attributes.0.eventType');
		// The single bad item was not staged.
		expect(extraction.patch.facts ?? []).toHaveLength(0);
		expect(extraction.patch.events ?? []).toHaveLength(0);
	});

	it('nudges the model when it repeats the exact same write call within a turn', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Mara has red hair.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			// Re-read the full ordered tool transcript each step; after the run
			// `feedback` holds every tool result in call order (1, 2, 3).
			feedback.length = 0;
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			// The model loops: it stages the same attribute on the same entity
			// three times in a row (key order shuffled the third time to prove the
			// signature is order-independent) before finally stopping.
			if (step === 1 || step === 2) {
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [{ predicate: 'hair', value: 'red' }]
				});
			}
			if (step === 3) {
				return writeCall('a1', 'remember_attributes', {
					attributes: [{ value: 'red', predicate: 'hair' }],
					entityKey: 'character.mara'
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 6,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-dup',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const parsed = feedback.map((entry) => JSON.parse(entry));
		// First call is not flagged; the second and third (the repeats) are, with
		// an escalating repeatCount and a nudge folded into the note.
		expect(parsed[0].duplicate).toBeUndefined();
		expect(parsed[1].duplicate).toEqual({ repeatCount: 2 });
		expect(parsed[2].duplicate).toEqual({ repeatCount: 3 });
		expect(parsed[1].note).toContain('already made this exact remember_attributes call');
		// The nudge is purely advisory: the underlying writes still succeed (the
		// duplicate fragments stage and are deduped later at commit time).
		expect(parsed[1].ok).toBe(true);
		expect(extraction.patch.facts).toEqual([
			expect.objectContaining({ entityKey: 'character.mara', predicate: 'hair' }),
			expect.objectContaining({ entityKey: 'character.mara', predicate: 'hair' }),
			expect.objectContaining({ entityKey: 'character.mara', predicate: 'hair' })
		]);
	});

	it('skips attributes already stored unchanged and re-asserts changed ones', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });

		// Seed memory from a prior turn: Mara has red hair and is tall.
		commitPatch({
			conversationId: conv.id,
			mode: 'project',
			turnId: 'turn-seed',
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [
					{ entityKey: 'character.mara', predicate: 'hair', value: 'red' },
					{ entityKey: 'character.mara', predicate: 'build', value: 'tall' }
				]
			}
		});

		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Mara still has red hair, now wears a green cloak, and dyed it black.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			feedback.length = 0;
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [
						{ predicate: 'hair', value: 'red' }, // unchanged -> redundant skip
						{ predicate: 'hair', value: 'black' }, // changed -> supersedes, stages
						{ predicate: 'cloak', value: 'green' } // new -> stages
					]
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-redundant',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const parsed = JSON.parse(feedback[0]);
		// The unchanged hair=red item is flagged redundant; the changed and new
		// items stage normally.
		expect(parsed.results).toEqual([
			expect.objectContaining({ index: 0, staged: false, unchanged: true }),
			{ index: 1, staged: true },
			{ index: 2, staged: true }
		]);
		expect(parsed.unchanged).toBe(1);
		expect(parsed.note).toContain('already stored unchanged');

		// Only the changed + new attributes reach the patch; the unchanged
		// re-assertion was dropped rather than staged.
		expect(extraction.patch.facts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ entityKey: 'character.mara', predicate: 'hair', value: 'black' }),
				expect.objectContaining({ entityKey: 'character.mara', predicate: 'cloak', value: 'green' })
			])
		);
		expect(extraction.patch.facts).toHaveLength(2);

		// Telemetry: the redundant skip is surfaced as a diagnostic.
		expect(extraction.diagnostics.map((d) => d.code)).toContain('redundant_rewrite');
	});

	it('returns clear already-stored feedback when every attribute is unchanged', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });

		commitPatch({
			conversationId: conv.id,
			mode: 'project',
			turnId: 'turn-seed',
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [{ entityKey: 'character.mara', predicate: 'hair', value: 'red' }]
			}
		});

		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Mara has red hair.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			feedback.length = 0;
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [{ predicate: 'hair', value: 'red' }]
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-all-redundant',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const parsed = JSON.parse(feedback[0]);
		// ok:true but a clear "nothing new" note rather than a plain success, and
		// nothing staged.
		expect(parsed.ok).toBe(true);
		expect(parsed.unchanged).toBe(1);
		expect(parsed.note).toContain('already stored with that exact value');
		expect(parsed.accepted.attributes).toEqual([]);
		expect(extraction.patch.facts ?? []).toHaveLength(0);
	});

	it('does not skip a per-item entityKey override against the hoisted key signature', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });

		// Mara has hair=red stored; Bob exists but has no hair fact yet.
		commitPatch({
			conversationId: conv.id,
			mode: 'project',
			turnId: 'turn-seed',
			patch: {
				entities: [
					{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' },
					{ entityKey: 'character.bob', entityType: 'character', displayName: 'Bob' }
				],
				facts: [{ entityKey: 'character.mara', predicate: 'hair', value: 'red' }]
			}
		});

		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Bob also has red hair.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			feedback.length = 0;
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				// Hoisted key is Mara, but the item overrides it to Bob. The
				// signature must be computed against Bob (no stored hair=red), not
				// Mara (which has one) — otherwise this genuinely-new fact is lost.
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [{ entityKey: 'character.bob', predicate: 'hair', value: 'red' }]
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-per-item-key',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const parsed = JSON.parse(feedback[0]);
		// The Bob fact stages — it is not falsely deduped against Mara's hair=red.
		expect(parsed.results).toEqual([{ index: 0, staged: true }]);
		expect(parsed.unchanged).toBeUndefined();
		expect(extraction.patch.facts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ entityKey: 'character.bob', predicate: 'hair', value: 'red' })
			])
		);
	});

	it('re-stages an unchanged value when only its visibility changes', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });

		// Seed a fact at the default 'session' visibility.
		commitPatch({
			conversationId: conv.id,
			mode: 'project',
			turnId: 'turn-seed',
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [{ entityKey: 'character.mara', predicate: 'secret_word', value: 'rosebud' }]
			}
		});

		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: "Mara's secret word rosebud must stay hidden."
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			feedback.length = 0;
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				// Same predicate+value, but promoted to hidden visibility — a real
				// change that must NOT be skipped as redundant.
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [{ predicate: 'secret_word', value: 'rosebud', visibility: 'hidden' }]
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-visibility-change',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const parsed = JSON.parse(feedback[0]);
		// The visibility change stages — it is not falsely deduped against the
		// stored session-visibility fact.
		expect(parsed.results).toEqual([{ index: 0, staged: true }]);
		expect(parsed.unchanged).toBeUndefined();
		expect(extraction.patch.facts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					entityKey: 'character.mara',
					predicate: 'secret_word',
					value: 'rosebud',
					visibility: 'hidden'
				})
			])
		);
	});

	it('stages granular attributes in one batch and partially accepts on a bad item', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Mara is a tall woman with red hair who fears deep water.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				// Granular decomposition in ONE call, with one malformed item (no
				// value) that must not sink the valid siblings.
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [
						{ predicate: 'build', value: 'tall' },
						{ predicate: 'hair', value: 'red' },
						{ predicate: 'fears' }, // missing value -> item rejected
						{ predicate: 'gender', value: 'woman' }
					]
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-batch',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		// Partial acceptance: the three valid traits stage; only the bad item is
		// reported, by its index, with the rest preserved.
		const rejection = feedback.find((entry) => entry.includes('"ok":false'));
		expect(rejection).toBeDefined();
		const parsed = JSON.parse(rejection!);
		expect(parsed.error.code).toBe('batch_partial');
		expect(parsed.staged_totals.attributes).toBe(3);
		expect(parsed.results).toEqual([
			{ index: 0, staged: true },
			{ index: 1, staged: true },
			expect.objectContaining({ index: 2, staged: false }),
			{ index: 3, staged: true }
		]);
		expect(parsed.issues[0].field).toBe('attributes.2.value');
		// The note steers the model to re-send only the failed item.
		expect(parsed.note).toMatch(/only those items/i);

		// The three valid traits are in the patch as separate granular facts.
		expect(extraction.patch.facts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ entityKey: 'character.mara', predicate: 'build', value: 'tall' }),
				expect.objectContaining({ entityKey: 'character.mara', predicate: 'hair', value: 'red' }),
				expect.objectContaining({
					entityKey: 'character.mara',
					predicate: 'gender',
					value: 'woman'
				})
			])
		);
		expect(extraction.patch.facts).toHaveLength(3);
	});

	it('echoes accepted as clean input-shaped items for a multi-attribute batch', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Mara is tall, red-haired, and wary of water.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				return writeCall('a1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [
						{ predicate: 'build', value: 'tall' },
						{ predicate: 'hair', value: 'red' },
						{ predicate: 'fears', value: 'deep water', confidence: 0.8 }
					]
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-accepted-echo',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const ok = feedback.find((entry) => entry.includes('"ok":true'));
		expect(ok).toBeDefined();
		const parsed = JSON.parse(ok!);
		// `accepted` must be a clean echo: a single hoisted entityKey plus the flat
		// input items — NOT an array of internal { facts: [...] } patch fragments,
		// and never the entityKey duplicated into every item.
		expect(parsed.accepted).toEqual({
			entityKey: 'character.mara',
			attributes: [
				{ predicate: 'build', value: 'tall' },
				{ predicate: 'hair', value: 'red' },
				{ predicate: 'fears', value: 'deep water', confidence: 0.8 }
			]
		});
		// Guard against regression to the leaky shape.
		expect(parsed.accepted.attributes[0]).not.toHaveProperty('facts');
		expect(parsed.accepted.attributes[0]).not.toHaveProperty('entityKey');
	});

	it('echoes accepted as a clean input echo for every single-item write tool', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		// Seed an open loop so close_loop has a real handle to retire.
		const priorAssistant = messages.append(conv.id, {
			role: 'assistant',
			content: 'You could search the attic.'
		});
		commitPatch({
			conversationId: conv.id,
			sourceMessageId: priorAssistant.id,
			patch: { openLoops: [{ loopType: 'task', title: 'Search the attic' }] }
		});
		const loop = memory.listOpenLoops(conv.id)[0];

		const userMessage = messages.append(conv.id, { role: 'user', content: 'Lots happened.' });
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		// Each tool's exact input args; `accepted` must echo these verbatim — no
		// internal { facts: [...] } / { entities: [...] } wrappers, single-item
		// arrays, or renamed fields (e.g. directive's rule -> predicate/value).
		const inputs: Record<string, Record<string, unknown>> = {
			remember_entity: {
				entityKey: 'character.mara',
				entityType: 'character',
				displayName: 'Mara'
			},
			remember_directive: { rule: 'Keep replies under 200 words.' },
			remember_event: { eventType: 'deploy', summary: 'Shipped v1.2.' },
			remember_loop: { loopType: 'task', title: 'Draft the changelog' },
			close_loop: { handle: loop.id, status: 'resolved' }
		};
		const order = Object.keys(inputs);

		const byTool: Record<string, unknown> = {};
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) {
				if (msg.role !== 'tool' || !msg.content) continue;
				try {
					const parsed = JSON.parse(msg.content) as { ok?: boolean; tool?: string };
					if (parsed.ok && parsed.tool) byTool[parsed.tool] = parsed;
				} catch {
					/* ignore non-JSON */
				}
			}
			if (step < order.length) {
				const tool = order[step];
				step += 1;
				return writeCall(`c${step}`, tool, inputs[tool]);
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 10,
			chatComplete
		});

		await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-accepted-all',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		for (const tool of order) {
			const envelope = byTool[tool] as { accepted?: unknown } | undefined;
			expect(envelope, `${tool} should have produced a success envelope`).toBeDefined();
			// Clean echo: deep-equals the exact input the model sent.
			expect(envelope!.accepted, `${tool} accepted should echo its input`).toEqual(inputs[tool]);
		}
	});

	it('echoes accepted as the canonical (normalized) input, not the raw input', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, { role: 'user', content: 'Keep it short.' });
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				// Raw input has surrounding whitespace (the directive schema trims)
				// and an unknown extra field (the schema drops it).
				return writeCall('d1', 'remember_directive', {
					rule: '   Keep replies short.   ',
					bogus: 'should be dropped'
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-canonical',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const ok = feedback.find((entry) => entry.includes('"ok":true'));
		expect(ok).toBeDefined();
		const parsed = JSON.parse(ok!);
		// Canonical: trimmed rule, no unknown `bogus` key — what the server
		// consumed, not the raw input.
		expect(parsed.accepted).toEqual({ rule: 'Keep replies short.' });
		// `received` still shows the raw input for contrast (not asserted on the
		// success path, but the canonical form must differ from the raw one).
		expect(parsed.accepted.rule).not.toContain('  ');
		expect(parsed.accepted).not.toHaveProperty('bogus');
	});

	it('does not stage rejected proposals, so a correction replaces rather than duplicates', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Track a follow-up to inspect the cellar.'
		});
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'Noted.'
		});

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				// First attempt: an open loop with a too-short title -> error.
				return writeCall('c1', 'remember_loop', { loopType: 'task', title: 'go' });
			}
			if (step === 2) {
				// Correction: a valid title for the same loop.
				return writeCall('c2', 'remember_loop', { loopType: 'task', title: 'Inspect the cellar' });
			}
			return { content: 'Stored one follow-up.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-correct',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		// The first (invalid) proposal was rejected, not staged; only the
		// corrected one survives, so there is exactly one open loop.
		expect(feedback.some((entry) => entry.includes('"ok":false'))).toBe(true);
		expect(extraction.patch.openLoops).toEqual([
			expect.objectContaining({ title: 'Inspect the cellar' })
		]);

		commitPatch(
			{
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-correct',
				sourceMessageId: assistantMessage.id,
				patch: extraction.patch,
				summary: extraction.summary
			},
			{ extractorKind: extractor.kind }
		);
		expect(memory.listOpenLoops(conv.id, { limit: 10 })).toHaveLength(1);
	});

	it('returns a targeted per-tool error when a write tool gets invalid args', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'The cloak is red.'
		});
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'Noted.'
		});

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				// remember_attributes item missing its required `value` -> schema failure.
				return writeCall('c1', 'remember_attributes', {
					entityKey: 'object.cloak',
					attributes: [{ predicate: 'color' }]
				});
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-schema',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const rejection = feedback.find((entry) => entry.includes('"ok":false'));
		expect(rejection).toBeDefined();
		const parsed = JSON.parse(rejection!);
		expect(parsed.ok).toBe(false);
		expect(parsed.tool).toBe('remember_attributes');
		expect(parsed.error.kind).toBe('validation');
		// The error is scoped to THIS tool and the offending item index: the field
		// path, a hint, and only this tool's flat schema + example.
		expect(parsed.issues[0].field).toBe('attributes.0.value');
		expect(typeof parsed.issues[0].hint).toBe('string');
		expect(parsed.expected.schema.properties.attributes).toBeDefined();
		expect(parsed.expected.schema.properties.kind).toBeUndefined();
		expect(parsed.expected.example.attributes).toBeDefined();
		// Nothing already staged was lost — the totals are echoed back.
		expect(parsed.staged_totals).toBeDefined();
		expect(typeof parsed.note).toBe('string');
	});

	it('reports an execution error when close_loop targets an unknown handle', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, { role: 'user', content: 'Done with that.' });
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				return writeCall('c1', 'close_loop', { handle: 'loop.does_not_exist', status: 'resolved' });
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-close-unknown',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		const rejection = feedback.find((entry) => entry.includes('"ok":false'));
		expect(rejection).toBeDefined();
		const parsed = JSON.parse(rejection!);
		expect(parsed.tool).toBe('close_loop');
		// Unknown handle is an execution error (retrying the same args won't help),
		// not a schema error — the hint redirects to memory_get_open_loops.
		expect(parsed.error.kind).toBe('execution');
		expect(parsed.error.code).toBe('unknown_loop');
		expect(parsed.issues[0].hint).toMatch(/memory_get_open_loops/);
		// The bad close was not staged.
		expect(extraction.patch.resolveOpenLoops ?? []).toHaveLength(0);
	});

	it('stages open-loop resolutions through the tool extractor and prunes on commit', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		// Prior turn: the assistant offered two options, recorded as open loops
		// linked to that turn's assistant message (mirroring production, where
		// earlier-turn loops are ancestors of the current turn's memory head).
		const priorUserMessage = messages.append(conv.id, {
			role: 'user',
			content: 'What should I do?'
		});
		const priorAssistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'You could open the door or stay hidden.'
		});
		commitPatch({
			conversationId: conv.id,
			sourceMessageId: priorAssistantMessage.id,
			patch: {
				openLoops: [
					{ loopType: 'choice', title: 'Option A: open the door' },
					{ loopType: 'choice', title: 'Option B: stay hidden' }
				]
			}
		});
		void priorUserMessage;
		const seeded = memory.listOpenLoops(conv.id);
		const keep = seeded.find((l) => l.title.includes('Option A'))!;
		const drop = seeded.find((l) => l.title.includes('Option B'))!;

		const userMessage = messages.append(conv.id, { role: 'user', content: 'I open the door.' });
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'The door creaks open.'
		});

		let step = 0;
		const chatComplete = async (): Promise<ExtractorAssistantTurn> => {
			step += 1;
			if (step === 1) {
				return writeCall('c1', 'close_loop', {
					handle: keep.id,
					status: 'resolved',
					reason: 'Chosen.'
				});
			}
			if (step === 2) {
				return writeCall('c2', 'close_loop', { handle: drop.id, status: 'dropped' });
			}
			return { content: 'Pruned the unchosen option.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 4,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'story',
			turnId: 'turn-prune',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'story')
		});

		expect(extraction.patch.resolveOpenLoops).toHaveLength(2);

		const committed = commitPatch(
			{
				conversationId: conv.id,
				mode: 'story',
				turnId: 'turn-prune',
				sourceMessageId: assistantMessage.id,
				patch: extraction.patch,
				summary: extraction.summary
			},
			{ extractorKind: extractor.kind }
		);

		expect(committed.counts.resolvedOpenLoops).toBe(2);
		expect(memory.listOpenLoops(conv.id)).toHaveLength(0);
		expect(memory.getOpenLoop(conv.id, keep.id)?.status).toBe('resolved');
		expect(memory.getOpenLoop(conv.id, drop.id)?.status).toBe('dropped');
	});

	it('strips a secret-bearing resolution reason but still prunes the loop', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		// Seed the loop on a prior assistant-message branch so the resolution's
		// projection (rebuilt from a descendant message head) still sees it,
		// mirroring production where earlier-turn loops are ancestors.
		const priorAssistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'I should rotate the API key.'
		});
		commitPatch({
			conversationId: conv.id,
			sourceMessageId: priorAssistantMessage.id,
			patch: { openLoops: [{ loopType: 'task', title: 'Rotate the API key' }] }
		});
		const loop = memory.listOpenLoops(conv.id)[0];

		const userMessage = messages.append(conv.id, { role: 'user', content: 'Rotated it.' });
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Done.' });

		let step = 0;
		const chatComplete = async (): Promise<ExtractorAssistantTurn> => {
			step += 1;
			if (step === 1) {
				return writeCall('c1', 'close_loop', {
					handle: loop.id,
					status: 'resolved',
					reason: 'Replaced key sk_live_0123456789abcdefghij in the vault.'
				});
			}
			return { content: 'Pruned the loop.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 4,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-secret',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		// The resolution survives (so the loop is still pruned) but the
		// secret-bearing reason is stripped.
		expect(extraction.patch.resolveOpenLoops).toHaveLength(1);
		expect(extraction.patch.resolveOpenLoops?.[0]).toEqual({ id: loop.id, status: 'resolved' });

		const committed = commitPatch(
			{
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-secret',
				sourceMessageId: assistantMessage.id,
				patch: extraction.patch,
				summary: extraction.summary
			},
			{ extractorKind: extractor.kind }
		);
		expect(committed.counts.resolvedOpenLoops).toBe(1);
		const resolved = memory.getOpenLoop(conv.id, loop.id);
		expect(resolved?.status).toBe('resolved');
		expect(resolved?.description ?? '').not.toContain('sk_live_');
	});

	it('unions keepOpenLoops across multiple staged proposals when collapsing', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [
					{ loopType: 'task', title: 'Thread one' },
					{ loopType: 'task', title: 'Thread two' }
				]
			}
		});
		const loops = memory.listOpenLoops(conv.id);
		const first = loops.find((l) => l.title.includes('one'))!;
		const second = loops.find((l) => l.title.includes('two'))!;

		// The agent reaffirms each live loop in a SEPARATE keep_loops call. Neither
		// call alone is the complete keep-set; the collapse must union them, or a
		// loop kept early would be aged out.
		let step = 0;
		const chatComplete = async (): Promise<ExtractorAssistantTurn> => {
			step += 1;
			if (step === 1) {
				return writeCall('c1', 'keep_loops', { handles: [first.id] });
			}
			if (step === 2) {
				return writeCall('c2', 'keep_loops', { handles: [second.id] });
			}
			return { content: 'Kept both threads.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-keep-union',
			userMessage: messages.append(conv.id, { role: 'user', content: 'Both still matter.' }),
			assistantMessage: messages.append(conv.id, { role: 'assistant', content: 'Understood.' }),
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		expect([...(extraction.patch.keepOpenLoops ?? [])].sort()).toEqual(
			[first.id, second.id].sort()
		);
	});

	it('keeps known handles but reports unknown ones in a keep_loops batch', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: { openLoops: [{ loopType: 'task', title: 'Live thread' }] }
		});
		const live = memory.listOpenLoops(conv.id)[0];

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				// One real handle plus one hallucinated handle in the same batch.
				return writeCall('c1', 'keep_loops', { handles: [live.id, 'loop.bogus'] });
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-keep-partial',
			userMessage: messages.append(conv.id, { role: 'user', content: 'Still relevant.' }),
			assistantMessage: messages.append(conv.id, { role: 'assistant', content: 'Noted.' }),
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		// Partial acceptance: the known handle is kept; the unknown one is an
		// execution error reported per-handle in results[].
		const rejection = feedback.find((entry) => entry.includes('"ok":false'));
		expect(rejection).toBeDefined();
		const parsed = JSON.parse(rejection!);
		expect(parsed.tool).toBe('keep_loops');
		expect(parsed.error.kind).toBe('execution');
		expect(parsed.error.code).toBe('unknown_handles');
		expect(parsed.results).toEqual([
			{ handle: live.id, kept: true },
			expect.objectContaining({ handle: 'loop.bogus', kept: false })
		]);
		// The real handle still made it into the kept set despite the bad sibling.
		expect(extraction.patch.keepOpenLoops).toEqual([live.id]);
	});

	it('forgets the original compound attribute after splitting it into granular facts', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		// Seed on a prior assistant-message branch so the post-turn projection
		// (rebuilt from the current descendant head) still sees the original fact.
		const priorAssistant = messages.append(conv.id, {
			role: 'assistant',
			content: 'Mara is a tall woman with red hair who fears deep water.'
		});
		commitPatch({
			conversationId: conv.id,
			sourceMessageId: priorAssistant.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [
					{
						entityKey: 'character.mara',
						predicate: 'description',
						value: 'a tall woman with red hair who fears deep water'
					}
				]
			}
		});
		const original = memory.listFacts(conv.id, { predicate: 'description' })[0];
		expect(original.status).toBe('active');

		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Mara is tall, red-haired, and fears deep water.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				return writeCall('c1', 'remember_attributes', {
					entityKey: 'character.mara',
					attributes: [
						{ predicate: 'build', value: 'tall' },
						{ predicate: 'hair', value: 'red' },
						{ predicate: 'fears', value: 'deep water' }
					]
				});
			}
			if (step === 2) {
				// The granular predicates are NEW, so nothing superseded the original
				// "description"; forget it directly (by entityKey+predicate).
				return writeCall('c2', 'forget_attribute', {
					entityKey: 'character.mara',
					predicate: 'description'
				});
			}
			return { content: 'Split the description into granular traits.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-split',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		// The forget call succeeded and staged the target.
		const ok = feedback.find(
			(entry) => entry.includes('"forget_attribute"') && entry.includes('"ok":true')
		);
		expect(ok).toBeDefined();
		expect(extraction.patch.forgetFacts).toEqual([
			{ entityKey: 'character.mara', predicate: 'description' }
		]);

		const committed = commitPatch(
			{
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-split',
				sourceMessageId: assistantMessage.id,
				patch: extraction.patch,
				summary: extraction.summary
			},
			{ extractorKind: extractor.kind }
		);
		expect(committed.counts.forgottenFacts).toBe(1);

		// The compound is tombstoned; the granular traits replace it.
		expect(memory.getFact(conv.id, original.id)?.status).toBe('deleted');
		const active = memory
			.listFacts(conv.id, { entityId: original.entityId!, limit: 50 })
			.map((fact) => fact.predicate)
			.sort();
		expect(active).toEqual(['build', 'fears', 'hair']);
	});

	it('forgets an explicitly retracted attribute by handle and restores it on revert', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const priorAssistant = messages.append(conv.id, {
			role: 'assistant',
			content: 'The box contains a brass key.'
		});
		commitPatch({
			conversationId: conv.id,
			sourceMessageId: priorAssistant.id,
			patch: {
				entities: [{ entityKey: 'object.box', entityType: 'object', displayName: 'Box' }],
				facts: [{ entityKey: 'object.box', predicate: 'contents', value: 'a brass key' }]
			}
		});
		const fact = memory.listFacts(conv.id, { predicate: 'contents' })[0];

		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Actually the box is empty now — forget what was in it.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		let step = 0;
		const chatComplete = async (): Promise<ExtractorAssistantTurn> => {
			step += 1;
			if (step === 1) {
				return writeCall('c1', 'forget_attribute', { handle: fact.id });
			}
			return { content: 'Removed the retracted attribute.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-retract-attr',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});
		expect(extraction.patch.forgetFacts).toEqual([{ factId: fact.id }]);

		const committed = commitPatch(
			{
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-retract-attr',
				sourceMessageId: assistantMessage.id,
				patch: extraction.patch,
				summary: extraction.summary
			},
			{ extractorKind: extractor.kind }
		);
		expect(committed.counts.forgottenFacts).toBe(1);
		expect(memory.getFact(conv.id, fact.id)?.status).toBe('deleted');

		// Reverting the patch restores the tombstoned fact to active.
		const result = memory.revertPatch(conv.id, committed.patch.id);
		expect(result.reverted).toBe(1);
		expect(memory.getFact(conv.id, fact.id)?.status).toBe('active');
	});

	it('forgets an explicitly retracted directive by handle', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const priorAssistant = messages.append(conv.id, {
			role: 'assistant',
			content: 'I will always greet you by name.'
		});
		commitPatch({
			conversationId: conv.id,
			sourceMessageId: priorAssistant.id,
			patch: { facts: [{ predicate: 'directive', value: 'Always greet the user by name.' }] }
		});
		const directive = memory.listFacts(conv.id, { predicate: 'directive' })[0];
		expect(directive.status).toBe('active');

		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Stop greeting me by name — drop that rule entirely.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Okay.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				// Wrong tool: forget_attribute must refuse a directive handle.
				return writeCall('c1', 'forget_attribute', { handle: directive.id });
			}
			if (step === 2) {
				return writeCall('c2', 'forget_directive', { handle: directive.id });
			}
			return { content: 'Retired the directive.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-retract-directive',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		// forget_attribute refused the directive and redirected to forget_directive.
		const refusal = feedback.find(
			(entry) => entry.includes('"forget_attribute"') && entry.includes('"ok":false')
		);
		expect(refusal).toBeDefined();
		expect(JSON.parse(refusal!).error.code).toBe('is_directive');
		// Only the forget_directive target was staged.
		expect(extraction.patch.forgetFacts).toEqual([{ factId: directive.id }]);

		const committed = commitPatch(
			{
				conversationId: conv.id,
				mode: 'project',
				turnId: 'turn-retract-directive',
				sourceMessageId: assistantMessage.id,
				patch: extraction.patch,
				summary: extraction.summary
			},
			{ extractorKind: extractor.kind }
		);
		expect(committed.counts.forgottenFacts).toBe(1);
		expect(memory.getFact(conv.id, directive.id)?.status).toBe('deleted');
	});

	it('rejects a forget_attribute whose target does not resolve to an active fact', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, { role: 'user', content: 'Forget that.' });
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const feedback: string[] = [];
		let step = 0;
		const chatComplete = async (msgs: ExtractorChatMessage[]): Promise<ExtractorAssistantTurn> => {
			for (const msg of msgs) if (msg.role === 'tool' && msg.content) feedback.push(msg.content);
			step += 1;
			if (step === 1) {
				return writeCall('c1', 'forget_attribute', { handle: 'fact.does_not_exist' });
			}
			return { content: 'Done.', toolCalls: [] };
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-forget-unknown',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project')
		});

		// Unresolved target is an execution error with a hint — never a silent no-op.
		const rejection = feedback.find((entry) => entry.includes('"ok":false'));
		expect(rejection).toBeDefined();
		const parsed = JSON.parse(rejection!);
		expect(parsed.tool).toBe('forget_attribute');
		expect(parsed.error.kind).toBe('execution');
		expect(parsed.error.code).toBe('unknown_fact');
		expect(typeof parsed.issues[0].hint).toBe('string');
		// Nothing was staged.
		expect(extraction.patch.forgetFacts ?? []).toHaveLength(0);
	});

	it('flags an unresolved forget target as a blocking diagnostic on commit', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const validation = validatePatch(
			{ forgetFacts: [{ factId: 'fact.nope' }] },
			{ conversationId: conv.id, mode: 'project' }
		);
		expect(validation.ok).toBe(false);
		expect(validation.issues.some((i) => i.code === 'forget_target_unresolved')).toBe(true);

		const committed = commitPatch({
			conversationId: conv.id,
			mode: 'project',
			patch: { forgetFacts: [{ factId: 'fact.nope' }] }
		});
		// The bad target blocks the commit (needs_review) and tombstones nothing.
		expect(committed.patch.status).toBe('needs_review');
		expect(committed.counts.forgottenFacts).toBe(0);
	});

	it('prefers supersede for a same-predicate update (no forget needed)', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'object.door', entityType: 'object', displayName: 'Door' }],
				facts: [{ entityKey: 'object.door', predicate: 'status', value: 'closed' }]
			}
		});
		const first = memory.listFacts(conv.id, { predicate: 'status' })[0];

		// Re-asserting the SAME entityKey+predicate with a new value supersedes the
		// prior automatically — no forget required.
		commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ entityKey: 'object.door', predicate: 'status', value: 'open' }] }
		});
		expect(memory.getFact(conv.id, first.id)?.status).toBe('superseded');
		const active = memory.listFacts(conv.id, { predicate: 'status' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('open');
	});

	it('does not forget a fact the same patch re-asserts (supersede wins over a redundant forget)', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'object.lamp', entityType: 'object', displayName: 'Lamp' }],
				facts: [{ entityKey: 'object.lamp', predicate: 'state', value: 'off' }]
			}
		});
		const original = memory.listFacts(conv.id, { predicate: 'state' })[0];

		// A self-contradictory patch: re-assert state=on (supersede) AND forget the
		// same entityKey+predicate. Without the guard, commit would re-resolve the
		// forget to the freshly-superseding fact and tombstone it, dropping the
		// predicate entirely. The guard skips that forget so supersede wins.
		const committed = commitPatch({
			conversationId: conv.id,
			patch: {
				facts: [{ entityKey: 'object.lamp', predicate: 'state', value: 'on' }],
				forgetFacts: [{ entityKey: 'object.lamp', predicate: 'state' }]
			}
		});
		expect(committed.counts.forgottenFacts).toBe(0);
		expect(memory.getFact(conv.id, original.id)?.status).toBe('superseded');
		const active = memory.listFacts(conv.id, { predicate: 'state' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('on');
	});

	it('restores a forgotten fact on revert and re-consolidates against a later supersede', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'object.safe', entityType: 'object', displayName: 'Safe' }],
				// `status` is a single-valued predicate, so only one value is ever
				// active — the case where restoring a stale fact could collide.
				facts: [{ entityKey: 'object.safe', predicate: 'status', value: 'locked' }]
			}
		});
		const original = memory.listFacts(conv.id, { predicate: 'status' })[0];

		// Forget the attribute outright.
		const forgetCommit = commitPatch({
			conversationId: conv.id,
			patch: { forgetFacts: [{ factId: original.id }] }
		});
		expect(forgetCommit.counts.forgottenFacts).toBe(1);
		expect(memory.getFact(conv.id, original.id)?.status).toBe('deleted');

		// A LATER patch re-asserts the same single-valued predicate with a fresh
		// value, becoming the lone active fact.
		commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ entityKey: 'object.safe', predicate: 'status', value: 'open' }] }
		});
		const replacement = memory.listFacts(conv.id, { predicate: 'status' })[0];
		expect(replacement.value).toBe('open');
		expect(replacement.id).not.toBe(original.id);

		// Reverting the forget restores the old fact; consolidation (run inside
		// updateFact) re-derives the single-valued group so exactly one fact stays
		// active — the newer value wins and the restored one settles to superseded
		// rather than producing two simultaneously-active values.
		const result = memory.revertPatch(conv.id, forgetCommit.patch.id);
		expect(result.reverted).toBe(1);
		const active = memory.listFacts(conv.id, { predicate: 'status', status: 'active' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('open');
		// The restored fact is out of the 'deleted' tombstone state (superseded by
		// the newer value), never left dangling as a second active fact.
		expect(memory.getFact(conv.id, original.id)?.status).toBe('superseded');
	});

	it('aborts the tool-calling extractor between iterations when its signal fires', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, { role: 'user', content: 'Open the door.' });
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'The door opens.'
		});

		const controller = new AbortController();
		let calls = 0;
		const chatComplete = async (
			_messages: ExtractorChatMessage[],
			_tools: ExtractorToolSpec[],
			_onDelta?: unknown,
			signal?: AbortSignal
		): Promise<ExtractorAssistantTurn> => {
			calls += 1;
			// The signal must be threaded all the way down to the chat call.
			expect(signal).toBe(controller.signal);
			// First step stages a proposal and keeps the loop going; the user
			// hits "stop" before the next round-trip starts.
			controller.abort();
			return {
				content: '',
				toolCalls: [
					{
						id: `c${calls}`,
						name: 'remember_attributes',
						arguments: JSON.stringify({
							entityKey: 'object.door',
							attributes: [{ predicate: 'state', value: 'open' }]
						})
					}
				]
			};
		};

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 1_000,
			maxInputChars: 8_000,
			maxToolIterations: 5,
			chatComplete
		});

		await expect(
			extractor.extractPatch({
				conversationId: conv.id,
				userId: user.id,
				mode: 'project',
				turnId: 'turn-abort',
				userMessage,
				assistantMessage,
				initialPacket: buildInitialPacket(conv.id, 'project'),
				signal: controller.signal
			})
		).rejects.toMatchObject({ name: 'AbortError' });

		// The loop tore down at the post-tool-call abort check rather than
		// running the full maxToolIterations rounds.
		expect(calls).toBe(1);
	});

	it('streams reasoning and content token-by-token over SSE, stripping split think tags', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Remember we chose append-only migrations.'
		});
		const assistantMessage = messages.append(conv.id, { role: 'assistant', content: 'Noted.' });

		const sse = (chunks: unknown[]): Response => {
			const text =
				chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
			return new Response(text, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' }
			});
		};

		// Step 1: reasoning streamed in two deltas; a <think> tag split across
		// two content deltas; tool-call arguments split across two deltas.
		// Step 2: a final spoken message with no tool calls ends the loop.
		const responses = [
			sse([
				{ choices: [{ delta: { reasoning: 'Mara owns ' } }] },
				{ choices: [{ delta: { reasoning: 'the key.' } }] },
				{ choices: [{ delta: { content: '<thi' } }] },
				{ choices: [{ delta: { content: 'nk>internal plan</think>' } }] },
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: 'c1',
										function: { name: 'remember_attributes', arguments: '{"entityKey":"mig' }
									}
								]
							}
						}
					]
				},
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										function: {
											arguments:
												'rations","attributes":[{"predicate":"decision","value":"append-only"}]}'
										}
									}
								]
							}
						}
					]
				}
			]),
			sse([{ choices: [{ delta: { content: 'Stored the migration decision.' } }] }])
		];
		let call = 0;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => responses[Math.min(call++, responses.length - 1)])
		);

		const extractor = new ToolCallingMemoryExtractor({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'tool-extractor',
			timeoutMs: 2_000,
			maxInputChars: 8_000,
			maxToolIterations: 4
		});

		const activity: ExtractorActivity[] = [];
		const extraction = await extractor.extractPatch({
			conversationId: conv.id,
			userId: user.id,
			mode: 'project',
			turnId: 'turn-stream',
			userMessage,
			assistantMessage,
			initialPacket: buildInitialPacket(conv.id, 'project'),
			onActivity: (event) => activity.push(event)
		});

		// Reasoning arrived as multiple live deltas (token streaming), not one block.
		const reasoningDeltas = activity.filter((event) => event.type === 'reasoning');
		expect(reasoningDeltas.length).toBeGreaterThan(1);
		const reasoningText = reasoningDeltas
			.map((event) => (event.type === 'reasoning' ? event.text : ''))
			.join('');
		expect(reasoningText).toContain('Mara owns the key.');
		expect(reasoningText).toContain('internal plan');
		// The split <think> tag markers must be stripped, never surfaced.
		expect(reasoningText).not.toContain('<think>');
		expect(reasoningText).not.toContain('<thi');

		// Tool-call arguments split across SSE deltas were reassembled and staged.
		expect(extraction.patch.facts).toEqual([
			expect.objectContaining({
				entityKey: 'migrations',
				predicate: 'decision',
				value: 'append-only'
			})
		]);
		expect(activity.some((event) => event.type === 'tool.call')).toBe(true);
		// The closing message became the session response.
		expect(extraction.response).toBe('Stored the migration decision.');
	});

	it('includes provider response details when model-backed extraction fails', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const userMessage = messages.append(conv.id, {
			role: 'user',
			content: 'Remember that Mara found the attic key.'
		});
		const assistantMessage = messages.append(conv.id, {
			role: 'assistant',
			content: 'I will remember the key discovery.'
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				return new Response(
					JSON.stringify({
						error: {
							message: 'response_format json_object is not supported by this model'
						}
					}),
					{
						status: 400,
						statusText: 'Bad Request',
						headers: { 'content-type': 'application/json' }
					}
				);
			})
		);
		const extractor = new OpenAICompatibleMemoryExtractor({
			baseUrl: 'http://extractor.test/v1',
			model: 'story-extractor',
			timeoutMs: 1_000,
			maxInputChars: 4_000
		});

		await expect(
			extractor.extractPatch({
				conversationId: conv.id,
				userId: user.id,
				mode: 'story',
				turnId: 'turn-test',
				userMessage,
				assistantMessage
			})
		).rejects.toThrow(
			'Memory extractor request failed with HTTP 400 Bad Request for model "story-extractor" at http://extractor.test/v1/chat/completions: response_format json_object is not supported by this model'
		);
	});

	it('indexes committed memory for full-text search', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				facts: [
					{
						predicate: 'database_migration_strategy',
						value: 'Use append-only migrations for portal schema changes.'
					}
				]
			}
		});

		const results = memory.search(conv.id, {
			query: 'schema migration changes',
			limit: 5
		});

		expect(results.some((result) => result.sources?.includes('fts'))).toBe(true);
		expect(results.map((result) => result.text).join('\n')).toContain('append-only migrations');
	});

	it('wipe removes session memory while preserving conversation rows', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: { openLoops: [{ loopType: 'task', title: 'Remove me' }] }
		});

		expect(memory.listSnapshot(conv.id).openLoops).toHaveLength(1);
		memory.wipe(conv.id);
		expect(memory.listSnapshot(conv.id).openLoops).toHaveLength(0);
		expect(memory.search(conv.id, { query: 'Remove me', limit: 5 })).toHaveLength(0);
		expect(convs.get(conv.id, user.id)).not.toBeNull();
	});

	it('removes deleted memory from session and global search indexes', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		const committed = commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ predicate: 'search_cleanup', value: 'Delete stale indexes.' }] }
		});
		const factItem = memory
			.listPatchItems(conv.id, { patchId: committed.patch.id })
			.find((item) => item.itemType === 'fact')!;
		const global = memory.upsertGlobalMemory(user.id, {
			kind: 'preference',
			memoryKey: 'stale-search',
			value: 'delete global stale indexes'
		});

		expect(memory.search(conv.id, { query: 'stale indexes' })).not.toHaveLength(0);
		expect(
			memory.searchGlobalMemories(user.id, { query: 'global stale indexes' })
		).not.toHaveLength(0);

		expect(memory.deleteItem(conv.id, 'facts', factItem.itemId)).toBe(true);
		expect(memory.deleteGlobalMemory(user.id, global.id)).toBe(true);

		expect(memory.search(conv.id, { query: 'stale indexes' })).toHaveLength(0);
		expect(memory.searchGlobalMemories(user.id, { query: 'global stale indexes' })).toHaveLength(0);
	});

	it('records parent and message-head references for appended memory events', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'refs',
			workdir: '/tmp',
			model: null,
			memoryMode: 'project'
		});
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'reply' });
		commitPatch({
			conversationId: conv.id,
			mode: 'project',
			sourceMessageId: a1.id,
			patch: {
				entities: [{ entityKey: 'topic.keep', entityType: 'topic', displayName: 'Keep' }],
				facts: [{ entityKey: 'topic.keep', predicate: 'state', value: 'kept' }]
			}
		});

		const db = getDb();
		const events = db
			.prepare('SELECT id, parent_id FROM memory_event_log WHERE conversation_id = ? ORDER BY seq')
			.all(conv.id) as { id: string; parent_id: string | null }[];
		expect(events.length).toBeGreaterThan(1);

		// Every non-root event contributes a memory_parent ref to its parent.
		const parentRefs = db
			.prepare(`SELECT count(*) AS n FROM memory_refs WHERE conversation_id = ? AND ref_kind = ?`)
			.get(conv.id, 'memory_parent') as { n: number };
		expect(parentRefs.n).toBe(events.filter((e) => e.parent_id !== null).length);

		// The latest message pins the chain tip via exactly one message_head ref.
		const headRefs = db
			.prepare(
				`SELECT source_key, target_event_id FROM memory_refs
				  WHERE conversation_id = ? AND ref_kind = ?`
			)
			.all(conv.id, 'message_head') as { source_key: string; target_event_id: string }[];
		expect(headRefs).toHaveLength(1);
		expect(headRefs[0].source_key).toBe(a1.id);
		expect(headRefs[0].target_event_id).toBe(events[events.length - 1].id);
	});

	it('conditions packet selection on the current turn and bounds it by a token budget', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'budget', workdir: '/tmp', model: null });

		const facts = [];
		for (let i = 0; i < 40; i++) {
			facts.push({
				entityKey: 'topic.alpha',
				predicate: `note_${i}`,
				value: `routine filler logistics detail number ${i} about supply scheduling`
			});
		}
		facts.push({
			entityKey: 'topic.alpha',
			predicate: 'secret',
			value: 'the frostfang relic is hidden in the northern vault'
		});
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'topic.alpha', entityType: 'topic', displayName: 'Alpha' }],
				facts
			}
		});

		const recencyPacket = buildInitialPacket(conv.id, 'project', { tokenBudget: 200 });
		expect(recencyPacket.relevanceQuery).toBeNull();

		// Relevance-conditioned selection pulls the matching fact into the bounded packet.
		const relevantPacket = buildInitialPacket(conv.id, 'project', {
			query: 'frostfang relic northern vault',
			tokenBudget: 200
		});
		expect(relevantPacket.relevanceQuery).toContain('frostfang');
		expect(relevantPacket.facts.map((fact) => String(fact.value)).join(' ')).toContain('frostfang');

		// The packet stays bounded: a tiny budget yields fewer facts than a large one,
		// and never the entire fact set regardless of how much memory exists.
		const largePacket = buildInitialPacket(conv.id, 'project', { tokenBudget: 6000 });
		expect(relevantPacket.facts.length).toBeLessThan(41);
		expect(largePacket.facts.length).toBeGreaterThan(relevantPacket.facts.length);
		expect(renderMemoryPacket(relevantPacket).length).toBeLessThan(
			renderMemoryPacket(largePacket).length
		);
	});

	it('always renders an entity-key index so agent-driven recall can target by name', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'index', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' },
					{ entityKey: 'object.lantern', entityType: 'object', displayName: 'Lantern' }
				],
				facts: [
					{ entityKey: 'character.mara', predicate: 'mood', value: 'wary' },
					{ entityKey: 'object.lantern', predicate: 'fuel', value: 'half' }
				]
			}
		});

		// Even with a budget so small that no fact bodies survive, the merged
		// `also on record` remainder must still name every queryable entity by key.
		const packet = buildInitialPacket(conv.id, 'story', { tokenBudget: 1 });
		expect(packet.facts).toHaveLength(0);
		expect(packet.entityIndex.map((entry) => entry.entityKey)).toEqual(
			expect.arrayContaining(['character.mara', 'object.lantern'])
		);
		const rendered = renderMemoryPacket(packet);
		// The standalone `entity index` block is gone; names survive in the merged
		// name-only remainder instead.
		expect(rendered).not.toContain('entity index');
		expect(rendered).toContain('also on record');
		expect(rendered).toContain('character.mara');
		expect(rendered).toContain('object.lantern');
		expect(
			packet.entityIndex.find((entry) => entry.entityKey === 'character.mara')?.factCount
		).toBe(1);
	});

	it('merges the entity index into entities & facts without duplicating shown entities', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'merge', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' },
					{ entityKey: 'object.lantern', entityType: 'object', displayName: 'Lantern' },
					{ entityKey: 'place.vault', entityType: 'place', displayName: 'Vault' }
				]
			}
		});
		// Pin mara & lantern's facts so they survive a tiny budget and render with
		// detail, while place.vault (no surviving body) falls to the name-only
		// remainder — exercising the merged section's two halves at once.
		memory.addFact(conv.id, {
			entityId: memory.getEntity(conv.id, 'character.mara')!.id,
			predicate: 'mood',
			value: 'wary',
			pinned: true
		});
		memory.addFact(conv.id, {
			entityId: memory.getEntity(conv.id, 'object.lantern')!.id,
			predicate: 'fuel',
			value: 'half',
			pinned: true
		});

		const packet = buildInitialPacket(conv.id, 'project', { tokenBudget: 1 });
		const rendered = renderMemoryPacket(packet);

		// One merged section: detailed entities + a compact name-only remainder, no
		// standalone superset block.
		expect(rendered).not.toContain('entity index');
		expect(rendered).toContain('entities & facts');
		expect(rendered).toContain('also on record');

		// mara & lantern render with detail and must NOT reappear in the remainder;
		// each key occurs exactly once across the whole packet.
		const occurrences = (key: string) => rendered.split(key).length - 1;
		expect(occurrences('character.mara')).toBe(1);
		expect(occurrences('object.lantern')).toBe(1);
		// place.vault has no facts/summary detail, so it lives only in the remainder.
		expect(rendered).toContain('place.vault');

		// The union of detailed + remainder still equals the full index set, so no
		// entity becomes unqueryable by name.
		for (const entry of packet.entityIndex) expect(rendered).toContain(entry.entityKey);

		// Dedupe strictly shrinks the entity-index portion: the old block listed the
		// full superset, the new remainder only the entities not shown in detail.
		const indexLineLen = (e: { entityKey: string; entityType: string; factCount: number }) =>
			`- ${e.entityKey} (${e.entityType})${e.factCount ? ` (${e.factCount} facts)` : ''}\n`.length;
		const oldIndexLen = packet.entityIndex.reduce((n, e) => n + indexLineLen(e), 0);
		const shownKeys = new Set(['character.mara', 'object.lantern']);
		const newIndexLen = packet.entityIndex
			.filter((e) => !shownKeys.has(e.entityKey))
			.reduce((n, e) => n + indexLineLen(e), 0);
		expect(newIndexLen).toBeLessThan(oldIndexLen);
	});

	it('injects auto-search hits for the user message and dedupes already-rendered ones', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'autosearch', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				facts: [
					{
						predicate: 'caching',
						value: 'Adopt a write-through redis cache for hot lookups.'
					}
				]
			}
		});

		const userMsg = messages.append(conv.id, {
			role: 'user',
			content: 'What did we decide about the redis cache?'
		});

		// Under the normal budget the matching fact is rendered in `entities & facts`,
		// so the auto-retrieved section must suppress the duplicate hit rather than
		// print the same body twice.
		const prompt = buildPromptWithMemory({ conversationId: conv.id, mode: 'project', userMsg });
		expect(prompt).toContain('redis cache');
		expect(prompt).not.toContain('auto-retrieved for this turn');

		const fullPacket = buildInitialPacket(conv.id, 'project', { query: 'redis cache' });
		expect(fullPacket.autoSearchHits.length).toBeGreaterThan(0);
		expect(fullPacket.autoSearchHits.map((hit) => hit.text).join('\n')).toContain('redis cache');
		// The hit's item is rendered above, so the deduped render drops the section.
		expect(renderMemoryPacket(fullPacket)).not.toContain('auto-retrieved for this turn');

		// When the matching fact is squeezed out of the body by the token budget it is
		// no longer rendered above, so the auto-retrieved section surfaces it instead.
		const tightPacket = buildInitialPacket(conv.id, 'project', {
			query: 'redis cache',
			tokenBudget: 1
		});
		expect(tightPacket.facts).toHaveLength(0);
		const tightRender = renderMemoryPacket(tightPacket);
		expect(tightRender).toContain('auto-retrieved for this turn');
		expect(tightRender).toContain('redis cache');
	});

	it('consolidates re-observed facts down to a single active row', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'dedupe', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});

		// The same fact observed across three separate commits leaves one active
		// row; the duplicates are superseded by the projection's consolidation
		// pass (not stored as events), so the injected packet never repeats it.
		for (let i = 0; i < 3; i++) {
			commitPatch({
				conversationId: conv.id,
				patch: { facts: [{ entityKey: 'character.mara', predicate: 'trait', value: 'loyal' }] }
			});
		}
		expect(memory.listFacts(conv.id, { predicate: 'trait', status: 'active' })).toHaveLength(1);
		expect(memory.listFacts(conv.id, { predicate: 'trait', status: 'superseded' })).toHaveLength(2);

		// Consolidation is a pure projection derivation: a full rebuild from the
		// event stream yields the same single active fact.
		memory.rebuildSessionMemoryProjection(conv.id);
		expect(memory.listFacts(conv.id, { predicate: 'trait', status: 'active' })).toHaveLength(1);
	});

	it('revert re-derives the active set from the surviving observations', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'revert-support', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});

		const first = commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ entityKey: 'character.mara', predicate: 'trait', value: 'loyal' }] }
		});
		const second = commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ entityKey: 'character.mara', predicate: 'trait', value: 'loyal' }] }
		});

		// Two observations of the same fact: one active, one superseded.
		expect(memory.listFacts(conv.id, { predicate: 'trait', status: 'active' })).toHaveLength(1);

		// Reverting one observing patch must not lose the fact — the other
		// observation is promoted back to active by consolidation.
		memory.revertPatch(conv.id, second.patch.id);
		expect(memory.listFacts(conv.id, { predicate: 'trait', status: 'active' })).toHaveLength(1);

		// Reverting the last observation finally removes it.
		memory.revertPatch(conv.id, first.patch.id);
		expect(memory.listFacts(conv.id, { predicate: 'trait', status: 'active' })).toHaveLength(0);
	});

	it('un-supersedes a single-valued fact when the overriding patch is reverted', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'revert-supersede', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'the cellar' }]
			}
		});
		const moved = commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'the attic' }] }
		});

		let active = memory.listFacts(conv.id, { predicate: 'location', status: 'active' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('the attic');

		// Reverting the move restores the prior location as active — the supersede
		// was never stored, so rebuilding from the surviving observation re-derives
		// 'the cellar' as the current value.
		memory.revertPatch(conv.id, moved.patch.id);
		active = memory.listFacts(conv.id, { predicate: 'location', status: 'active' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('the cellar');
	});

	it('supersedes single-valued facts so state does not accumulate', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'supersede', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;

		memory.addFact(conv.id, { entityId, predicate: 'location', value: 'the cellar' });
		memory.addFact(conv.id, { entityId, predicate: 'location', value: 'the attic' });

		const active = memory.listFacts(conv.id, { predicate: 'location', status: 'active' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('the attic');
		expect(memory.listFacts(conv.id, { predicate: 'location', status: 'superseded' })).toHaveLength(
			1
		);
	});

	// ---- Fact consolidation: single-valued predicates ----

	it('keeps only the newest value active across a long single-valued chain', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'chain', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;

		for (const place of ['cellar', 'attic', 'garden', 'tower']) {
			memory.addFact(conv.id, { entityId, predicate: 'location', value: place });
		}

		const active = memory.listFacts(conv.id, { predicate: 'location', status: 'active' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('tower');
		expect(memory.listFacts(conv.id, { predicate: 'location', status: 'superseded' })).toHaveLength(
			3
		);
	});

	it('treats single-valued predicates case-insensitively', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'case', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;

		memory.addFact(conv.id, { entityId, predicate: 'Status', value: 'asleep' });
		memory.addFact(conv.id, { entityId, predicate: 'Status', value: 'awake' });

		const active = memory.listFacts(conv.id, { predicate: 'Status', status: 'active' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('awake');
	});

	it('consolidates single-valued facts per entity without cross-entity interference', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'per-entity', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' },
					{ entityKey: 'character.elias', entityType: 'character', displayName: 'Elias' }
				]
			}
		});
		const mara = memory.getEntity(conv.id, 'character.mara')!.id;
		const elias = memory.getEntity(conv.id, 'character.elias')!.id;

		memory.addFact(conv.id, { entityId: mara, predicate: 'location', value: 'cellar' });
		memory.addFact(conv.id, { entityId: elias, predicate: 'location', value: 'study' });
		memory.addFact(conv.id, { entityId: mara, predicate: 'location', value: 'attic' });

		const maraLoc = memory.listFacts(conv.id, { entityId: mara, predicate: 'location' });
		const eliasLoc = memory.listFacts(conv.id, { entityId: elias, predicate: 'location' });
		expect(maraLoc).toHaveLength(1);
		expect(maraLoc[0].value).toBe('attic');
		expect(eliasLoc).toHaveLength(1);
		expect(eliasLoc[0].value).toBe('study');
	});

	it('consolidates session-scoped single-valued facts among themselves', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'session-scope', workdir: '/tmp', model: null });
		// entity_id null (session-scoped). 'state' is single-valued.
		memory.addFact(conv.id, { predicate: 'state', value: 'draft' });
		memory.addFact(conv.id, { predicate: 'state', value: 'final' });

		const active = memory.listFacts(conv.id, { predicate: 'state', status: 'active' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('final');
		expect(active[0].entityId).toBeNull();
	});

	it('removes superseded facts from the search index', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'index-evict', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;

		const cellar = memory.addFact(conv.id, {
			entityId,
			predicate: 'location',
			value: 'moonlit_cellar'
		});
		expect(
			memory.search(conv.id, { query: 'moonlit_cellar' }).some((r) => r.itemId === cellar.id)
		).toBe(true);

		const attic = memory.addFact(conv.id, {
			entityId,
			predicate: 'location',
			value: 'sunny_attic'
		});
		// The now-superseded fact id is evicted from the index; the active one remains.
		expect(
			memory.search(conv.id, { query: 'moonlit_cellar' }).some((r) => r.itemId === cellar.id)
		).toBe(false);
		expect(
			memory.search(conv.id, { query: 'sunny_attic' }).some((r) => r.itemId === attic.id)
		).toBe(true);
	});

	// ---- Fact consolidation: multi-valued predicates (dedupe) ----

	it('keeps distinct values of a multi-valued predicate all active', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'multi', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;

		memory.addFact(conv.id, { entityId, predicate: 'trait', value: 'loyal' });
		memory.addFact(conv.id, { entityId, predicate: 'trait', value: 'brave' });

		const active = memory.listFacts(conv.id, { predicate: 'trait', status: 'active' });
		expect(active.map((f) => f.value).sort()).toEqual(['brave', 'loyal']);
		expect(memory.listFacts(conv.id, { predicate: 'trait', status: 'superseded' })).toHaveLength(0);
	});

	it('dedupes repeated values but preserves other distinct values', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'multi-mixed', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;

		memory.addFact(conv.id, { entityId, predicate: 'trait', value: 'loyal' });
		memory.addFact(conv.id, { entityId, predicate: 'trait', value: 'brave' });
		memory.addFact(conv.id, { entityId, predicate: 'trait', value: 'loyal' });

		const active = memory.listFacts(conv.id, { predicate: 'trait', status: 'active' });
		expect(active.map((f) => f.value).sort()).toEqual(['brave', 'loyal']);
		// Exactly one duplicate 'loyal' observation was superseded.
		const superseded = memory.listFacts(conv.id, { predicate: 'trait', status: 'superseded' });
		expect(superseded).toHaveLength(1);
		expect(superseded[0].value).toBe('loyal');
	});

	// ---- Event-sourced revert / rebuild ----

	it('rebuilds the identical active set from the event stream for a single-valued chain', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'rebuild-sv', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;
		for (const place of ['cellar', 'attic', 'garden']) {
			memory.addFact(conv.id, { entityId, predicate: 'location', value: place });
		}

		const before = memory
			.listFacts(conv.id, { predicate: 'location', status: 'active' })
			.map((f) => f.value);
		memory.rebuildSessionMemoryProjection(conv.id);
		const after = memory
			.listFacts(conv.id, { predicate: 'location', status: 'active' })
			.map((f) => f.value);
		expect(after).toEqual(before);
		expect(after).toEqual(['garden']);
	});

	it('rebuilds the identical active set for distinct multi-valued facts', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'rebuild-mv', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [
					{ entityKey: 'character.mara', predicate: 'trait', value: 'loyal' },
					{ entityKey: 'character.mara', predicate: 'trait', value: 'brave' }
				]
			}
		});

		memory.rebuildSessionMemoryProjection(conv.id);
		const active = memory.listFacts(conv.id, { predicate: 'trait', status: 'active' });
		expect(active.map((f) => f.value).sort()).toEqual(['brave', 'loyal']);
	});

	it('reverting a middle patch of a single-valued chain re-derives the newest survivor', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'revert-middle', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'cellar' }]
			}
		});
		const middle = commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'attic' }] }
		});
		commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'garden' }] }
		});

		// Reverting the middle observation leaves cellar + garden; garden is newest.
		memory.revertPatch(conv.id, middle.patch.id);
		const active = memory.listFacts(conv.id, { predicate: 'location', status: 'active' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('garden');
	});

	it('reverting the newest single-valued observation restores the prior value', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'revert-newest', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'cellar' }]
			}
		});
		const newest = commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'attic' }] }
		});

		memory.revertPatch(conv.id, newest.patch.id);
		const active = memory.listFacts(conv.id, { predicate: 'location', status: 'active' });
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('cellar');
	});

	// ---- Packet injection: budget, pinning, salience ----

	it('never injects superseded facts into the packet', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'no-superseded', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }],
				facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'cellar' }]
			}
		});
		commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ entityKey: 'character.mara', predicate: 'location', value: 'attic' }] }
		});

		const packet = buildInitialPacket(conv.id, 'story', { tokenBudget: 6000 });
		const locations = packet.facts.filter((f) => f.predicate === 'location');
		expect(locations).toHaveLength(1);
		expect(locations[0].value).toBe('attic');
		expect(packet.facts.every((f) => f.status === 'active')).toBe(true);
	});

	it('always injects pinned facts even under a tiny budget, and renders them', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'pinned', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;
		memory.addFact(conv.id, {
			entityId,
			predicate: 'oath',
			value: 'never to betray the guild',
			pinned: true
		});
		// A non-pinned filler fact that the budget should exclude.
		memory.addFact(conv.id, { entityId, predicate: 'note', value: 'idle background detail' });

		const packet = buildInitialPacket(conv.id, 'project', { tokenBudget: 1 });
		expect(packet.facts.some((f) => f.predicate === 'oath' && f.pinned)).toBe(true);
		expect(packet.facts.some((f) => f.predicate === 'note')).toBe(false);
		expect(renderMemoryPacket(packet)).toContain('oath = never to betray the guild (pinned)');
	});

	it('ranks pinned facts ahead of merely recent ones without a query', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'pin-rank', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;
		memory.addFact(conv.id, { entityId, predicate: 'oath', value: 'guild loyalty', pinned: true });
		// Newer, unpinned fact added afterwards.
		memory.addFact(conv.id, { entityId, predicate: 'mood', value: 'restless' });

		const packet = buildInitialPacket(conv.id, 'project');
		expect(packet.relevanceQuery).toBeNull();
		expect(packet.facts[0].predicate).toBe('oath');
	});

	it('always includes open loops regardless of token budget', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'continuity', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				openLoops: [{ loopType: 'task', title: 'Wire up the salience ranker' }]
			}
		});

		const packet = buildInitialPacket(conv.id, 'project', { tokenBudget: 1 });
		expect(packet.openLoops).toHaveLength(1);
		const rendered = renderMemoryPacket(packet);
		expect(rendered).toContain('Wire up the salience ranker');
	});

	it('keeps facts grouped under their entity key even when the entity summary is dropped', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'key-preserve', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{
						entityKey: 'character.mara',
						entityType: 'character',
						displayName: 'Mara',
						summary: 'A wary scout with a very long descriptive summary that costs tokens.'
					}
				]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;
		memory.addFact(conv.id, { entityId, predicate: 'oath', value: 'guild loyalty', pinned: true });

		// Budget 1: the entity summary block is dropped, but the pinned fact stays
		// and must still render grouped under a header naming its entity key.
		const packet = buildInitialPacket(conv.id, 'story', { tokenBudget: 1 });
		expect(packet.entities).toHaveLength(0);
		const rendered = renderMemoryPacket(packet);
		expect(rendered).toMatch(/character\.mara[^\n]*\n {4}oath = guild loyalty \(pinned\)/);
	});

	it('mints an entity from the key when a fact references an unknown entityKey', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'auto-entity', workdir: '/tmp', model: null });
		// No entities[] entry — the fact references a brand-new key.
		commitPatch({
			conversationId: conv.id,
			patch: {
				facts: [{ entityKey: 'object.brass_key', predicate: 'location', value: 'the study' }]
			}
		});

		const entity = memory.getEntity(conv.id, 'object.brass_key');
		expect(entity).not.toBeNull();
		expect(entity?.entityType).toBe('object');
		expect(entity?.displayName).toBe('Brass Key');
		const facts = memory.listFacts(conv.id, { entityId: entity!.id });
		expect(facts).toHaveLength(1);
		expect(facts[0].entityId).toBe(entity!.id);
	});

	it('attaches keyless facts to a per-conversation session entity', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'session-anchor', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				facts: [{ predicate: 'tone', value: 'formal' }]
			}
		});

		const session = memory.getEntity(conv.id, 'session.context');
		expect(session).not.toBeNull();
		expect(session?.entityType).toBe('session');
		const facts = memory.listFacts(conv.id, { entityId: session!.id });
		expect(facts.map((f) => f.predicate)).toContain('tone');
		// And it injects grouped under the session entity rather than detached.
		const rendered = renderMemoryPacket(buildInitialPacket(conv.id, 'project'));
		expect(rendered).toMatch(/session\.context[^\n]*\n {4}tone = formal/);
	});

	it('records minted entities as patch items so revert removes them', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'mint-revert', workdir: '/tmp', model: null });
		const { patch } = commitPatch({
			conversationId: conv.id,
			patch: {
				facts: [{ entityKey: 'object.brass_key', predicate: 'location', value: 'the study' }]
			}
		});

		const entity = memory.getEntity(conv.id, 'object.brass_key');
		expect(entity).not.toBeNull();
		const items = memory.listPatchItems(conv.id, { patchId: patch.id, limit: 100 });
		expect(items.some((i) => i.itemType === 'entity' && i.itemId === entity!.id)).toBe(true);

		memory.revertPatch(conv.id, patch.id);
		// The auto-minted entity must be reverted (soft-deleted), not left active.
		expect(memory.getEntity(conv.id, 'object.brass_key')?.status).toBe('deleted');
	});

	it('merges a duplicate entity into the canonical one and survives rebuild', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'merge', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{ entityKey: 'character.john', entityType: 'character', displayName: 'John' },
					{
						entityKey: 'character.john_smith',
						entityType: 'character',
						displayName: 'John Smith'
					}
				],
				facts: [
					{ entityKey: 'character.john', predicate: 'role', value: 'host' },
					{ entityKey: 'character.john_smith', predicate: 'hometown', value: 'Riverton' }
				],
				events: [
					{
						eventType: 'timeline',
						summary: 'John Smith walked on stage.',
						entityKey: 'character.john_smith'
					}
				]
			}
		});

		const canonical = memory.getEntity(conv.id, 'character.john')!;
		const duplicate = memory.getEntity(conv.id, 'character.john_smith')!;

		const result = memory.mergeEntities(conv.id, {
			fromKeyOrId: 'character.john_smith',
			intoKeyOrId: 'character.john'
		});
		expect(result.ok).toBe(true);
		expect(result.reassignedFacts).toBe(1);
		expect(result.reassignedEvents).toBe(1);

		// Duplicate is retired; canonical inherits its facts and events.
		expect(memory.getEntity(conv.id, 'character.john_smith')?.status).toBe('deleted');
		const facts = memory.listFacts(conv.id, { entityId: canonical.id, limit: 50 });
		expect(facts.map((f) => f.predicate).sort()).toEqual(['hometown', 'role']);
		const events = memory.listEvents(conv.id, { entityId: canonical.id });
		expect(events.some((e) => e.summary.includes('walked on stage'))).toBe(true);
		expect(memory.listEvents(conv.id, { entityId: duplicate.id })).toHaveLength(0);

		// The reassignment is recorded in the append-only log, so a full
		// projection rebuild reconstructs the merged state.
		memory.rebuildSessionMemoryProjection(conv.id);
		const rebuilt = memory.listFacts(conv.id, { entityId: canonical.id, limit: 50 });
		expect(rebuilt.map((f) => f.predicate).sort()).toEqual(['hometown', 'role']);
		expect(memory.getEntity(conv.id, 'character.john_smith')?.status).toBe('deleted');
	});

	it('consolidates colliding single-valued facts when merging entities', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'merge-collide', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{ entityKey: 'character.john', entityType: 'character', displayName: 'John' },
					{ entityKey: 'character.johnny', entityType: 'character', displayName: 'Johnny' }
				]
			}
		});
		const canonical = memory.getEntity(conv.id, 'character.john')!.id;
		const duplicate = memory.getEntity(conv.id, 'character.johnny')!.id;
		// Canonical observed location first; the duplicate has the newer location.
		memory.addFact(conv.id, { entityId: canonical, predicate: 'location', value: 'study' });
		memory.addFact(conv.id, { entityId: duplicate, predicate: 'location', value: 'cellar' });

		memory.mergeEntities(conv.id, {
			fromKeyOrId: 'character.johnny',
			intoKeyOrId: 'character.john'
		});

		// Single-valued 'location' collapses to one active value (the newest).
		const active = memory.listFacts(conv.id, {
			entityId: canonical,
			predicate: 'location',
			status: 'active'
		});
		expect(active).toHaveLength(1);
		expect(active[0].value).toBe('cellar');
	});

	it('memory_merge_entities tool merges via key and rejects bad input', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'merge-tool', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{ entityKey: 'character.john', entityType: 'character', displayName: 'John' },
					{
						entityKey: 'character.john_smith',
						entityType: 'character',
						displayName: 'John Smith'
					}
				],
				facts: [{ entityKey: 'character.john_smith', predicate: 'hometown', value: 'Riverton' }]
			}
		});
		const tools = buildMemoryTools({ userId: user.id, conversationId: conv.id, mode: 'project' });
		const merge = tools.find((tool) => tool.name === 'memory_merge_entities')!;
		expect(merge.permissionBehavior).toBe('never-prompt');

		const ok = toolData<{ ok: boolean; reassignedFacts: number }>(
			await merge.handler({ from: 'character.john_smith', into: 'character.john' })
		);
		expect(ok.ok).toBe(true);
		expect(ok.reassignedFacts).toBe(1);
		expect(memory.getEntity(conv.id, 'character.john_smith')?.status).toBe('deleted');

		const sameEntity = toolData<{ ok: boolean }>(
			await merge.handler({ from: 'character.john', into: 'character.john' })
		);
		expect(sameEntity.ok).toBe(false);

		const unknown = toolData<{ ok: boolean; error: string }>(
			await merge.handler({ from: 'character.ghost', into: 'character.john' })
		);
		expect(unknown.ok).toBe(false);
		expect(unknown.error).toContain('Unknown source entity');
	});

	it('refuses to merge into a tombstoned entity but allows merging a tombstoned duplicate away', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'merge-deleted', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [
					{ entityKey: 'character.john', entityType: 'character', displayName: 'John' },
					{
						entityKey: 'character.john_smith',
						entityType: 'character',
						displayName: 'John Smith'
					}
				],
				facts: [{ entityKey: 'character.john_smith', predicate: 'hometown', value: 'Riverton' }]
			}
		});
		const canonical = memory.getEntity(conv.id, 'character.john')!;
		// Retire the canonical entity, then attempt to fold the duplicate into it.
		memory.updateEntity(conv.id, canonical.id, { status: 'deleted' });
		const intoDeleted = memory.mergeEntities(conv.id, {
			fromKeyOrId: 'character.john_smith',
			intoKeyOrId: 'character.john'
		});
		expect(intoDeleted.ok).toBe(false);
		expect(intoDeleted.error).toContain('deleted');
		// The duplicate is untouched: still active and still owns its fact.
		expect(memory.getEntity(conv.id, 'character.john_smith')?.status).toBe('active');

		// Merging *from* a tombstoned duplicate into a live entity is allowed; this
		// is the cleanup path when a duplicate was already deleted out-of-band.
		const live = convs.create(user.id, {
			title: 'merge-from-deleted',
			workdir: '/tmp',
			model: null
		});
		commitPatch({
			conversationId: live.id,
			patch: {
				entities: [
					{ entityKey: 'character.john', entityType: 'character', displayName: 'John' },
					{
						entityKey: 'character.john_smith',
						entityType: 'character',
						displayName: 'John Smith'
					}
				],
				facts: [{ entityKey: 'character.john_smith', predicate: 'hometown', value: 'Riverton' }]
			}
		});
		const duplicate = memory.getEntity(live.id, 'character.john_smith')!;
		memory.updateEntity(live.id, duplicate.id, { status: 'deleted' });
		const fromDeleted = memory.mergeEntities(live.id, {
			fromKeyOrId: 'character.john_smith',
			intoKeyOrId: 'character.john'
		});
		expect(fromDeleted.ok).toBe(true);
		expect(fromDeleted.reassignedFacts).toBe(1);
		const target = memory.getEntity(live.id, 'character.john')!;
		expect(
			memory.listFacts(live.id, { entityId: target.id, limit: 50 }).map((f) => f.predicate)
		).toContain('hometown');
	});

	it('renders legacy detached facts even when no entity-anchored facts exist', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'detached-only', workdir: '/tmp', model: null });
		// Simulate a legacy fact with no owning entity (null entityId).
		memory.addFact(conv.id, { entityId: null, predicate: 'tone', value: 'wry' });

		const rendered = renderMemoryPacket(buildInitialPacket(conv.id, 'project'));
		expect(rendered).toContain('(session-scoped)');
		expect(rendered).toMatch(/\(session-scoped\):\n {4}tone = wry/);
	});

	it('reflects only active facts in the entity-index fact counts', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'index-count', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				entities: [{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }]
			}
		});
		const entityId = memory.getEntity(conv.id, 'character.mara')!.id;
		memory.addFact(conv.id, { entityId, predicate: 'location', value: 'cellar' });
		memory.addFact(conv.id, { entityId, predicate: 'location', value: 'attic' });
		memory.addFact(conv.id, { entityId, predicate: 'trait', value: 'brave' });

		const packet = buildInitialPacket(conv.id, 'project', { tokenBudget: 1 });
		const entry = packet.entityIndex.find((e) => e.entityKey === 'character.mara');
		// One active location (attic) + one trait = 2 active facts.
		expect(entry?.factCount).toBe(2);
	});

	it('uses a single memory_search call to drive both ranking and auto-search', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'one-search', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				facts: [{ predicate: 'cache', value: 'Adopt a redis write-through cache.' }]
			}
		});
		const userMsg = messages.append(conv.id, {
			role: 'user',
			content: 'remind me about the redis cache decision'
		});

		const searchSpy = vi.spyOn(memory, 'search');
		try {
			buildPromptWithMemory({ conversationId: conv.id, mode: 'project', userMsg });
			expect(searchSpy).toHaveBeenCalledTimes(1);
		} finally {
			searchSpy.mockRestore();
		}
	});

	it('captures a directive via commit as a pinned fact with provenance', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'directive', workdir: '/tmp', model: null });
		const src = messages.append(conv.id, {
			role: 'assistant',
			content: 'When creating new characters, give them names.'
		});
		const result = commitPatch({
			conversationId: conv.id,
			mode: 'story',
			sourceMessageId: src.id,
			patch: {
				facts: [{ predicate: 'directive', value: 'When creating new characters, give them names.' }]
			}
		});
		expect(result.patch.status).toBe('committed');

		const directive = memory
			.listFacts(conv.id, { predicate: 'directive', limit: 10 })
			.find((f) => f.value === 'When creating new characters, give them names.');
		expect(directive).toBeTruthy();
		expect(directive!.pinned).toBe(true);
		expect(directive!.status).toBe('active');
		expect(directive!.sourceMessageId).toBe(src.id);

		const packet = buildInitialPacket(conv.id, 'story');
		expect(packet.directives.map((d) => d.value)).toContain(
			'When creating new characters, give them names.'
		);
		// Directives must not also appear in the generic facts list.
		expect(packet.facts.some((f) => f.predicate === 'directive')).toBe(false);
	});

	it('normalizes a non-canonically-cased directive predicate on commit', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'directive-case', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ predicate: 'Directive', value: 'Speak only in rhyming couplets.' }] }
		});

		// Stored under the canonical lowercase predicate, force-pinned.
		const directive = memory
			.listFacts(conv.id, { predicate: 'directive', limit: 10 })
			.find((f) => f.value === 'Speak only in rhyming couplets.');
		expect(directive).toBeTruthy();
		expect(directive!.predicate).toBe('directive');
		expect(directive!.pinned).toBe(true);

		// And it surfaces in the always-on block, never silently dropped from both
		// the directives block and the generic facts list.
		const packet = buildInitialPacket(conv.id, 'story');
		expect(packet.directives.map((d) => d.value)).toContain('Speak only in rhyming couplets.');
		expect(renderMemoryPacket(packet)).toContain('Speak only in rhyming couplets.');
	});

	it('injects every directive verbatim and never drops them under budget pressure', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'directive-budget', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				facts: [
					{ predicate: 'directive', value: 'Always address the user formally.' },
					{ predicate: 'directive', value: 'Never reveal the villain before chapter three.' }
				]
			}
		});
		// Pile on many ordinary facts that the tiny budget should exclude.
		const entityId = memory.upsertEntity(conv.id, {
			entityKey: 'session.context',
			entityType: 'session',
			displayName: 'Session'
		}).id;
		for (let i = 0; i < 50; i++) {
			memory.addFact(conv.id, { entityId, predicate: `note_${i}`, value: `filler detail ${i}` });
		}

		const packet = buildInitialPacket(conv.id, 'project', { tokenBudget: 1 });
		expect(packet.directives).toHaveLength(2);
		const rendered = renderMemoryPacket(packet);
		expect(rendered).toContain('standing directives (2)');
		expect(rendered).toContain('Always address the user formally.');
		expect(rendered).toContain('Never reveal the villain before chapter three.');
	});

	it('stops injecting a directive once it is deactivated/superseded', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'directive-retire', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ predicate: 'directive', value: 'Give new characters names.' }] }
		});
		const directive = memory.listFacts(conv.id, { predicate: 'directive', limit: 10 })[0];
		expect(directive).toBeTruthy();

		// Deactivate it the way the inspector control does (tombstone the fact).
		memory.updateFact(conv.id, directive.id, { status: 'deleted' });

		const packet = buildInitialPacket(conv.id, 'story');
		expect(packet.directives).toHaveLength(0);
		expect(renderMemoryPacket(packet)).not.toContain('Give new characters names.');
	});

	it('deactivates a directive through the memory PATCH endpoint', async () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'directive-api', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: { facts: [{ predicate: 'directive', value: 'Stay in character at all times.' }] }
		});
		const directive = memory.listFacts(conv.id, { predicate: 'directive', limit: 10 })[0];

		const res = await patchMemoryItem(
			routeEvent(conv.id, user.id, 'facts', directive.id, { status: 'deleted' })
		);
		expect(res.status).toBe(200);
		expect(buildInitialPacket(conv.id, 'story').directives).toHaveLength(0);
	});

	it('rejects a directive without a usable instruction string', () => {
		const result = validatePatch({ facts: [{ predicate: 'directive', value: '' }] });
		expect(result.ok).toBe(false);
		expect(result.issues.some((i) => i.code === 'directive_value_invalid')).toBe(true);
	});

	it('advertises the directive primitive in every mode except off', () => {
		expect(getMemoryProfile('off').primitives).not.toContain('directive');
		for (const mode of ['lightweight', 'project', 'story', 'strict'] as const) {
			expect(getMemoryProfile(mode).primitives).toContain('directive');
		}
	});
});

describe('extractor prompt directive guidance', () => {
	function singleShotPrompt(): string {
		const input = {
			conversationId: 'c1',
			userId: 'u1',
			mode: 'story',
			turnId: 't1',
			userMessage: { role: 'user', content: 'You are a text-based RPG.' },
			assistantMessage: {
				role: 'assistant',
				content: 'I am a text-based RPG. I track inventory. How would you like to begin?'
			}
		} as unknown as ExtractPatchInput;
		return buildExtractorPrompt(input, 100_000);
	}

	// Both extractor prompts must teach that a directive can originate from the
	// ASSISTANT's own self-description, not only from a user instruction.
	for (const [label, build] of [
		['tool-calling system prompt', buildToolExtractorSystemPrompt],
		['single-shot inline prompt', singleShotPrompt]
	] as const) {
		it(`${label} states a directive may come from the assistant's self-description`, () => {
			const text = build();
			expect(text).toMatch(/regardless of who states it/i);
			expect(text).toMatch(/assistant declares it about its own role/i);
			// Identity/role statement recorded as a standing-rule directive.
			expect(text).toContain('Act as a text-based RPG');
			// Boundary: durable rules in, transient self-talk out.
			expect(text).toMatch(/durable\/standing operating rules and role definitions/i);
			expect(text).toContain('How would you like to begin?');
		});
	}
});
