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
	OpenAICompatibleMemoryExtractor
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
		expect(rendered).toContain('character.mara.location = the cellar');
		expect(rendered).toContain('lighting: Keep the candle lit.');
		expect(rendered).toContain('Find the attic key');
		expect(rendered).toContain('[related: character.mara]');

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
});
