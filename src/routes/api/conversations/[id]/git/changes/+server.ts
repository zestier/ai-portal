import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkspace, leaseIdFromUrl } from '$lib/server/conversation-auth';
import { status as gitStatus, isGitRepo, numstat, aggregateStatus } from '$lib/server/git';
import type { ChangeEntry } from '$lib/types';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { workdir } = authorizeConversationWorkspace(params.id, locals.userId, leaseIdFromUrl(url));
	if (!(await isGitRepo(workdir))) {
		return json({ initialized: false, entries: [] as ChangeEntry[] });
	}
	const raw = await gitStatus(workdir, { includeIgnored: false });
	const statsByPath = new Map<string, { added: number | null; removed: number | null }>();
	try {
		const ns = await numstat(workdir, { kind: 'worktree-vs-head' });
		for (const s of ns) statsByPath.set(s.path, { added: s.added, removed: s.removed });
	} catch {
		// Empty repo / no HEAD: skip line stats.
	}
	const entries: ChangeEntry[] = [];
	for (const e of raw) {
		const agg = aggregateStatus(e);
		if (!agg || agg === 'ignored') continue;
		const staged = e.index !== 'unmodified' && e.index !== 'untracked' && e.index !== 'ignored';
		const unstaged =
			e.worktree !== 'unmodified' && e.worktree !== 'untracked' && e.worktree !== 'ignored';
		const s = statsByPath.get(e.path);
		entries.push({
			path: e.path,
			origPath: e.origPath,
			status: agg,
			staged,
			unstaged: unstaged || e.worktree === 'untracked',
			added: s?.added ?? null,
			removed: s?.removed ?? null
		});
	}
	entries.sort((a, b) => a.path.localeCompare(b.path));
	return json({ initialized: true, entries });
};
