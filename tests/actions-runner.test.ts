import { afterEach, describe, expect, it, vi } from 'vitest';
import { execPath } from 'node:process';
import {
	buildActionEnv,
	runSequence,
	runStep,
	scrubLog,
	type ActionEvent,
	type Step
} from '../src/lib/server/actions/runner';

function nodeStep(label: string, script: string, extra: Partial<Step> = {}): Step {
	return {
		label,
		command: execPath,
		args: ['-e', script],
		display: `node -e ${label}`,
		...extra
	};
}

function logsOf(events: ActionEvent[]) {
	return events.filter((ev): ev is Extract<ActionEvent, { type: 'log' }> => ev.type === 'log');
}

describe('buildActionEnv (default-deny)', () => {
	it('passes a safe base (PATH) but withholds secrets the action did not allowlist', () => {
		const source = {
			PATH: '/usr/bin',
			HOME: '/home/x',
			COPILOT_GITHUB_TOKEN: 'ghp_secret',
			SESSION_SECRET: 'super-secret',
			VERCEL_TOKEN: 'vercel-value'
		};
		const env = buildActionEnv([], source);
		expect(env.PATH).toBe('/usr/bin');
		expect(env.HOME).toBe('/home/x');
		// Secrets are not copied into a default-deny child.
		expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
		expect(env.SESSION_SECRET).toBeUndefined();
		expect(env.VERCEL_TOKEN).toBeUndefined();
	});

	it('copies only the explicitly allowlisted names', () => {
		const source = { PATH: '/usr/bin', VERCEL_TOKEN: 'vercel-value', OTHER: 'nope' };
		const env = buildActionEnv(['VERCEL_TOKEN'], source);
		expect(env.VERCEL_TOKEN).toBe('vercel-value');
		expect(env.OTHER).toBeUndefined();
	});

	it('omits allowlisted names that are unset in the source', () => {
		const env = buildActionEnv(['NOT_SET'], { PATH: '/usr/bin' });
		expect('NOT_SET' in env).toBe(false);
	});

	it('drops the portal\u2019s own secret names even when allowlisted (defense-in-depth)', () => {
		const source = {
			PATH: '/usr/bin',
			VERCEL_TOKEN: 'vercel-value',
			SESSION_SECRET: 'portal-session',
			ENCRYPTION_KEY: 'portal-key',
			COPILOT_GITHUB_TOKEN: 'ghp_portal',
			GITHUB_CLIENT_SECRET: 'portal-oauth',
			SHARED_SECRET: 'portal-shared'
		};
		const env = buildActionEnv(
			[
				'VERCEL_TOKEN',
				'SESSION_SECRET',
				'ENCRYPTION_KEY',
				'COPILOT_GITHUB_TOKEN',
				'GITHUB_CLIENT_SECRET',
				'SHARED_SECRET'
			],
			source
		);
		// The legitimate project secret still comes through.
		expect(env.VERCEL_TOKEN).toBe('vercel-value');
		// None of the portal's own credentials are copied in.
		expect(env.SESSION_SECRET).toBeUndefined();
		expect(env.ENCRYPTION_KEY).toBeUndefined();
		expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
		expect(env.GITHUB_CLIENT_SECRET).toBeUndefined();
		expect(env.SHARED_SECRET).toBeUndefined();
	});
});

describe('runStep env model', () => {
	it('default-inherits process.env (built-in behavior) and merges step.env', async () => {
		const events: ActionEvent[] = [];
		const prev = process.env.ZAP_RUNNER_PROBE;
		process.env.ZAP_RUNNER_PROBE = 'inherited';
		try {
			const code = await runStep(
				nodeStep('inherit', 'process.stdout.write(process.env.ZAP_RUNNER_PROBE ?? "unset")'),
				(ev) => events.push(ev)
			);
			expect(code).toBe(0);
			expect(logsOf(events).some((ev) => ev.text.includes('inherited'))).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.ZAP_RUNNER_PROBE;
			else process.env.ZAP_RUNNER_PROBE = prev;
		}
	});

	it('inheritEnv:false gives the child EXACTLY step.env — a secret is not visible', async () => {
		const events: ActionEvent[] = [];
		const prev = process.env.ZAP_RUNNER_SECRET;
		process.env.ZAP_RUNNER_SECRET = 'leak-me';
		try {
			const code = await runStep(
				nodeStep(
					'deny',
					'process.stdout.write("[" + (process.env.ZAP_RUNNER_SECRET ?? "absent") + "]")',
					{ inheritEnv: false, env: { PATH: process.env.PATH } }
				),
				(ev) => events.push(ev)
			);
			expect(code).toBe(0);
			expect(logsOf(events).some((ev) => ev.text.includes('[absent]'))).toBe(true);
			expect(logsOf(events).every((ev) => !ev.text.includes('leak-me'))).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.ZAP_RUNNER_SECRET;
			else process.env.ZAP_RUNNER_SECRET = prev;
		}
	});
});

describe('runStep cwd selection', () => {
	it('runs in step.cwd when provided', async () => {
		const events: ActionEvent[] = [];
		const code = await runStep(
			nodeStep('cwd', 'process.stdout.write(process.cwd())', {
				cwd: '/tmp',
				inheritEnv: false,
				env: { PATH: process.env.PATH }
			}),
			(ev) => events.push(ev)
		);
		expect(code).toBe(0);
		// /tmp may resolve through a symlink (e.g. macOS); assert it ran somewhere
		// other than the portal source tree and contains "tmp".
		const out = logsOf(events)
			.map((ev) => ev.text)
			.join('');
		expect(out).toContain('tmp');
		expect(out).not.toBe(process.cwd());
	});

	it('defaults cwd to process.cwd() (built-in behavior)', async () => {
		const events: ActionEvent[] = [];
		await runStep(nodeStep('defaultcwd', 'process.stdout.write(process.cwd())'), (ev) =>
			events.push(ev)
		);
		const out = logsOf(events)
			.map((ev) => ev.text)
			.join('');
		// Compare against the SCRUBBED cwd: step output is passed through
		// `scrubLog`, which replaces any sensitive env-var value it finds. If the
		// checkout path happens to contain such a value (e.g. a CI/agent session id
		// used as the directory name), the raw cwd would never appear verbatim.
		// Scrubbing both sides keeps this asserting "ran in the default cwd"
		// without depending on what the path happens to spell.
		expect(out).toContain(scrubLog(process.cwd()));
	});
});

describe('runStep spawn error', () => {
	it('emits a single step-done with a non-zero code when the command does not exist', async () => {
		const events: ActionEvent[] = [];
		const code = await runStep(
			{
				label: 'missing',
				command: '/nonexistent/definitely-not-a-real-binary',
				args: [],
				display: 'missing',
				inheritEnv: false,
				env: { PATH: process.env.PATH }
			},
			(ev) => events.push(ev)
		);
		expect(code).not.toBe(0);
		const stepDones = events.filter((ev) => ev.type === 'step-done');
		expect(stepDones).toHaveLength(1);
		expect(events.at(-1)?.type).toBe('step-done');
		// The spawn error is surfaced as a scrubbed stderr log before the step-done.
		expect(logsOf(events).some((ev) => ev.text.includes('spawn error'))).toBe(true);
	});
});

describe('runStep kill-on-abort', () => {
	it('kills a long-running child when the signal aborts', async () => {
		const events: ActionEvent[] = [];
		const controller = new AbortController();
		const promise = runStep(
			nodeStep('sleep', 'setTimeout(() => process.exit(0), 60000)'),
			(ev) => events.push(ev),
			controller.signal
		);
		// Give the child a moment to spawn, then abort.
		await new Promise((r) => setTimeout(r, 100));
		controller.abort();
		const code = await promise;
		// SIGTERM-killed child resolves with a non-zero code (not 0).
		expect(code).not.toBe(0);
		expect(events.at(-1)?.type).toBe('step-done');
	});

	it('kills immediately if the signal is already aborted', async () => {
		const events: ActionEvent[] = [];
		const controller = new AbortController();
		controller.abort();
		const code = await runStep(
			nodeStep('preaborted', 'setTimeout(() => process.exit(0), 60000)'),
			(ev) => events.push(ev),
			controller.signal
		);
		expect(code).not.toBe(0);
	});

	it('escalates to SIGKILL when the child traps SIGTERM (cannot wedge the run)', async () => {
		const events: ActionEvent[] = [];
		const controller = new AbortController();
		const promise = runStep(
			nodeStep(
				'trap',
				// Ignore SIGTERM and stay alive; only a SIGKILL can stop this.
				'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 60000)'
			),
			(ev) => events.push(ev),
			controller.signal
		);
		await new Promise((r) => setTimeout(r, 100));
		controller.abort();
		const code = await promise;
		// Resolves (via the SIGKILL escalation), so the in-flight guard cannot wedge.
		expect(code).not.toBe(0);
		expect(events.at(-1)?.type).toBe('step-done');
	}, 10000);
});

describe('runSequence rollover', () => {
	afterEach(() => vi.restoreAllMocks());

	async function drain(steps: Step[], opts = {}): Promise<ActionEvent[]> {
		const events: ActionEvent[] = [];
		for await (const ev of runSequence(steps, opts)) events.push(ev);
		return events;
	}

	it('emits a plain ok done (no restart) when rollover is false', async () => {
		const events = await drain([nodeStep('ok', 'process.exit(0)')], { rollover: false });
		expect(events.at(-1)).toEqual({ type: 'done', ok: true });
	});

	it('does NOT schedule a process exit when rollover is false', async () => {
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
		await drain([nodeStep('ok', 'process.exit(0)')], { rollover: false });
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('schedules rollover and reports restarting when rollover is true', async () => {
		vi.spyOn(process, 'exit').mockImplementation((): never => undefined as never);
		const setTimeoutSpy = vi
			.spyOn(global, 'setTimeout')
			.mockImplementation((() => ({ unref: () => {} })) as unknown as typeof setTimeout);
		const events = await drain([nodeStep('ok', 'process.exit(0)')], { rollover: true });
		expect(events.at(-1)).toEqual({ type: 'done', ok: true, restarting: true });
		setTimeoutSpy.mockRestore();
	});

	it('stops at the first failing step and reports failedStep/code', async () => {
		const events = await drain(
			[
				nodeStep('first', 'process.exit(0)'),
				nodeStep('second', 'process.exit(2)'),
				nodeStep('third', 'process.exit(0)')
			],
			{ rollover: false }
		);
		const stepLabels = events
			.filter((ev) => ev.type === 'step')
			.map((ev) => (ev as { label: string }).label);
		expect(stepLabels).toEqual(['first', 'second']);
		expect(events.at(-1)).toEqual({ type: 'done', ok: false, failedStep: 'second', code: 2 });
	});
});

describe('scrubLog', () => {
	it('redacts sensitive env values and token-shaped strings', () => {
		const scrubbed = scrubLog('SECRET=super-secret-value ghp_abcdefghijklmnopqrstuvwxyz', {
			SESSION_SECRET: 'super-secret-value'
		});
		expect(scrubbed).not.toContain('super-secret-value');
		expect(scrubbed).toContain('[redacted:SESSION_SECRET]');
		expect(scrubbed).toContain('[redacted:github-token]');
	});
});
