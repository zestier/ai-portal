import { describe, expect, it } from 'vitest';
import { canRedeployUser, scrubRedeployLog } from '../src/lib/server/redeploy';
import type { AppConfig } from '../src/lib/server/config';
import type { User } from '../src/lib/types';

const baseCfg: AppConfig = {
	HOST: '127.0.0.1',
	PORT: 3000,
	DATA_DIR: './data',
	PROJECT_ROOT: process.cwd(),
	LOG_LEVEL: 'info',
	AUTH_MODE: 'github',
	SESSION_SECRET: 'x'.repeat(32),
	ENCRYPTION_KEY: undefined,
	I_KNOW_THIS_IS_LOCAL: false,
	GITHUB_CLIENT_ID: 'client',
	GITHUB_CLIENT_SECRET: 'secret',
	ALLOWED_GITHUB_LOGINS: ['alice', 'bob'],
	REDEPLOY_ADMIN_GITHUB_LOGINS: ['alice'],
	SHARED_SECRET: undefined,
	COPILOT_GITHUB_TOKEN: undefined,
	DEFAULT_BACKEND_PROVIDER: 'copilot',
	DEFAULT_MODEL: 'claude-sonnet-4.5',
	OPENAI_COMPATIBLE_BASE_URL: undefined,
	OPENAI_COMPATIBLE_API_KEY: undefined,
	OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS: 8,
	OPENAI_COMPATIBLE_CONTEXT_RESTORE_MESSAGES: 20,
	OPENAI_COMPATIBLE_TEMPERATURE: undefined,
	OPENAI_COMPATIBLE_TOP_P: undefined,
	OPENAI_COMPATIBLE_PRESENCE_PENALTY: undefined,
	OPENAI_COMPATIBLE_FREQUENCY_PENALTY: undefined,
	LMSTUDIO_BASE_URL: 'http://127.0.0.1:1234',
	LMSTUDIO_API_KEY: undefined,
	MEMORY_EXTRACTOR_BACKEND: 'heuristic',
	MEMORY_EXTRACTOR_MODEL: undefined,
	MEMORY_EXTRACTOR_TIMEOUT_MS: 20_000,
	MEMORY_EXTRACTOR_MAX_INPUT_CHARS: 12_000,
	MEMORY_EXTRACTOR_MAX_TOOL_ITERATIONS: 6,
	MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS: 60_000,
	IDLE_TIMEOUT_MIN: 15,
	MAX_CONCURRENT_SESSIONS: 4,
	ENABLE_REDEPLOY: true,
	COPILOT_STUB: false,
	DB_MIGRATIONS_DIR: undefined
};

function user(login: string): User {
	return { id: `user-${login}`, githubLogin: login, displayName: null, avatarUrl: null };
}

describe('redeploy authorization', () => {
	it('requires the GitHub user to be in the redeploy admin allowlist', () => {
		expect(canRedeployUser(user('alice'), baseCfg)).toBe(true);
		expect(canRedeployUser(user('bob'), baseCfg)).toBe(false);
	});

	it('defaults a single allowed GitHub login to redeploy admin', () => {
		const cfg = {
			...baseCfg,
			ALLOWED_GITHUB_LOGINS: ['alice'],
			REDEPLOY_ADMIN_GITHUB_LOGINS: []
		};
		expect(canRedeployUser(user('alice'), cfg)).toBe(true);
		expect(canRedeployUser(user('bob'), cfg)).toBe(false);
	});

	it('treats shared-secret and local modes as single-operator admin modes', () => {
		expect(canRedeployUser(user('local'), { ...baseCfg, AUTH_MODE: 'none' })).toBe(true);
		expect(canRedeployUser(user('operator'), { ...baseCfg, AUTH_MODE: 'shared-secret' })).toBe(
			true
		);
	});
});

describe('redeploy log scrubbing', () => {
	it('redacts sensitive env values and token-shaped strings from streamed logs', () => {
		const text =
			'SESSION_SECRET=super-secret-value\n' +
			'github token ghp_abcdefghijklmnopqrstuvwxyz\n' +
			'bearer Bearer abcdefghijklmnopqrstuvwxyz0123456789\n';
		const scrubbed = scrubRedeployLog(text, {
			SESSION_SECRET: 'super-secret-value',
			NORMAL_VALUE: 'leave-me-alone'
		});

		expect(scrubbed).not.toContain('super-secret-value');
		expect(scrubbed).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
		expect(scrubbed).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
		expect(scrubbed).toContain('[redacted:SESSION_SECRET]');
		expect(scrubbed).toContain('[redacted:github-token]');
		expect(scrubbed).toContain('Bearer [redacted]');
	});
});
