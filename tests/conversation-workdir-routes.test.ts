import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetServerSingletons, setupLocalEnv } from './helpers/env';

function git(args: string[], cwd: string) {
	execFileSync('git', args, { cwd, stdio: 'pipe' });
}

async function importRepos() {
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	return { users, convs };
}

function makeEvent(url: string, conversationId: string, userId: number) {
	return {
		params: { id: conversationId },
		locals: { userId },
		url: new URL(url)
	};
}

describe('conversation-scoped fs/git routes', () => {
	let projectRoot: string;
	let conversationRoot: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-conversation-routes-');
		projectRoot = mkdtempSync(join(tmpdir(), 'portal-project-root-'));
		conversationRoot = mkdtempSync(join(tmpdir(), 'portal-conversation-root-'));
		process.env.PROJECT_ROOT = projectRoot;
		// The conversation workdir lives outside PROJECT_ROOT here; allowlist it
		// so the read-boundary containment check honors it (mirrors an operator
		// who points conversations at a separate project tree).
		process.env.ALLOWED_WORKDIRS = `${projectRoot},${conversationRoot}`;
		await resetServerSingletons();
		vi.resetModules();
	});

	afterEach(() => {
		delete process.env.PROJECT_ROOT;
		delete process.env.ALLOWED_WORKDIRS;
		rmSync(projectRoot, { recursive: true, force: true });
		rmSync(conversationRoot, { recursive: true, force: true });
	});

	it('fs/file reads from the authorized conversation workdir, not PROJECT_ROOT', async () => {
		writeFileSync(join(projectRoot, 'shared.txt'), 'project-root copy\n');
		writeFileSync(join(conversationRoot, 'shared.txt'), 'conversation copy\n');

		const { users, convs } = await importRepos();
		const { GET } = await import('../src/routes/api/conversations/[id]/fs/file/+server');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'workdir',
			workdir: conversationRoot,
			model: null
		});

		const event = makeEvent(
			'http://localhost/api/conversations/test/fs/file?path=shared.txt',
			conv.id,
			user.id
		);
		const response = await GET(event as never);
		const body = await response.json();
		expect(body.file.content).toBe('conversation copy\n');
	});

	it('fs/tree lists the conversation workdir contents instead of PROJECT_ROOT', async () => {
		writeFileSync(join(projectRoot, 'project-only.txt'), 'project\n');
		writeFileSync(join(conversationRoot, 'conversation-only.txt'), 'conversation\n');
		mkdirSync(join(conversationRoot, 'nested'), { recursive: true });

		const { users, convs } = await importRepos();
		const { GET } = await import('../src/routes/api/conversations/[id]/fs/tree/+server');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'tree',
			workdir: conversationRoot,
			model: null
		});

		const event = makeEvent('http://localhost/api/conversations/test/fs/tree', conv.id, user.id);
		const response = await GET(event as never);
		const body = await response.json();
		const names = body.entries.map((entry: { name: string }) => entry.name);
		expect(names).toContain('conversation-only.txt');
		expect(names).toContain('nested');
		expect(names).not.toContain('project-only.txt');
	});

	it('git routes report status/log from the conversation repo, not PROJECT_ROOT', async () => {
		git(['init', '-q', '-b', 'main'], projectRoot);
		git(['config', 'user.email', 'project@example.com'], projectRoot);
		git(['config', 'user.name', 'Project'], projectRoot);
		writeFileSync(join(projectRoot, 'project.txt'), 'project\n');
		git(['add', '.'], projectRoot);
		git(['commit', '-q', '-m', 'project root commit'], projectRoot);

		git(['init', '-q', '-b', 'main'], conversationRoot);
		git(['config', 'user.email', 'conversation@example.com'], conversationRoot);
		git(['config', 'user.name', 'Conversation'], conversationRoot);
		writeFileSync(join(conversationRoot, 'conversation.txt'), 'one\n');
		git(['add', '.'], conversationRoot);
		git(['commit', '-q', '-m', 'conversation repo commit'], conversationRoot);
		writeFileSync(join(conversationRoot, 'conversation.txt'), 'one\ntwo\n');

		const { users, convs } = await importRepos();
		const { GET: getStatus } =
			await import('../src/routes/api/conversations/[id]/git/status/+server');
		const { GET: getLog } = await import('../src/routes/api/conversations/[id]/git/log/+server');
		const user = users.ensureLocalUser();
		const conv = convs.create(user.id, {
			title: 'git',
			workdir: conversationRoot,
			model: null
		});

		const statusEvent = makeEvent(
			'http://localhost/api/conversations/test/git/status',
			conv.id,
			user.id
		);
		const statusResponse = await getStatus(statusEvent as never);
		const statusBody = await statusResponse.json();
		expect(statusBody.status.initialized).toBe(true);
		expect(statusBody.status.dirtyCount).toBe(1);

		const logEvent = makeEvent(
			'http://localhost/api/conversations/test/git/log?limit=5',
			conv.id,
			user.id
		);
		const logResponse = await getLog(logEvent as never);
		const logBody = await logResponse.json();
		expect(logBody.initialized).toBe(true);
		expect(logBody.commits[0].subject).toBe('conversation repo commit');
	});
});
