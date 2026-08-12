import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setupLocalEnv, resetServerSingletons } from './helpers/env';

describe('authorizeConversationWorkdir', () => {
	// Own PROJECT_ROOT so legacy-fold assertions don't couple to the host's
	// PROJECT_ROOT or the test process cwd (which differ in worktree sessions).
	let projectRoot: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-conversation-auth-');
		projectRoot = mkdtempSync(join(tmpdir(), 'portal-conv-auth-project-'));
		process.env.PROJECT_ROOT = projectRoot;
		await resetServerSingletons();
	});

	afterEach(() => {
		delete process.env.PROJECT_ROOT;
		rmSync(projectRoot, { recursive: true, force: true });
	});

	it('returns the authorized conversation and its resolved workdir', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const { authorizeConversationWorkdir } = await import('../src/lib/server/conversation-auth');

		const user = users.ensureLocalUser();
		const workdir = resolve('/tmp', 'portal-conversation-auth-workdir');
		mkdirSync(workdir, { recursive: true });
		// Allowlist the out-of-PROJECT_ROOT workdir so the read-boundary
		// containment check honors it rather than folding back to PROJECT_ROOT.
		process.env.ALLOWED_WORKDIRS = workdir;
		await resetServerSingletons();
		const conv = convs.create(user.id, { title: 't', workdir, model: null });

		const out = authorizeConversationWorkdir(String(conv.id), user.id);
		expect(out.conversation.id).toBe(conv.id);
		expect(out.workdir).toBe(workdir);
	});

	it('folds legacy stored workdirs back to PROJECT_ROOT', async () => {
		const users = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const { authorizeConversationWorkdir } = await import('../src/lib/server/conversation-auth');

		const user = users.ensureLocalUser();
		const legacy = resolve(process.env.DATA_DIR!, 'workspaces', 'legacy-conv');
		mkdirSync(legacy, { recursive: true });
		const conv = convs.create(user.id, { title: 'legacy', workdir: legacy, model: null });

		const out = authorizeConversationWorkdir(String(conv.id), user.id);
		expect(out.workdir).toBe(projectRoot);
	});
});
