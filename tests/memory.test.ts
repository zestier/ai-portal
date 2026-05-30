import { beforeEach, describe, expect, it } from 'vitest';
import * as users from '../src/lib/server/db/repos/users';
import * as convs from '../src/lib/server/db/repos/conversations';
import * as messages from '../src/lib/server/db/repos/messages';
import * as memory from '../src/lib/server/db/repos/memory';
import {
	buildInitialPacket,
	buildPromptWithMemory,
	commitPatch,
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
});
