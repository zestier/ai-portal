import { describe, expect, it } from 'vitest';
import { isolatedChildEnv } from '../src/lib/server/child-env';

describe('isolatedChildEnv', () => {
	it('removes portal configuration while preserving ordinary process variables', () => {
		const env = isolatedChildEnv({
			PATH: '/usr/bin',
			CI: '1',
			DATA_DIR: '/live/data',
			DB_MIGRATIONS_DIR: '/live/migrations',
			ENCRYPTION_KEY: 'secret',
			COPILOT_GITHUB_TOKEN: 'token',
			PI_MODEL: 'deepseek/deepseek-v4-pro',
			DEEPSEEK_API_KEY: 'deepseek-secret'
		});

		expect(env).toEqual({ PATH: '/usr/bin', CI: '1' });
	});

	it('allows deliberate provider-specific child configuration', () => {
		const env = isolatedChildEnv(
			{ PATH: '/usr/bin', CLAUDE_AGENT_API_KEY: 'portal-key' },
			{ ANTHROPIC_API_KEY: 'child-key' }
		);

		expect(env).toEqual({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'child-key' });
	});
});
