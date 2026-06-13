import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkdir } from '$lib/server/conversation-auth';
import { diff, GitError, type DiffTarget } from '$lib/server/git';

const VALID_TARGETS = new Set([
	'worktree-vs-head',
	'worktree-vs-index',
	'index-vs-head',
	'commit',
	'commit-vs-parent'
]);

const SHA_RE = /^[0-9a-f]{4,64}$/;

export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { workdir } = authorizeConversationWorkdir(params.id, locals.userId);
	const targetKind = url.searchParams.get('target') ?? 'worktree-vs-head';
	if (!VALID_TARGETS.has(targetKind)) throw error(400, 'invalid target');
	const sha = url.searchParams.get('sha') ?? '';
	const path = url.searchParams.get('path') ?? '';

	let target: DiffTarget;
	if (targetKind === 'commit' || targetKind === 'commit-vs-parent') {
		if (!sha) throw error(422, 'sha required for commit targets');
		if (!SHA_RE.test(sha)) throw error(400, 'invalid sha');
		target = { kind: targetKind, sha };
	} else {
		target = { kind: targetKind } as DiffTarget;
	}

	try {
		const out = await diff(workdir, target, path || undefined);
		return json({ diff: out });
	} catch (e) {
		if (e instanceof GitError) throw error(400, e.message);
		throw e;
	}
};
