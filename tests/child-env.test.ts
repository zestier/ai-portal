import { describe, expect, it } from 'vitest';
import { isolatedChildEnv } from '../src/lib/server/child-env';

describe('isolatedChildEnv', () => {
	it('copies only safe process plumbing and drops unknown values by default', () => {
		const env = isolatedChildEnv({
			PATH: '/usr/bin',
			CI: '1',
			SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
			HTTPS_PROXY: 'http://proxy.internal:8080',
			ARBITRARY_PROJECT_VALUE: 'nope',
			DATA_DIR: '/live/data',
			DB_MIGRATIONS_DIR: '/live/migrations',
			ENCRYPTION_KEY: 'secret',
			COPILOT_GITHUB_TOKEN: 'token',
			PI_MODEL: 'deepseek/deepseek-v4-pro',
			DEEPSEEK_API_KEY: 'deepseek-secret'
		});

		expect(env).toEqual({
			PATH: '/usr/bin',
			CI: '1',
			SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
			HTTPS_PROXY: 'http://proxy.internal:8080'
		});
	});

	it('allows deliberate provider-specific child configuration', () => {
		const env = isolatedChildEnv(
			{ PATH: '/usr/bin', CLAUDE_AGENT_API_KEY: 'portal-key' },
			{ ANTHROPIC_API_KEY: 'child-key' }
		);

		expect(env).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'child-key' });
	});
});
