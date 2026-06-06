import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as users from '../src/lib/server/db/repos/users';
import * as convs from '../src/lib/server/db/repos/conversations';
import * as messages from '../src/lib/server/db/repos/messages';
import * as memory from '../src/lib/server/db/repos/memory';
import {
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
import {
	LocalHashEmbeddingProvider,
	OpenAICompatibleEmbeddingProvider
} from '../src/lib/server/memory/embeddings';
import { getMemoryProfile, listMemoryProfiles } from '../src/lib/server/memory/profiles';
import * as memoryProfiles from '../src/lib/server/memory/profiles';
import { buildMemoryTools } from '../src/lib/server/tools/memory';
import { PATCH as patchMemoryItem } from '../src/routes/api/conversations/[id]/memory/[kind]/[itemId]/+server';
import { getDb } from '../src/lib/server/db';
import { setupLocalEnv } from './helpers/env';

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
				decisions: [{ subject: 'lighting', decision: 'Keep the candle lit.' }],
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
		expect(rendered).toContain('lighting: Keep the candle lit.');
		expect(rendered).toContain('Find the attic key');
		expect(rendered).toContain('[related: character.mara]');
		// The default (main-turn) rendering omits internal loop ids as noise.
		expect(rendered).not.toMatch(/\[id=/);
		// The extractor view opts in to loop ids so it can populate
		// resolveOpenLoops and actually close loops instead of only opening them.
		const extractorRendered = renderMemoryPacket(packet, { includeOpenLoopIds: true });
		expect(extractorRendered).toMatch(/\[id=[^\]]+\] \(task, p\d+\) Find the attic key/);

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
				decisions: [
					{
						subject: 'fresh context',
						decision: 'Memory-backed turns include tools in the first pass.'
					}
				],
				openLoops: [{ loopType: 'implementation', title: 'Build strict profile validators' }]
			}
		});

		expect(committed.patch.status).toBe('committed');
		expect(
			memory.search(conv.id, { query: 'mandatory tools' }).map((row) => row.itemType)
		).toContain('decision');
		const packet = buildInitialPacket(conv.id, 'project');
		expect(packet.toolGuidance.mandatory).toBe(true);
		expect(packet.decisions[0]?.decision).toContain('first pass');
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
			patch: { decisions: [{ subject: 'review', decision: 'Reject stale item.' }] }
		});
		const item = memory
			.listPatchItems(conv.id, { patchId: committed.patch.id })
			.find((row) => row.itemType === 'decision')!;

		const approved = memory.reviewPatchItem(conv.id, item.id, 'approve');
		expect(approved.item?.reviewStatus).toBe('approved');
		expect(memory.listDecisions(conv.id)).toHaveLength(1);

		const rejected = memory.reviewPatchItem(conv.id, item.id, 'reject');
		expect(rejected.item?.reviewStatus).toBe('rejected');
		expect(rejected.affected).toBe(true);
		expect(memory.listDecisions(conv.id)).toHaveLength(0);
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
			patch: { decisions: [{ subject: 'memory', decision: 'Initial decision' }] }
		});
		const decisionItem = memory
			.listPatchItems(conv.id, { patchId: committed.patch.id })
			.find((item) => item.itemType === 'decision')!;

		const updated = memory.updateDecision(conv.id, decisionItem.itemId, {
			decision: 'Corrected decision'
		});
		expect(updated?.decision).toBe('Corrected decision');
		expect(memory.deleteItem(conv.id, 'decisions', decisionItem.itemId)).toBe(true);
		expect(memory.listDecisions(conv.id)).toHaveLength(0);
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
			patch: { decisions: [{ subject: 'memory', decision: 'Initial decision' }] }
		});
		const decisionItem = memory
			.listPatchItems(conv.id, { patchId: committed.patch.id })
			.find((item) => item.itemType === 'decision')!;

		await expect(
			patchMemoryItem(
				routeEvent(conv.id, user.id, 'decisions', decisionItem.itemId, {
					status: 'invisible'
				})
			)
		).rejects.toMatchObject({ status: 400 });
		expect(memory.listDecisions(conv.id)[0]?.status).toBe('active');
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

		const propose = tools.find((tool) => tool.name === 'memory_propose_patch')!;
		await propose.handler({
			summary: 'Remember decision',
			patch: {
				decisions: [{ subject: 'memory', decision: 'Tools are mandatory in the MVP.' }]
			}
		});

		const search = tools.find((tool) => tool.name === 'memory_search')!;
		const raw = await search.handler({ query: 'mandatory', limit: 5 });
		expect(raw).toContain('Tools are mandatory');
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

		expect(await transcript.handler({ query: 'blue candle' })).toContain('half burned');
		expect(await timeline.handler({ eventType: 'timeline' })).toContain('entered the study');
		expect(await clues.handler({ status: 'all' })).toContain('Blue candle');
		expect(await knowledge.handler({ characterEntityKey: 'character.elias' })).toContain(
			'candle was lit'
		);
		await globalRemember.handler({
			kind: 'preference',
			key: 'story-tone',
			value: 'noir'
		});
		expect(await globalSearch.handler({ query: 'noir' })).toContain('story-tone');
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
		const parsed = JSON.parse(raw) as { results: Array<{ status: string; sources: unknown[] }> };

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
					decisions: [
						{
							subject: 'migrations',
							decision: 'Use append-only migrations for schema changes.'
						},
						{
							subject: 'secret',
							decision: 'token=abcdefghijklmnopqrstuvwxyz'
						}
					],
					openLoops: [{ loopType: 'project_task', title: 'Document migration decision' }]
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
		expect(memory.listDecisions(conv.id)).toHaveLength(1);
		expect(memory.listDecisions(conv.id)[0]?.decision).toContain('append-only');
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
							{ entityKey: 'person.raven', predicate: 'alias', value: 'the Raven' },
							{ entityKey: 'character.the_raven', predicate: 'location', value: 'study' },
							{ entityKey: 'Mara', predicate: 'owns', value: 'brass key' },
							{ entityKey: 'person.raven', predicate: 'distrusts', value: 'Elias' }
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

		expect(prompt).toContain('Prefer granular fact collection');
		expect(prompt).toContain('Reuse entityKey values from the initial packet');
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
							name: 'memory_propose_patch',
							arguments: JSON.stringify({
								summary: 'Recorded migration decision and Mara key ownership.',
								patch: {
									entities: [
										{ entityKey: 'character.mara', entityType: 'character', displayName: 'Mara' }
									],
									facts: [{ entityKey: 'character.mara', predicate: 'owns', value: 'brass key' }],
									decisions: [{ subject: 'migrations', decision: 'Use append-only migrations.' }]
								}
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

		// The background agent is offered both read tools and the staging writer.
		expect(seenToolNames).toContain('memory_search');
		expect(seenToolNames).toContain('memory_propose_patch');
		// Activity is surfaced so the extractor reads like a fully-featured
		// nested agent: thoughts (reasoning + <think>) and spoken content are
		// separate threaded streams, interleaved with the staging tool call.
		expect(activity.map((event) => event.type)).toEqual([
			'reasoning',
			'content',
			'reasoning.end',
			'tool.call',
			'tool.result',
			'content'
		]);
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
		expect(activityCall).toMatchObject({ type: 'tool.call', tool: 'memory_propose_patch' });
		expect(activityResult).toMatchObject({ type: 'tool.result', ok: true });
		// The final spoken message is captured as the session response.
		expect(extraction.response).toBe('Stored the migration decision and Mara key ownership.');
		// It received validation feedback after staging.
		expect(feedback.some((entry) => String(entry).includes('"staged":true'))).toBe(true);
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
				return {
					content: '',
					toolCalls: [
						{
							id: 'c1',
							name: 'memory_propose_patch',
							arguments: JSON.stringify({
								patch: { openLoops: [{ loopType: 'task', title: 'go' }] }
							})
						}
					]
				};
			}
			if (step === 2) {
				// Correction: a valid title for the same loop.
				return {
					content: '',
					toolCalls: [
						{
							id: 'c2',
							name: 'memory_propose_patch',
							arguments: JSON.stringify({
								patch: { openLoops: [{ loopType: 'task', title: 'Inspect the cellar' }] }
							})
						}
					]
				};
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
		expect(feedback.some((entry) => entry.includes('"staged":false'))).toBe(true);
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
				return {
					content: '',
					toolCalls: [
						{
							id: 'c1',
							name: 'memory_propose_patch',
							arguments: JSON.stringify({
								patch: {
									resolveOpenLoops: [
										{ id: keep.id, status: 'resolved', reason: 'Chosen.' },
										{ id: drop.id, status: 'dropped' }
									]
								}
							})
						}
					]
				};
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
				return {
					content: '',
					toolCalls: [
						{
							id: 'c1',
							name: 'memory_propose_patch',
							arguments: JSON.stringify({
								patch: {
									resolveOpenLoops: [
										{
											id: loop.id,
											status: 'resolved',
											reason: 'Replaced key sk_live_0123456789abcdefghij in the vault.'
										}
									]
								}
							})
						}
					]
				};
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
										function: { name: 'memory_propose_patch', arguments: '{"patch":{"deci' }
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
											arguments: 'sions":[{"subject":"migrations","decision":"append-only"}]}}'
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
		expect(extraction.patch.decisions).toEqual([
			expect.objectContaining({ subject: 'migrations', decision: 'append-only' })
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

	it('indexes committed memory for hybrid vector search', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'memory', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				decisions: [
					{
						subject: 'database migration strategy',
						decision: 'Use append-only migrations for portal schema changes.'
					}
				]
			}
		});

		const results = memory.search(conv.id, {
			query: 'schema migration changes',
			limit: 5
		});

		expect(
			results.some(
				(result) => result.sources?.includes('sqlite-vec') || result.sources?.includes('vector')
			)
		).toBe(true);
		expect(results.map((result) => result.text).join('\n')).toContain('append-only migrations');
	});

	it('supports local and OpenAI-compatible embedding providers', async () => {
		const local = await new LocalHashEmbeddingProvider().embed({
			texts: ['append-only migrations'],
			purpose: 'index'
		});
		expect(local.model).toBe('local-hash-v1');
		expect(local.vectors[0]?.length).toBeGreaterThan(0);

		const openai = new OpenAICompatibleEmbeddingProvider({
			baseUrl: 'http://127.0.0.1:9/v1',
			model: 'embed-test',
			timeoutMs: 1_000,
			embedJson: async () => ({
				data: [{ embedding: [0.1, 0.2, 0.3] }]
			})
		});
		const remote = await openai.embed({ texts: ['memory recall'], purpose: 'query' });
		expect(remote).toMatchObject({
			model: 'embed-test',
			dimensions: 3,
			vectors: [[0.1, 0.2, 0.3]]
		});
		expect(memory.vectorAccelerationStatus()).toMatchObject({
			available: true,
			provider: 'sqlite-vec'
		});
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
			patch: { decisions: [{ subject: 'search cleanup', decision: 'Delete stale indexes.' }] }
		});
		const decisionItem = memory
			.listPatchItems(conv.id, { patchId: committed.patch.id })
			.find((item) => item.itemType === 'decision')!;
		const global = memory.upsertGlobalMemory(user.id, {
			kind: 'preference',
			memoryKey: 'stale-search',
			value: 'delete global stale indexes'
		});

		expect(memory.search(conv.id, { query: 'stale indexes' })).not.toHaveLength(0);
		expect(
			memory.searchGlobalMemories(user.id, { query: 'global stale indexes' })
		).not.toHaveLength(0);

		expect(memory.deleteItem(conv.id, 'decisions', decisionItem.itemId)).toBe(true);
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

		// Even with a budget so small that no fact bodies survive, the entity index
		// must still name every queryable entity by key.
		const packet = buildInitialPacket(conv.id, 'story', { tokenBudget: 1 });
		expect(packet.facts).toHaveLength(0);
		expect(packet.entityIndex.map((entry) => entry.entityKey)).toEqual(
			expect.arrayContaining(['character.mara', 'object.lantern'])
		);
		const rendered = renderMemoryPacket(packet);
		expect(rendered).toContain('entity index');
		expect(rendered).toContain('character.mara');
		expect(rendered).toContain('object.lantern');
		expect(
			packet.entityIndex.find((entry) => entry.entityKey === 'character.mara')?.factCount
		).toBe(1);
	});

	it('injects auto-search hits for the user message without a model tool call', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'autosearch', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				decisions: [
					{
						subject: 'caching',
						decision: 'Adopt a write-through redis cache for hot lookups.'
					}
				]
			}
		});

		const userMsg = messages.append(conv.id, {
			role: 'user',
			content: 'What did we decide about the redis cache?'
		});
		const prompt = buildPromptWithMemory({ conversationId: conv.id, mode: 'project', userMsg });
		expect(prompt).toContain('auto-retrieved for this turn');
		expect(prompt).toContain('redis cache');

		const packet = buildInitialPacket(conv.id, 'project', { query: 'redis cache' });
		expect(packet.autoSearchHits.length).toBeGreaterThan(0);
		expect(packet.autoSearchHits.map((hit) => hit.text).join('\n')).toContain('redis cache');
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

	it('always includes decisions and open loops regardless of token budget', () => {
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'continuity', workdir: '/tmp', model: null });
		commitPatch({
			conversationId: conv.id,
			patch: {
				decisions: [{ subject: 'engine', decision: 'Use a fresh context per request.' }],
				openLoops: [{ loopType: 'task', title: 'Wire up the salience ranker' }]
			}
		});

		const packet = buildInitialPacket(conv.id, 'project', { tokenBudget: 1 });
		expect(packet.decisions).toHaveLength(1);
		expect(packet.openLoops).toHaveLength(1);
		const rendered = renderMemoryPacket(packet);
		expect(rendered).toContain('Use a fresh context per request.');
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
				decisions: [{ subject: 'cache', decision: 'Adopt a redis write-through cache.' }]
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
});
