import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupLocalEnv } from '../../helpers/env';

// End-to-end for `positionals: readable-paths`: the shell grant is resolved
// against the user's REAL fs grants, which live under a different `tool` and so
// only reach the matcher because the candidate pre-filter is widened for shell
// requests. A unit test of the matcher can't catch a regression in that SQL.

const CONVERSATION = 1;

async function matchShell(userId: number, command: string, roots: { ws: string }) {
	const settings = await import('../../../src/lib/server/db/repos/settings');
	const { parseShellCommand } = await import('../../../src/lib/server/permissions/shell-parser');
	const parsed = parseShellCommand(command);
	if (parsed.kind !== 'parsed') throw new Error(`parse failed for ${command}`);
	return settings.matchGrant(userId, CONVERSATION, 'shell', 'shell', command, {
		shellSegments: parsed.segments,
		workspaceRoots: [roots.ws],
		sessionWorkspaceRoot: roots.ws
	});
}

describe('shell grants that defer their positionals to the fs grants', () => {
	let userId: number;
	let base: string;
	let ws: string;
	let corpus: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-shell-fs-deferred-');
		const users = await import('../../../src/lib/server/db/repos/users');
		userId = users.ensureLocalUser().id;

		base = realpathSync(mkdtempSync(join(tmpdir(), 'portal-shell-fs-deferred-ws-')));
		ws = join(base, 'ws');
		corpus = join(base, 'corpus');
		mkdirSync(ws);
		mkdirSync(corpus);
		writeFileSync(join(corpus, 'a.txt'), 'x');

		const settings = await import('../../../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scope: {
				kind: 'shell',
				rule: { command: [{ token: 'dumpfile' }], positionals: { kind: 'readable-paths' } }
			},
			decision: 'allow'
		});
	});

	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it('prompts for an out-of-workspace path until the user grants read on it', async () => {
		const target = join(corpus, 'a.txt');
		expect(await matchShell(userId, `dumpfile ${target}`, { ws })).toBe('none');

		const settings = await import('../../../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId,
			conversationId: null,
			tool: 'read',
			permissionKind: 'read',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'absolute', behavior: 'prefix', value: corpus }
			},
			decision: 'allow'
		});

		// The payoff: one fs grant now covers `view` AND the seeded shell reader,
		// with no shell-side path mirrored into the grant.
		expect(await matchShell(userId, `dumpfile ${target}`, { ws })).toBe('allow');
		expect(
			settings.matchGrant(userId, CONVERSATION, 'read', 'read', target, {
				target,
				workspaceRoots: [ws],
				sessionWorkspaceRoot: ws
			})
		).toBe('allow');
	});

	it('does not let a write grant answer a read question', async () => {
		const target = join(corpus, 'a.txt');
		const settings = await import('../../../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId,
			conversationId: null,
			tool: 'write',
			permissionKind: 'write',
			scope: {
				kind: 'fs',
				perms: ['write'],
				rule: { kind: 'path', root: 'absolute', behavior: 'prefix', value: corpus }
			},
			decision: 'allow'
		});
		expect(await matchShell(userId, `dumpfile ${target}`, { ws })).toBe('none');
	});
});
