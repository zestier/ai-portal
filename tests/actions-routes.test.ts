import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';
import { resetServerSingletons, setupLocalEnv } from './helpers/env';

async function importRepos() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	return { users, convs };
}

type EventOverrides = { request?: Request };

function makeEvent(
	url: string,
	params: Record<string, string>,
	userId: string,
	user: unknown,
	overrides: EventOverrides = {}
) {
	return {
		params,
		locals: { userId, user },
		url: new URL(url),
		request: overrides.request ?? new Request(url, { method: 'POST' }),
		getClientAddress: () => '127.0.0.1'
	};
}

async function readSse(res: Response): Promise<Record<string, unknown>[]> {
	const text = await res.text();
	const events: Record<string, unknown>[] = [];
	for (const block of text.split('\n\n')) {
		const dataLines = block
			.split('\n')
			.filter((l) => l.startsWith('data:'))
			.map((l) => l.slice(5).trimStart());
		if (dataLines.length === 0) continue;
		try {
			events.push(JSON.parse(dataLines.join('\n')));
		} catch {
			// skip non-JSON frames
		}
	}
	return events;
}

function writeActions(dir: string, config: unknown) {
	mkdirSync(join(dir, '.zap'), { recursive: true });
	writeFileSync(join(dir, '.zap', 'actions.json'), JSON.stringify(config));
}

describe('conversation actions routes (local mode)', () => {
	let projectRoot: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-actions-routes-');
		projectRoot = mkdtempSync(join(tmpdir(), 'portal-actions-project-'));
		process.env.PROJECT_ROOT = projectRoot;
		process.env.ALLOWED_WORKDIRS = projectRoot;
		await resetServerSingletons();
		vi.resetModules();
	});

	afterEach(() => {
		delete process.env.PROJECT_ROOT;
		delete process.env.ALLOWED_WORKDIRS;
		rmSync(projectRoot, { recursive: true, force: true });
	});

	async function makeConversation(workdir = projectRoot) {
		const { users, convs } = await importRepos();
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, { title: 'actions', workdir, model: null });
		return { user, conv };
	}

	it('GET lists actions from the conversation .zap/actions.json', async () => {
		writeActions(projectRoot, {
			version: 1,
			actions: [
				{
					id: 'lint',
					label: 'Lint',
					description: 'run lint',
					steps: [{ command: 'pnpm', args: ['lint'] }]
				}
			]
		});
		const { GET } = await import('../src/routes/api/conversations/[id]/actions/+server');
		const { user, conv } = await makeConversation();
		const res = await GET(
			makeEvent(
				'http://localhost/api/conversations/x/actions',
				{ id: conv.id },
				user.id,
				user
			) as never
		);
		const body = await res.json();
		expect(body.actions).toHaveLength(1);
		expect(body.actions[0]).toMatchObject({ id: 'lint', label: 'Lint', permission: 'user' });
		expect(body.actions[0].commands).toEqual(['pnpm lint']);
		expect(body.canRunAdmin).toBe(true); // local mode => single operator is admin
	});

	it('GET surfaces a config error for an invalid file', async () => {
		writeActions(projectRoot, { version: 9, actions: [] });
		const { GET } = await import('../src/routes/api/conversations/[id]/actions/+server');
		const { user, conv } = await makeConversation();
		const res = await GET(
			makeEvent(
				'http://localhost/api/conversations/x/actions',
				{ id: conv.id },
				user.id,
				user
			) as never
		);
		const body = await res.json();
		expect(body.actions).toEqual([]);
		expect(body.configError).toBeTruthy();
	});

	it('POST runs an action and streams a successful done event', async () => {
		writeActions(projectRoot, {
			version: 1,
			actions: [
				{
					id: 'echo',
					label: 'Echo',
					steps: [{ command: execPath, args: ['-e', 'process.stdout.write("hello-action")'] }]
				}
			]
		});
		const { POST } =
			await import('../src/routes/api/conversations/[id]/actions/[actionId]/+server');
		const { user, conv } = await makeConversation();
		const res = await POST(
			makeEvent(
				`http://localhost/api/conversations/${conv.id}/actions/echo`,
				{ id: conv.id, actionId: 'echo' },
				user.id,
				user
			) as never
		);
		const events = await readSse(res);
		const logs = events.filter((e) => e.type === 'log');
		expect(logs.some((e) => String(e.text).includes('hello-action'))).toBe(true);
		expect(events.at(-1)).toEqual({ type: 'done', ok: true });
	});

	it('POST runs with cwd = the conversation workdir, not PROJECT_ROOT', async () => {
		const otherWorkdir = mkdtempSync(join(tmpdir(), 'portal-actions-other-'));
		process.env.ALLOWED_WORKDIRS = `${projectRoot},${otherWorkdir}`;
		await resetServerSingletons();
		try {
			writeActions(otherWorkdir, {
				version: 1,
				actions: [
					{
						id: 'pwd',
						label: 'Pwd',
						steps: [{ command: execPath, args: ['-e', 'process.stdout.write(process.cwd())'] }]
					}
				]
			});
			const { POST } =
				await import('../src/routes/api/conversations/[id]/actions/[actionId]/+server');
			const { user, conv } = await makeConversation(otherWorkdir);
			const res = await POST(
				makeEvent(
					`http://localhost/api/conversations/${conv.id}/actions/pwd`,
					{ id: conv.id, actionId: 'pwd' },
					user.id,
					user
				) as never
			);
			const events = await readSse(res);
			const out = events
				.filter((e) => e.type === 'log')
				.map((e) => String(e.text))
				.join('');
			// realpath the workdir (tmpdir may be symlinked) by asserting the base name is present.
			expect(out).toContain(otherWorkdir.split('/').pop()!);
		} finally {
			rmSync(otherWorkdir, { recursive: true, force: true });
		}
	});

	it('POST substitutes typed inputs into argv and validates them', async () => {
		writeActions(projectRoot, {
			version: 1,
			actions: [
				{
					id: 'greet',
					label: 'Greet',
					inputs: [
						{ name: 'who', label: 'Who', type: 'string' },
						{ name: 'env', label: 'Env', type: 'enum', options: ['staging', 'prod'] }
					],
					steps: [
						{
							command: execPath,
							args: [
								'-e',
								'process.stdout.write(process.argv.slice(1).join("|"))',
								'{{who}}',
								'{{env}}'
							]
						}
					]
				}
			]
		});
		const { POST } =
			await import('../src/routes/api/conversations/[id]/actions/[actionId]/+server');
		const { user, conv } = await makeConversation();

		// Valid inputs are substituted into argv (as whole literals).
		const okRes = await POST(
			makeEvent(
				`http://localhost/api/conversations/${conv.id}/actions/greet`,
				{ id: conv.id, actionId: 'greet' },
				user.id,
				user,
				{
					request: new Request('http://localhost/x', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ inputs: { who: 'a b', env: 'prod' } })
					})
				}
			) as never
		);
		const out = (await readSse(okRes))
			.filter((e) => e.type === 'log')
			.map((e) => String(e.text))
			.join('');
		expect(out).toContain('a b|prod');

		// An out-of-enum value is rejected with 400 before anything runs.
		await expect(
			POST(
				makeEvent(
					`http://localhost/api/conversations/${conv.id}/actions/greet`,
					{ id: conv.id, actionId: 'greet' },
					user.id,
					user,
					{
						request: new Request('http://localhost/x', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ inputs: { who: 'x', env: 'dev' } })
						})
					}
				) as never
			)
		).rejects.toMatchObject({ status: 400 });
	});

	it('POST 404s an unknown action id', async () => {
		writeActions(projectRoot, { version: 1, actions: [] });
		const { POST } =
			await import('../src/routes/api/conversations/[id]/actions/[actionId]/+server');
		const { user, conv } = await makeConversation();
		await expect(
			POST(
				makeEvent(
					`http://localhost/api/conversations/${conv.id}/actions/nope`,
					{ id: conv.id, actionId: 'nope' },
					user.id,
					user
				) as never
			)
		).rejects.toMatchObject({ status: 404 });
	});

	it('POST rejects a concurrent run of the same action with 409', async () => {
		writeActions(projectRoot, {
			version: 1,
			actions: [
				{
					id: 'slow',
					label: 'Slow',
					steps: [{ command: execPath, args: ['-e', 'setTimeout(() => process.exit(0), 4000)'] }]
				}
			]
		});
		const { POST } =
			await import('../src/routes/api/conversations/[id]/actions/[actionId]/+server');
		const { user, conv } = await makeConversation();
		const ctrl = new AbortController();
		const firstReq = new Request(`http://localhost/x`, { method: 'POST', signal: ctrl.signal });
		const firstRes = await POST(
			makeEvent(
				`http://localhost/api/conversations/${conv.id}/actions/slow`,
				{ id: conv.id, actionId: 'slow' },
				user.id,
				user,
				{ request: firstReq }
			) as never
		);
		// While the first run holds the per-action guard, a second run is rejected.
		await expect(
			POST(
				makeEvent(
					`http://localhost/api/conversations/${conv.id}/actions/slow`,
					{ id: conv.id, actionId: 'slow' },
					user.id,
					user
				) as never
			)
		).rejects.toMatchObject({ status: 409 });

		// Abort the first to kill its child and release the guard, then drain.
		ctrl.abort();
		await readSse(firstRes);
	});
});

describe('conversation actions routes (github admin gating)', () => {
	let projectRoot: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-actions-admin-');
		projectRoot = mkdtempSync(join(tmpdir(), 'portal-actions-admin-project-'));
		process.env.PROJECT_ROOT = projectRoot;
		process.env.ALLOWED_WORKDIRS = projectRoot;
		// Multi-user GitHub mode where the acting user is NOT a redeploy admin.
		process.env.AUTH_MODE = 'github';
		process.env.GITHUB_CLIENT_ID = 'client';
		process.env.GITHUB_CLIENT_SECRET = 'secret';
		process.env.ALLOWED_GITHUB_LOGINS = 'adminuser,regularuser';
		process.env.REDEPLOY_ADMIN_GITHUB_LOGINS = 'adminuser';
		process.env.SESSION_SECRET = 'x'.repeat(40);
		process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
		process.env.ENABLE_REDEPLOY = '1';
		delete process.env.I_KNOW_THIS_IS_LOCAL;
		await resetServerSingletons();
		vi.resetModules();
	});

	afterEach(() => {
		for (const k of [
			'PROJECT_ROOT',
			'ALLOWED_WORKDIRS',
			'AUTH_MODE',
			'GITHUB_CLIENT_ID',
			'GITHUB_CLIENT_SECRET',
			'ALLOWED_GITHUB_LOGINS',
			'REDEPLOY_ADMIN_GITHUB_LOGINS',
			'SESSION_SECRET',
			'ENCRYPTION_KEY',
			'ENABLE_REDEPLOY'
		]) {
			delete process.env[k];
		}
		rmSync(projectRoot, { recursive: true, force: true });
	});

	it('denies an admin-permission action to a non-admin user (403)', async () => {
		writeActions(projectRoot, {
			version: 1,
			actions: [
				{
					id: 'danger',
					label: 'Danger',
					permission: 'admin',
					steps: [{ command: execPath, args: ['-e', 'process.exit(0)'] }]
				}
			]
		});
		const { users, convs } = await importRepos();
		const user = users.upsertGithub({
			githubId: 42,
			githubLogin: 'regularuser',
			displayName: 'Regular',
			avatarUrl: null
		});
		const conv = convs.create(user.id, { title: 'a', workdir: projectRoot, model: null });
		const { POST } =
			await import('../src/routes/api/conversations/[id]/actions/[actionId]/+server');
		await expect(
			POST(
				makeEvent(
					`http://localhost/api/conversations/${conv.id}/actions/danger`,
					{ id: conv.id, actionId: 'danger' },
					user.id,
					user
				) as never
			)
		).rejects.toMatchObject({ status: 403 });
	});
});
