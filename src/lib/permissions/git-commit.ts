export interface GitCommitPreview {
	subject: string;
	paths: string[] | null;
	body: string | null;
	bodyLineCount: number;
	trailers: Array<{ token: string; value: string }>;
	targetSummary: string;
}

export function gitCommitPreview(args: unknown): GitCommitPreview | null {
	if (!isRecord(args)) return null;
	const subject =
		typeof args.subject === 'string' && args.subject.length > 0 ? args.subject : '(missing)';
	const paths = Array.isArray(args.paths) ? args.paths.map(String) : null;
	const body = typeof args.body === 'string' && args.body.length > 0 ? args.body : null;
	const trailers = gitCommitTrailers(args);
	// Only the canonical primitive string `'all'` means "every workspace change".
	// An array such as `['all']` is intentionally treated as an explicit path
	// list containing a single literal path named "all", not as the all-changes
	// sentinel. Exotic coercible objects (e.g. `{ toString() { return 'all' } }`)
	// are likewise NOT treated as the sentinel — the `===` comparison is strict.
	const isAllChanges = args.paths === 'all';
	return {
		subject,
		paths,
		body,
		bodyLineCount: body ? body.split(/\r\n|\r|\n/).length : 0,
		trailers,
		targetSummary: isAllChanges
			? 'All tracked, staged, unstaged, deleted, and untracked workspace changes'
			: paths
				? `${paths.length} selected ${paths.length === 1 ? 'path' : 'paths'}`
				: 'Selected paths'
	};
}

export function summarizeGitCommitPermission(args: unknown): string | null {
	const preview = gitCommitPreview(args);
	if (!preview) return null;
	const lines = [
		'Create Git commit',
		`Subject: ${preview.subject === '(missing)' ? 'commit' : preview.subject}`
	];
	if (preview.paths) {
		lines.push(
			`Target: ${preview.paths.length} selected ${preview.paths.length === 1 ? 'path' : 'paths'}`
		);
		for (const path of preview.paths.slice(0, 10)) lines.push(`- ${path}`);
		if (preview.paths.length > 10) lines.push(`- ...and ${preview.paths.length - 10} more`);
	} else {
		lines.push(`Target: ${preview.targetSummary}`);
	}
	if (preview.bodyLineCount > 0) {
		lines.push(`Body: ${preview.bodyLineCount} ${preview.bodyLineCount === 1 ? 'line' : 'lines'}`);
	}
	if (preview.trailers.length > 0) {
		const tokens = preview.trailers.map((trailer) => trailer.token).filter(Boolean);
		lines.push(
			`Trailers: ${preview.trailers.length}${tokens.length ? ` (${tokens.slice(0, 5).join(', ')}${tokens.length > 5 ? ', ...' : ''})` : ''}`
		);
	}
	lines.push('Approval: one-time only; stored grants are disabled for git_commit.');
	return lines.join('\n');
}

function gitCommitTrailers(args: Record<string, unknown>): Array<{ token: string; value: string }> {
	if (!Array.isArray(args.trailers)) return [];
	return args.trailers
		.filter(isRecord)
		.map((trailer) => ({
			token: String(trailer.token ?? ''),
			value: String(trailer.value ?? '')
		}))
		.filter((trailer) => trailer.token.length > 0 && trailer.value.length > 0);
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}
