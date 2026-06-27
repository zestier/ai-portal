import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeConversationWorkdir } from '$lib/server/conversation-auth';
import { readFileSafe, readImageFileSafe } from '$lib/server/files';
import { showFile, GitError } from '$lib/server/git';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	const { workdir } = authorizeConversationWorkdir(params.id, locals.userId);
	const relPath = url.searchParams.get('path');
	if (!relPath) throw error(400, 'path is required');
	const ref = url.searchParams.get('ref');
	if (ref && ref.length > 200) throw error(400, 'ref is too long');

	// Raw image bytes for inline rendering in the file browser. Only worktree
	// images are served this way (the git-ref preview path stays JSON); the
	// helper enforces the same symlink-safe containment, image allowlist, and
	// size cap, so this never serves arbitrary or out-of-root files.
	if (url.searchParams.get('raw') !== null) {
		const img = readImageFileSafe(workdir, relPath);
		if (!img.ok) throw error(img.status ?? 400, img.reason);
		return new Response(new Uint8Array(img.data), {
			headers: {
				'content-type': img.mimeType,
				'content-length': String(img.data.length),
				'cache-control': 'private, no-store',
				'content-disposition': 'inline'
			}
		});
	}

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
	if (r.binary)
		return json({
			file: { binary: true, path: relPath, size: r.size, imageMimeType: r.imageMimeType }
		});
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
