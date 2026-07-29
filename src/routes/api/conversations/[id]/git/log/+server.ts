import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkspace, leaseIdFromUrl } from '$lib/server/conversation-auth';
import { log, isGitRepo, GitError } from '$lib/server/git';

// Coerce then clamp into range. Non-numeric/missing values fall back to the
// default; out-of-range numeric values clamp to the nearest bound (so e.g.
// limit=0 -> 1 and limit=500 -> 200 rather than silently snapping to the
// default), matching the prior Math.min/Math.max pagination semantics.
const limitSchema = z.coerce
	.number()
	.int()
	.catch(20)
	.transform((n) => Math.min(Math.max(n, 1), 200));
const skipSchema = z.coerce
	.number()
	.int()
	.catch(0)
	.transform((n) => Math.max(n, 0));

export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { workdir } = authorizeConversationWorkspace(params.id, locals.userId, leaseIdFromUrl(url));
	if (!(await isGitRepo(workdir))) return json({ initialized: false, commits: [] });
	const limit = limitSchema.parse(url.searchParams.get('limit') ?? '20');
	const skip = skipSchema.parse(url.searchParams.get('skip') ?? '0');
	try {
		const commits = await log(workdir, { limit, skip });
		return json({ initialized: true, commits });
	} catch (e) {
		if (e instanceof GitError) throw error(400, e.message);
		throw e;
	}
};
