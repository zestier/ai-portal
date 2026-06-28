import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupLocalEnv, resetServerSingletons } from './helpers/env';

describe('authorizeConversationWorkdir', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-conversation-auth-');
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

		const out = authorizeConversationWorkdir(conv.id, user.id);
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

		const out = authorizeConversationWorkdir(conv.id, user.id);
		expect(out.workdir).toBe(resolve(process.cwd()));
	});
});
