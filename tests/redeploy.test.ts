import { afterEach, describe, expect, it, vi } from 'vitest';
import { execPath } from 'node:process';
import {
	canRedeployUser,
	runRedeploy,
	runStep,
	scrubRedeployLog,
	type RedeployEvent,
	type Step
} from '../src/lib/server/redeploy';
import type { AppConfig } from '../src/lib/server/config';
import type { User } from '../src/lib/types';

function nodeStep(label: string, script: string): Step {
	return { label, command: execPath, args: ['-e', script], display: `node -e ${label}` };
}

const baseCfg: AppConfig = {
	HOST: '127.0.0.1',
	PORT: 3000,
	DATA_DIR: './data',
	PROJECT_ROOT: process.cwd(),
	LOG_LEVEL: 'info',
	AUTH_MODE: 'github',
	SESSION_SECRET: 'x'.repeat(32),
	SESSION_TTL_SECONDS: 60 * 60 * 24 * 30,
	ENCRYPTION_KEY: undefined,
	I_KNOW_THIS_IS_LOCAL: false,
	I_KNOW_THIS_IS_NETWORK_ACCESSIBLE: false,
	GITHUB_CLIENT_ID: 'client',
	GITHUB_CLIENT_SECRET: 'secret',
	ALLOWED_GITHUB_LOGINS: ['alice', 'bob'],
	REDEPLOY_ADMIN_GITHUB_LOGINS: ['alice'],
	SHARED_SECRET: undefined,
	COPILOT_GITHUB_TOKEN: undefined,
	COPILOT_CONTEXT_TIER: 'default',
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
	MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS: 15_000,
	MEMORY_EXTRACTOR_TOOL_CHOICE: 'auto',
	MEMORY_EXTRACTOR_MAX_FAILED_CALL_NUDGES: 2,
	MEMORY_OPEN_LOOP_MAX_IDLE_TURNS: 6,
	MEMORY_LOG_RETENTION_MAX_EVENTS: 5000,
	MEMORY_MAINTENANCE_INTERVAL_MIN: 720,
	IDLE_TIMEOUT_MIN: 15,
	MAX_CONCURRENT_SESSIONS: 4,
	TURN_ABORT_FINALIZE_DEADLINE_MS: 5_000,
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

describe('runStep', () => {
	it('resolves 0 and emits step then step-done on success', async () => {
		const events: RedeployEvent[] = [];
		const code = await runStep(nodeStep('ok', 'process.exit(0)'), (ev) => events.push(ev));

		expect(code).toBe(0);
		expect(events[0]).toEqual({ type: 'step', label: 'ok', cmd: 'node -e ok' });
		const done = events.at(-1);
		expect(done).toEqual({ type: 'step-done', label: 'ok', code: 0 });
	});

	it('propagates a non-zero exit code', async () => {
		const events: RedeployEvent[] = [];
		const code = await runStep(nodeStep('boom', 'process.exit(3)'), (ev) => events.push(ev));

		expect(code).toBe(3);
		expect(events.at(-1)).toEqual({ type: 'step-done', label: 'boom', code: 3 });
	});

	it('streams stdout/stderr output as scrubbed log events', async () => {
		const events: RedeployEvent[] = [];
		const code = await runStep(
			nodeStep('chatter', 'process.stdout.write("hello-out");process.stderr.write("hello-err")'),
			(ev) => events.push(ev)
		);

		expect(code).toBe(0);
		const logs = events.filter(
			(ev): ev is Extract<RedeployEvent, { type: 'log' }> => ev.type === 'log'
		);
		expect(logs.some((ev) => ev.stream === 'stdout' && ev.text.includes('hello-out'))).toBe(true);
		expect(logs.some((ev) => ev.stream === 'stderr' && ev.text.includes('hello-err'))).toBe(true);
	});

	it('resolves 1 and emits a spawn-error log when the command cannot be spawned', async () => {
		const events: RedeployEvent[] = [];
		const code = await runStep(
			{
				label: 'missing',
				command: '/nonexistent/definitely-not-a-real-binary-xyz',
				args: [],
				display: 'missing-binary'
			},
			(ev) => events.push(ev)
		);

		expect(code).toBe(1);
		expect(events[0]).toEqual({ type: 'step', label: 'missing', cmd: 'missing-binary' });
		const errLog = events.find(
			(ev): ev is Extract<RedeployEvent, { type: 'log' }> =>
				ev.type === 'log' && ev.stream === 'stderr' && ev.text.includes('spawn error')
		);
		expect(errLog).toBeDefined();
	});
});

describe('runRedeploy', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function drain(steps: Step[]): Promise<RedeployEvent[]> {
		const events: RedeployEvent[] = [];
		for await (const ev of runRedeploy(steps)) {
			events.push(ev);
		}
		return events;
	}

	it('runs every step and emits a restarting done event on full success', async () => {
		// Success triggers a deferred process.exit(0); stub it so the test runner survives.
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
		const setTimeoutSpy = vi
			.spyOn(global, 'setTimeout')
			.mockImplementation((() => ({ unref: () => {} })) as unknown as typeof setTimeout);

		const events = await drain([
			nodeStep('first', 'process.exit(0)'),
			nodeStep('second', 'process.exit(0)')
		]);

		const steps = events
			.filter((ev) => ev.type === 'step')
			.map((ev) => (ev as { label: string }).label);
		expect(steps).toEqual(['first', 'second']);
		expect(events.at(-1)).toEqual({ type: 'done', ok: true, restarting: true });

		setTimeoutSpy.mockRestore();
		exitSpy.mockRestore();
	});

	it('stops at the first failing step and reports failedStep/code', async () => {
		const events = await drain([
			nodeStep('first', 'process.exit(0)'),
			nodeStep('second', 'process.exit(2)'),
			nodeStep('third', 'process.exit(0)')
		]);

		const stepLabels = events
			.filter((ev) => ev.type === 'step')
			.map((ev) => (ev as { label: string }).label);
		// third must never start once second fails (break semantics).
		expect(stepLabels).toEqual(['first', 'second']);
		expect(events.at(-1)).toEqual({ type: 'done', ok: false, failedStep: 'second', code: 2 });
	});

	it('preserves event ordering: step before its step-done, across steps', async () => {
		const events = await drain([
			nodeStep('first', 'process.exit(0)'),
			nodeStep('second', 'process.exit(5)')
		]);

		const firstStep = events.findIndex((ev) => ev.type === 'step' && ev.label === 'first');
		const firstDone = events.findIndex((ev) => ev.type === 'step-done' && ev.label === 'first');
		const secondStep = events.findIndex((ev) => ev.type === 'step' && ev.label === 'second');
		const secondDone = events.findIndex((ev) => ev.type === 'step-done' && ev.label === 'second');

		expect(firstStep).toBeGreaterThanOrEqual(0);
		expect(firstStep).toBeLessThan(firstDone);
		expect(firstDone).toBeLessThan(secondStep);
		expect(secondStep).toBeLessThan(secondDone);
	});

	it('drains queued log events emitted during a step', async () => {
		const events = await drain([
			nodeStep('noisy', 'process.stdout.write("queued-output");process.exit(1)')
		]);

		const logs = events.filter(
			(ev): ev is Extract<RedeployEvent, { type: 'log' }> => ev.type === 'log'
		);
		expect(logs.some((ev) => ev.text.includes('queued-output'))).toBe(true);
		expect(events.at(-1)).toEqual({ type: 'done', ok: false, failedStep: 'noisy', code: 1 });
	});
});
