import { spawn } from 'node:child_process';
import type { AppConfig } from './config';
import { log } from './log';
import type { User } from '$lib/types';

export type Step = {
	label: string;
	command: string;
	args: string[];
	display: string;
	env?: NodeJS.ProcessEnv;
};

export type RedeployEvent =
	| { type: 'step'; label: string; cmd: string }
	| { type: 'log'; stream: 'stdout' | 'stderr'; text: string }
	| { type: 'step-done'; label: string; code: number }
	| { type: 'done'; ok: true; restarting: true }
	| { type: 'done'; ok: false; failedStep?: string; code?: number; message?: string };

const SENSITIVE_ENV_NAME = /(?:auth|credential|cookie|key|password|passwd|secret|token)/i;

export const PULL_STEPS: Step[] = [
	{
		label: 'git fetch',
		command: 'git',
		args: ['fetch', '--all', '--prune'],
		display: 'git fetch --all --prune'
	},
	{ label: 'git pull', command: 'git', args: ['pull', '--ff-only'], display: 'git pull --ff-only' },
	{
		label: 'pnpm install',
		command: 'pnpm',
		args: ['install', '--frozen-lockfile'],
		display: 'pnpm install --frozen-lockfile'
	}
];

export const BUILD_STEPS: Step[] = [
	{
		label: 'pnpm run verify',
		command: 'pnpm',
		args: ['run', 'verify'],
		display: 'pnpm run verify',
		// Run the full gate — including Playwright e2e — as a deliberate safety
		// net so a broken build never rolls over onto the live server. The live
		// portal is still serving while this runs, so E2E_ISOLATED makes
		// playwright.config.ts refuse to reuse/attach to the running server and
		// instead spin up its own throwaway server + DB, so the gate can't drive
		// or corrupt live state.
		env: { E2E_ISOLATED: '1' }
	}
];

export function canRedeployUser(user: User | null, cfg: AppConfig): boolean {
	if (!user) return false;
	if (cfg.AUTH_MODE !== 'github') return true;

	const login = user.githubLogin.toLowerCase();
	const adminLogins =
		cfg.REDEPLOY_ADMIN_GITHUB_LOGINS.length > 0
			? cfg.REDEPLOY_ADMIN_GITHUB_LOGINS
			: cfg.ALLOWED_GITHUB_LOGINS.length === 1
				? cfg.ALLOWED_GITHUB_LOGINS
				: [];
	return adminLogins.includes(login);
}

export function scrubRedeployLog(text: string, env: NodeJS.ProcessEnv = process.env): string {
	let scrubbed = text;
	for (const [name, value] of Object.entries(env)) {
		if (!value || value.length < 8 || !SENSITIVE_ENV_NAME.test(name)) continue;
		scrubbed = scrubbed.split(value).join(`[redacted:${name}]`);
	}
	return scrubbed
		.replace(/\bgh[psuor]_[A-Za-z0-9_]{20,}\b/g, '[redacted:github-token]')
		.replace(/\b(?:sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{20,}\b/g, '[redacted:api-key]')
		.replace(/\b((?:bearer|token)\s+)[A-Za-z0-9._~+/=-]{20,}/gi, '$1[redacted]');
}

export function runStep(step: Step, emit: (ev: RedeployEvent) => void): Promise<number> {
	return new Promise<number>((resolve) => {
		emit({ type: 'step', label: step.label, cmd: step.display });
		const p = spawn(step.command, step.args, {
			cwd: process.cwd(),
			env: { ...process.env, ...step.env },
			shell: false
		});
		p.stdout.on('data', (b: Buffer) =>
			emit({ type: 'log', stream: 'stdout', text: scrubRedeployLog(b.toString()) })
		);
		p.stderr.on('data', (b: Buffer) =>
			emit({ type: 'log', stream: 'stderr', text: scrubRedeployLog(b.toString()) })
		);
		p.on('error', (err) => {
			emit({
				type: 'log',
				stream: 'stderr',
				text: scrubRedeployLog(`spawn error: ${err.message}\n`)
			});
			resolve(1);
		});
		p.on('close', (code) => {
			emit({ type: 'step-done', label: step.label, code: code ?? 1 });
			resolve(code ?? 1);
		});
	});
}

export async function* runRedeploy(
	steps: Step[],
	runner: (step: Step, emit: (ev: RedeployEvent) => void) => Promise<number> = runStep
): AsyncGenerator<RedeployEvent> {
	const queue: RedeployEvent[] = [];
	let wake: (() => void) | null = null;
	const emit = (ev: RedeployEvent) => {
		queue.push(ev);
		wake?.();
	};

	try {
		let failedStep: string | undefined;
		let failedCode = 0;
		for (const step of steps) {
			const done = runner(step, emit);
			let code: number | undefined;
			done.then(
				(c) => {
					code = c;
					wake?.();
				},
				(err) => {
					emit({
						type: 'log',
						stream: 'stderr',
						text: scrubRedeployLog(`step error: ${String(err)}\n`)
					});
					code = 1;
					wake?.();
				}
			);
			while (code === undefined || queue.length > 0) {
				if (queue.length === 0) {
					await new Promise<void>((r) => {
						wake = r;
					});
					wake = null;
					continue;
				}
				yield queue.shift()!;
			}
			if (code !== 0) {
				failedStep = step.label;
				failedCode = code;
				log.warn('redeploy.failed', { step: step.label, code });
				break;
			}
		}
		if (failedStep) {
			yield { type: 'done', ok: false, failedStep, code: failedCode };
		} else {
			// Schedule the rollover exit BEFORE yielding `done`. The yield suspends
			// this generator until the consumer pulls again; if the client
			// disconnects in between, the SSE layer calls `.return()` and any code
			// after the yield never runs. Scheduling first makes the restart
			// unconditional — a successful build always rolls over, even if nobody
			// is listening for the final event.
			log.info('redeploy.ok.exiting');
			setTimeout(() => process.exit(0), 500).unref();
			yield { type: 'done', ok: true, restarting: true };
		}
	} catch (err) {
		const message = scrubRedeployLog(String(err));
		log.error('redeploy.crash', { err: message });
		yield { type: 'done', ok: false, message };
	}
}
