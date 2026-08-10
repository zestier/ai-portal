import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig, resetConfigForTests } from '../src/lib/server/config';
import { claudeAgentProvider } from '../src/lib/server/providers/claude-agent-provider';
import { lmStudioProvider } from '../src/lib/server/providers/lm-studio-provider';
import * as settings from '../src/lib/server/db/repos/settings';
import * as tokens from '../src/lib/server/db/repos/tokens';
import { openAICompatibleProvider } from '../src/lib/server/providers/openai-compatible-provider';
import { providerAuthToken } from '../src/lib/server/providers/auth';
import { loadProviderStatus } from '../src/lib/server/providers/status';
import type { ProviderSession } from '../src/lib/server/providers/provider';
import {
	fetchAuthStatus,
	fetchModels,
	getDefaultProviderId,
	getProvider,
	listProviders,
	open
} from '../src/lib/server/providers';
import { setupLocalEnv } from './helpers/env';

beforeEach(async () => {
	await setupLocalEnv('portal-providers-test-');
	delete process.env.DEFAULT_BACKEND_PROVIDER;
	delete process.env.COPILOT_GITHUB_TOKEN;
	delete process.env.ZAP_PROVIDERS_JSON;
	resetConfigForTests();
});

afterEach(() => {
	delete process.env.DEFAULT_BACKEND_PROVIDER;
	delete process.env.COPILOT_GITHUB_TOKEN;
	delete process.env.ZAP_PROVIDERS_JSON;
	resetConfigForTests();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('provider registry', () => {
	it('lists and normalizes configured backend providers', () => {
		expect(listProviders().map((provider) => provider.id)).toEqual([
			'copilot',
			'claude-agent',
			'openai-compatible',
			'lm-studio'
		]);
		expect(getProvider('claude-agent')).toBe(claudeAgentProvider);
		expect(getProvider('openai-compatible')).toBe(openAICompatibleProvider);
		expect(getProvider('lm-studio')).toBe(lmStudioProvider);
		expect(getProvider('unknown').id).toBe('copilot');
		expect(getDefaultProviderId()).toBe('copilot');

		process.env.DEFAULT_BACKEND_PROVIDER = 'openai-compatible';
		resetConfigForTests();

		expect(getDefaultProviderId()).toBe('openai-compatible');
		expect(settings.defaults().defaultProvider).toBe('openai-compatible');

		process.env.DEFAULT_BACKEND_PROVIDER = 'lm-studio';
		resetConfigForTests();

		expect(getDefaultProviderId()).toBe('lm-studio');
		expect(settings.defaults().defaultProvider).toBe('lm-studio');
	});

	it('does not probe Copilot status when another provider is the default', async () => {
		const loader = {
			fetchAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true }),
			fetchModels: vi.fn().mockResolvedValue([])
		};
		const copilot = getProvider('copilot');

		await expect(
			loadProviderStatus(copilot, {
				userId: 'user-1',
				defaultProvider: 'openai-compatible',
				loader
			})
		).resolves.toMatchObject({
			id: 'copilot',
			statusChecked: false,
			auth: { isAuthenticated: false }
		});
		expect(loader.fetchAuthStatus).not.toHaveBeenCalled();
		expect(loader.fetchModels).not.toHaveBeenCalled();
	});

	it('does not probe LM Studio status unless it is the default provider', async () => {
		const loader = {
			fetchAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true }),
			fetchModels: vi.fn().mockResolvedValue([])
		};
		const lmStudio = getProvider('lm-studio');

		await expect(
			loadProviderStatus(lmStudio, {
				userId: 'user-1',
				defaultProvider: 'copilot',
				loader
			})
		).resolves.toMatchObject({
			id: 'lm-studio',
			statusChecked: false,
			auth: { isAuthenticated: false }
		});
		expect(loader.fetchAuthStatus).not.toHaveBeenCalled();
		expect(loader.fetchModels).not.toHaveBeenCalled();
	});

	it('keeps auth status when the model list probe fails', async () => {
		const loader = {
			fetchAuthStatus: vi.fn().mockResolvedValue({ isAuthenticated: true, authType: 'none' }),
			fetchModels: vi.fn().mockRejectedValue(new Error('models endpoint flaked'))
		};
		const lmStudio = getProvider('lm-studio');

		const snapshot = await loadProviderStatus(lmStudio, {
			userId: 'user-1',
			defaultProvider: 'lm-studio',
			loader
		});

		expect(snapshot.statusChecked).toBe(true);
		expect(snapshot.auth.isAuthenticated).toBe(true);
		expect(snapshot.models).toEqual([]);
		expect(snapshot.error).toContain('models');
		expect(snapshot.error).toContain('models endpoint flaked');
	});

	it('keeps the model list when the auth probe fails', async () => {
		const loader = {
			fetchAuthStatus: vi.fn().mockRejectedValue(new Error('auth flaked')),
			fetchModels: vi.fn().mockResolvedValue([{ id: 'm1', name: 'Model 1' }])
		};
		const lmStudio = getProvider('lm-studio');

		const snapshot = await loadProviderStatus(lmStudio, {
			userId: 'user-1',
			defaultProvider: 'lm-studio',
			loader
		});

		expect(snapshot.statusChecked).toBe(true);
		expect(snapshot.auth.isAuthenticated).toBe(false);
		expect(snapshot.models).toEqual([
			{ id: 'm1', name: 'Model 1', maxContextWindowTokens: undefined }
		]);
		expect(snapshot.error).toContain('auth');
	});

	it('resolves credentials only for providers that need them', () => {
		const tokenSpy = vi.spyOn(tokens, 'getGithubToken');
		process.env.COPILOT_GITHUB_TOKEN = 'fallback-token';
		resetConfigForTests();

		expect(providerAuthToken('openai-compatible', 'user-1')).toBeUndefined();
		expect(providerAuthToken('lm-studio', 'user-1')).toBeUndefined();
		expect(tokenSpy).not.toHaveBeenCalled();

		expect(providerAuthToken('copilot', 'user-1')).toBe('fallback-token');
		expect(tokenSpy).toHaveBeenCalledWith('user-1');
	});

	it('uses the configured default provider when repository callers omit one', async () => {
		process.env.DEFAULT_BACKEND_PROVIDER = 'openai-compatible';
		resetConfigForTests();
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');

		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'default provider', workdir: '/tmp', model: null });

		expect(conv.provider).toBe('openai-compatible');
	});

	it('lists ZAP_PROVIDERS_JSON instances after the built-ins, several of the same type', () => {
		process.env.ZAP_PROVIDERS_JSON = JSON.stringify([
			{
				id: 'proxy-a',
				type: 'claude-agent',
				label: 'Proxy A',
				baseUrl: 'https://a.example',
				apiKey: 'key-a',
				models: ['m-a1']
			},
			{
				id: 'proxy-b',
				type: 'claude-agent',
				label: 'Proxy B',
				baseUrl: 'https://b.example',
				apiKey: 'key-b',
				models: ['m-b1', 'm-b2']
			}
		]);
		resetConfigForTests();

		expect(listProviders().map((provider) => provider.id)).toEqual([
			'copilot',
			'claude-agent',
			'openai-compatible',
			'lm-studio',
			'proxy-a',
			'proxy-b'
		]);
		// Built-in instances still resolve to the module singletons...
		expect(getProvider('claude-agent')).toBe(claudeAgentProvider);
		expect(getProvider('copilot').id).toBe('copilot');
		// ...while JSON instances get per-instance objects with their own identity.
		expect(getProvider('proxy-a').id).toBe('proxy-a');
		expect(getProvider('proxy-a')).not.toBe(getProvider('proxy-b'));
		expect(getProvider('proxy-b').id).toBe('proxy-b');
		// A bare type id never collides with a same-type JSON instance.
		expect(getProvider('claude-agent').displayName).not.toContain('Proxy A');
	});

	it('resolves per-instance config: pinned models, discovery, endpoint, and key', async () => {
		process.env.ZAP_PROVIDERS_JSON = JSON.stringify([
			{
				id: 'proxy-a',
				type: 'claude-agent',
				label: 'Proxy A',
				baseUrl: 'https://a.example',
				apiKey: 'key-a',
				models: ['m-a1']
			},
			{
				id: 'proxy-b',
				type: 'claude-agent',
				label: 'Proxy B',
				baseUrl: 'https://b.example',
				apiKey: 'key-b'
			},
			{
				id: 'proxy-c',
				type: 'claude-agent',
				label: 'Proxy C',
				baseUrl: 'https://c.example'
			}
		]);
		resetConfigForTests();
		// Env key is set globally; JSON instances must not inherit it.
		process.env.CLAUDE_AGENT_API_KEY = 'env-key';
		process.env.CLAUDE_AGENT_BASE_URL = 'https://env.example';
		resetConfigForTests();
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ data: [{ id: 'discovered-1' }] }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		// Pinned models win over discovery (never touches the network).
		await expect(fetchModels('user-1', undefined, 'proxy-a')).resolves.toEqual([
			{ id: 'm-a1', name: 'm-a1' }
		]);
		// No pinned models → /models discovery against the instance's base URL.
		await expect(fetchModels('user-1', undefined, 'proxy-b')).resolves.toEqual([
			{ id: 'discovered-1', name: 'discovered-1' }
		]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0][0])).toBe('https://b.example/v1/models');
		// Auth reports the instance's own key/endpoint, not env.
		await expect(fetchAuthStatus('user-1', undefined, 'proxy-a')).resolves.toMatchObject({
			isAuthenticated: true,
			authType: 'api-key',
			statusMessage: 'https://a.example'
		});
		// A JSON instance with no apiKey is unauthenticated — it never inherits
		// the env key.
		await expect(fetchAuthStatus('user-1', undefined, 'proxy-c')).resolves.toMatchObject({
			isAuthenticated: false
		});
		// The env-fed built-in is untouched by JSON instances: it reads env, not
		// the proxy instances' keys/endpoints.
		await expect(fetchAuthStatus('user-1', undefined, 'claude-agent')).resolves.toMatchObject({
			isAuthenticated: true,
			authType: 'api-key',
			statusMessage: 'https://env.example'
		});
	});

	it('stores and reads back an instance id on conversations', async () => {
		process.env.ZAP_PROVIDERS_JSON = JSON.stringify([
			{
				id: 'proxy-a',
				type: 'openai-compatible',
				baseUrl: 'https://a.example',
				apiKey: 'key-a',
				models: ['m-a1']
			}
		]);
		resetConfigForTests();
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');

		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'proxy-a',
			workdir: '/tmp',
			model: 'm-a1',
			provider: 'proxy-a'
		});
		expect(conv.provider).toBe('proxy-a');
		expect(convs.get(conv.id, user.id)?.provider).toBe('proxy-a');
		// Unknown ids normalize to the default instance rather than throwing.
		process.env.DEFAULT_BACKEND_PROVIDER = 'openai-compatible';
		resetConfigForTests();
		const conv2 = convs.create(user.id, {
			title: 'unknown',
			workdir: '/tmp',
			model: null,
			provider: 'not-an-instance'
		});
		expect(conv2.provider).toBe('openai-compatible');
	});

	it('rejects invalid ZAP_PROVIDERS_JSON with the offending field named', () => {
		const expectConfigError = (json: string, needle: string) => {
			process.env.ZAP_PROVIDERS_JSON = json;
			resetConfigForTests();
			expect(() => loadConfig()).toThrow(needle);
		};

		expectConfigError('{', 'ZAP_PROVIDERS_JSON');
		expectConfigError(
			JSON.stringify([{ id: 'copilot', type: 'openai-compatible', baseUrl: 'https://a.example' }]),
			'ZAP_PROVIDERS_JSON.0.id'
		);
		expectConfigError(JSON.stringify([{ id: 'a', type: 'copilot' }]), 'ZAP_PROVIDERS_JSON.0.type');
		expectConfigError(
			JSON.stringify([{ id: 'a', type: 'claude-agent' }]),
			'ZAP_PROVIDERS_JSON.0.baseUrl'
		);
		expectConfigError(
			JSON.stringify([
				{ id: 'a', type: 'claude-agent', baseUrl: 'https://a.example' },
				{ id: 'a', type: 'openai-compatible', baseUrl: 'https://b.example' }
			]),
			'ZAP_PROVIDERS_JSON.1.id'
		);
	});

	it('delegates auth, model, and session calls to the requested provider', async () => {
		const session: ProviderSession = {
			provider: 'openai-compatible',
			conversationId: 'conv-provider',
			providerSessionId: 'conv-provider',
			workingDirectory: '/tmp',
			model: 'local-model',
			lastUsed: 1,
			send: async function* () {},
			abort: async () => {},
			dispose: async () => {}
		};
		const authSpy = vi
			.spyOn(openAICompatibleProvider, 'fetchAuthStatus')
			.mockResolvedValue({ isAuthenticated: true, authType: 'none' });
		const modelsSpy = vi
			.spyOn(openAICompatibleProvider, 'listModels')
			.mockResolvedValue([{ id: 'local-model', name: 'Local Model' }]);
		const openSpy = vi.spyOn(openAICompatibleProvider, 'openSession').mockResolvedValue(session);

		await expect(fetchAuthStatus('user-1', 'token', 'openai-compatible')).resolves.toEqual({
			isAuthenticated: true,
			authType: 'none'
		});
		await expect(fetchModels('user-1', 'token', 'openai-compatible')).resolves.toEqual([
			{ id: 'local-model', name: 'Local Model' }
		]);
		await expect(
			open({
				provider: 'openai-compatible',
				conversationId: 'conv-provider',
				userId: 'user-1',
				workingDirectory: '/tmp',
				model: 'local-model',
				policy: 'prompt'
			})
		).resolves.toBe(session);

		expect(authSpy).toHaveBeenCalledWith('user-1', 'token');
		expect(modelsSpy).toHaveBeenCalledWith('user-1', 'token');
		expect(openSpy).toHaveBeenCalledWith(
			expect.objectContaining({ provider: 'openai-compatible', conversationId: 'conv-provider' })
		);
	});
});
