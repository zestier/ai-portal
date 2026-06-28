import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfigForTests } from '../src/lib/server/config';
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
	resetConfigForTests();
});

afterEach(() => {
	delete process.env.DEFAULT_BACKEND_PROVIDER;
	delete process.env.COPILOT_GITHUB_TOKEN;
	resetConfigForTests();
	vi.restoreAllMocks();
});

describe('provider registry', () => {
	it('lists and normalizes configured backend providers', () => {
		expect(listProviders().map((provider) => provider.id)).toEqual([
			'copilot',
			'openai-compatible',
			'lm-studio'
		]);
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
