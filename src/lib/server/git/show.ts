import { existsSync, realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { emptyResult, GitError, runGitOk } from './run';
import { isSafeRef, repositoryRoot } from './repo';
import { decodeStatusChar, type StatusCode } from './status';
import { safeResolve } from '../files';
import { DEFAULT_MAX_BYTES, SHA_RE } from './common';

export interface CommitFile {
	status: StatusCode;
	path: string;
	origPath: string | null;
}

export interface CommitDetail {
	sha: string;
	shortSha: string;
	author: string;
	email: string;
	timestamp: number;
	subject: string;
	body: string;
	parents: string[];
	files: CommitFile[];
	patch?: string;
}

export async function showCommit(
	cwd: string,
	sha: string,
	opts: { includePatch?: boolean } = {}
): Promise<CommitDetail> {
	if (!SHA_RE.test(sha)) throw new GitError('invalid sha', emptyResult());
	const SEP = '\x1f';
	const fmt = ['%H', '%h', '%an', '%ae', '%at', '%P', '%s', '%b'].join(SEP);
	const meta = await runGitOk(['show', '-s', `--pretty=format:${fmt}`, sha], { cwd });
	const [full, shortSha, author, email, ts, parentsRaw, subject, ...bodyParts] = meta.split(SEP);
	const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
	// Changed files via name-status.
	const nameStatus = await runGitOk(['show', '--name-status', '--format=', '-z', sha], { cwd });
	const files: CommitFile[] = [];
	const parts = nameStatus.split('\0').filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const code = parts[i];
		// Status codes: M, A, D, T, R100, C75, ...
		const head = code[0];
		if (head === 'R' || head === 'C') {
			const orig = parts[++i] ?? '';
			const dest = parts[++i] ?? '';
			files.push({
				status: head === 'R' ? 'renamed' : 'copied',
				path: dest,
				origPath: orig
			});
		} else {
			const path = parts[++i] ?? '';
			files.push({
				status: decodeStatusChar(head),
				path,
				origPath: null
			});
		}
	}
	const detail: CommitDetail = {
		sha: full,
		shortSha,
		author,
		email,
		timestamp: Number(ts) * 1000,
		subject,
		body: bodyParts.join(SEP).trim(),
		parents,
		files
	};
	if (opts.includePatch) {
		detail.patch = await runGitOk(
			['show', '--no-color', '--no-ext-diff', '--format=', '--patch', sha],
			{
				cwd,
				maxBytes: DEFAULT_MAX_BYTES
			}
		);
	}
	return detail;
}

/** Read a file at a specific revision. */
export async function showFile(cwd: string, ref: string, relPath: string): Promise<string> {
	if (!isSafeRef(ref)) throw new GitError('invalid ref', emptyResult());
	const r = safeResolve(cwd, relPath);
	if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
	// `git show <ref>:<path>` resolves <path> relative to the repository root,
	// not `cwd`. When the workdir is a subdirectory, recompute the path
	// relative to the repo root so the correct blob is read.
	const repoRoot = await repositoryRoot(cwd);
	const repoRootReal = existsSync(repoRoot) ? realpathSync(repoRoot) : repoRoot;
	const treePath = relative(repoRootReal, r.abs).split(sep).join('/');
	if (treePath === '' || treePath === '..' || treePath.startsWith('../')) {
		throw new GitError('invalid path', emptyResult());
	}
	return await runGitOk(['show', `${ref}:${treePath}`], { cwd: repoRoot });
}
