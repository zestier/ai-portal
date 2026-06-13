import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkdir } from '$lib/server/conversation-auth';
import { readFileSafe } from '$lib/server/files';
import { showFile, GitError } from '$lib/server/git';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { workdir } = authorizeConversationWorkdir(params.id, locals.userId);
	const relPath = url.searchParams.get('path');
	if (!relPath) throw error(400, 'path is required');
	const ref = url.searchParams.get('ref');
	if (ref && ref.length > 200) throw error(400, 'ref is too long');

	if (ref) {
		try {
			const content = await showFile(workdir, ref, relPath);
			let binary = false;
			for (let i = 0; i < Math.min(content.length, 8192); i++) {
				if (content.charCodeAt(i) === 0) {
					binary = true;
					break;
				}
			}
			if (binary) return json({ file: { binary: true, ref, path: relPath } });
			return json({
				file: {
					binary: false,
					ref,
					path: relPath,
					content,
					size: Buffer.byteLength(content, 'utf-8'),
					truncated: false
				}
			});
		} catch (e) {
			if (e instanceof GitError) throw error(404, e.message);
			throw e;
		}
	}

	const r = await readFileSafe(workdir, relPath);
	if (!r.ok) throw error(r.status ?? 400, r.reason);
	if (r.binary) return json({ file: { binary: true, path: relPath, size: r.size } });
	return json({
		file: {
			binary: false,
			path: relPath,
			content: r.content,
			size: r.size,
			truncated: r.truncated
		}
	});
};
