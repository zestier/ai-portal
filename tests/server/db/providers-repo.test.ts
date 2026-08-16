// Repo round-trips for the portal-managed provider/model tables (migration 002).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { setupLocalEnv } from '../../helpers/env';
import * as providersRepo from '../../../src/lib/server/db/repos/providers';
import * as modelsRepo from '../../../src/lib/server/db/repos/models';

describe('providers repo', () => {
	beforeEach(async () => {
		await setupLocalEnv();
		process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
	});

	afterEach(() => {
		delete process.env.ENCRYPTION_KEY;
	});

	it('upserts and lists providers', () => {
		const p = providersRepo.upsert({
			id: 'ollama',
			name: 'Ollama',
			api: 'openai-completions',
			baseUrl: 'http://localhost:11434/v1',
			builtin: false,
			enabled: true
		});
		expect(p).toMatchObject({
			id: 'ollama',
			api: 'openai-completions',
			hasKey: false,
			enabled: true
		});

		const listed = providersRepo.list();
		expect(listed.map((x) => x.id)).toContain('ollama');
		expect(listed.find((x) => x.id === 'ollama')?.baseUrl).toBe('http://localhost:11434/v1');
	});

	it('stores keys encrypted and serves them decrypted; never leaks via list()', async () => {
		providersRepo.upsert({ id: 'anthropic', name: 'Anthropic', api: 'anthropic-messages' });
		providersRepo.setApiKey('anthropic', 'sk-ant-secret');
		expect(providersRepo.getApiKey('anthropic')).toBe('sk-ant-secret');
		expect(providersRepo.get('anthropic')?.hasKey).toBe(true);
		// The ciphertext in the DB is not the plaintext.
		const row = (
			(await import('../../../src/lib/server/db'))
				.getDb()
				.prepare('SELECT api_key_ct FROM providers WHERE id = ?')
				.get('anthropic') as { api_key_ct: Buffer }
		).api_key_ct;
		expect(row.toString('utf8')).not.toContain('sk-ant-secret');
		expect(row.length).toBeGreaterThan(0);

		providersRepo.clearApiKey('anthropic');
		expect(providersRepo.getApiKey('anthropic')).toBeNull();
		expect(providersRepo.get('anthropic')?.hasKey).toBe(false);
	});

	it('requires ENCRYPTION_KEY to store a key', async () => {
		delete process.env.ENCRYPTION_KEY;
		providersRepo.upsert({
			id: 'openai',
			name: 'OpenAI',
			api: 'openai-completions',
			baseUrl: 'https://api.openai.com/v1'
		});
		expect(() => providersRepo.setApiKey('openai', 'sk-x')).toThrow(/ENCRYPTION_KEY/);
	});

	it('deletes a provider and cascades to its models', () => {
		providersRepo.upsert({
			id: 'p1',
			name: 'P1',
			api: 'openai-completions',
			baseUrl: 'http://x/v1'
		});
		modelsRepo.upsert('p1', { id: 'm1', name: 'M1' });
		providersRepo.remove('p1');
		expect(providersRepo.get('p1')).toBeNull();
		expect(modelsRepo.list('p1')).toEqual([]);
	});
});

describe('models repo', () => {
	beforeEach(async () => {
		await setupLocalEnv();
	});

	it('round-trips full model metadata', () => {
		providersRepo.upsert({ id: 'anthropic', name: 'Anthropic', api: 'anthropic-messages' });
		const m = modelsRepo.upsert('anthropic', {
			id: 'claude-opus-4-5',
			name: 'Claude Opus 4.5',
			purpose: 'hard tasks',
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
			input: ['text', 'image'],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			thinkingLevelMap: { off: null, high: 'high' },
			compat: { supportsStrictTools: true }
		});
		expect(m).toMatchObject({
			providerId: 'anthropic',
			id: 'claude-opus-4-5',
			purpose: 'hard tasks',
			reasoning: true,
			contextWindow: 200_000,
			maxTokens: 64_000,
			input: ['text', 'image'],
			thinkingLevelMap: { off: null, high: 'high' },
			compat: { supportsStrictTools: true }
		});
		expect(m.cost).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 });
	});

	it('upsert preserves portal-only fields (purpose/enabled) when refreshed with metadata only', () => {
		providersRepo.upsert({
			id: 'openrouter',
			name: 'OpenRouter',
			api: 'openai-completions',
			baseUrl: 'https://openrouter.ai/api/v1'
		});
		modelsRepo.upsert('openrouter', {
			id: 'anthropic/claude-sonnet-4.5',
			name: 'Claude Sonnet 4.5',
			purpose: 'daily driver',
			enabled: true
		});
		// Simulates a catalog re-fetch that knows nothing about annotations.
		modelsRepo.upsert('openrouter', {
			id: 'anthropic/claude-sonnet-4.5',
			name: 'Claude Sonnet 4.5 (latest)',
			contextWindow: 200_000
		});
		const m = modelsRepo.get('openrouter', 'anthropic/claude-sonnet-4.5');
		expect(m?.purpose).toBe('daily driver');
		expect(m?.enabled).toBe(true);
		expect(m?.contextWindow).toBe(200_000);
		expect(m?.name).toBe('Claude Sonnet 4.5 (latest)');
	});

	it('toggles enabled and removes models', () => {
		providersRepo.upsert({
			id: 'openai',
			name: 'OpenAI',
			api: 'openai-completions',
			baseUrl: 'https://api.openai.com/v1'
		});
		modelsRepo.upsert('openai', { id: 'gpt-4o', name: 'GPT-4o' });
		modelsRepo.setEnabled('openai', 'gpt-4o', false);
		expect(modelsRepo.get('openai', 'gpt-4o')?.enabled).toBe(false);
		modelsRepo.remove('openai', 'gpt-4o');
		expect(modelsRepo.get('openai', 'gpt-4o')).toBeNull();
	});

	it('upsertMany inserts a batch', () => {
		providersRepo.upsert({
			id: 'ollama',
			name: 'Ollama',
			api: 'openai-completions',
			baseUrl: 'http://localhost:11434/v1'
		});
		const n = modelsRepo.upsertMany('ollama', [
			{ id: 'llama3.1:8b', name: 'Llama 3.1 8B' },
			{ id: 'qwen2.5-coder:7b', name: 'Qwen 2.5 Coder 7B' }
		]);
		expect(n).toBe(2);
		expect(modelsRepo.list('ollama').map((m) => m.id)).toEqual(['llama3.1:8b', 'qwen2.5-coder:7b']);
	});
});
