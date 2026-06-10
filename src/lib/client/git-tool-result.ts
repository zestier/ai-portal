type JsonRecord = Record<string, unknown>;

export interface GitFileStat {
	path: string;
	origPath: string | null;
	added: number | null;
	removed: number | null;
}

export interface GitNameStatusEntry {
	statusCode: string;
	status: string;
	path: string;
	origPath: string | null;
}

export interface GitLogEntry {
	sha: string;
	shortSha: string;
	author: string;
	email: string;
	timestamp: number;
	subject: string;
}

export interface GitCommitDetail {
	sha: string;
	shortSha: string;
	author: string;
	email: string;
	timestamp: number;
	subject: string;
	body: string;
	parents: string[];
	files: GitNameStatusEntry[];
	patch?: string;
}

export interface GitCommitTrailer {
	token: string;
	value: string;
}

export type GitRenderedResult =
	| {
			kind: 'diff-stat';
			files: GitFileStat[];
			total: { filesChanged: number; added: number; removed: number } | null;
	  }
	| { kind: 'diff-name-only'; files: string[] }
	| { kind: 'diff-name-status'; files: GitNameStatusEntry[] }
	| { kind: 'log'; commits: GitLogEntry[] }
	| { kind: 'commit'; commit: GitCommitDetail }
	| {
			kind: 'commit-created';
			sha: string;
			shortSha: string;
			subject: string;
			body: string;
			trailers: GitCommitTrailer[];
			files: GitNameStatusEntry[];
			fileStats: GitFileStat[];
			diffStat: { filesChanged: number; added: number; removed: number } | null;
			remainingDirtyFiles: GitNameStatusEntry[];
			followUpHint?: string;
	  };

function isRecord(v: unknown): v is JsonRecord {
	return v != null && typeof v === 'object' && !Array.isArray(v);
}

function parseJsonRecord(text: string | null): JsonRecord | null {
	if (!text) return null;
	try {
		const v = JSON.parse(text);
		return isRecord(v) ? v : null;
	} catch {
		return null;
	}
}

// Unwrap the `{ ok, result }` tool-result envelope to the git tool's domain
// record. `ok: false` envelopes (errors) yield null so no card renders. Records
// without an `ok` discriminant are treated as legacy bare payloads.
function unwrapEnvelopeResult(envelope: JsonRecord): JsonRecord | null {
	if (typeof envelope.ok === 'boolean') {
		if (!envelope.ok) return null;
		return isRecord(envelope.result) ? envelope.result : null;
	}
	return envelope;
}

function parseArgs(json: string): JsonRecord {
	try {
		const v = JSON.parse(json);
		return isRecord(v) ? v : {};
	} catch {
		return {};
	}
}

function str(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nullableNum(v: unknown): number | null {
	return v === null ? null : num(v);
}

function fileStat(v: unknown): GitFileStat | null {
	if (!isRecord(v)) return null;
	const path = str(v.path);
	if (!path) return null;
	return {
		path,
		origPath: str(v.origPath),
		added: nullableNum(v.added),
		removed: nullableNum(v.removed)
	};
}

function nameStatusEntry(v: unknown): GitNameStatusEntry | null {
	if (!isRecord(v)) return null;
	const path = str(v.path);
	if (!path) return null;
	return {
		statusCode: str(v.statusCode) ?? str(v.status) ?? '?',
		status: str(v.status) ?? 'unknown',
		path,
		origPath: str(v.origPath)
	};
}

function logEntry(v: unknown): GitLogEntry | null {
	if (!isRecord(v)) return null;
	const sha = str(v.sha);
	const shortSha = str(v.shortSha);
	const subject = str(v.subject);
	const timestamp = num(v.timestamp);
	if (!sha || !shortSha || !subject || timestamp === null) return null;
	return {
		sha,
		shortSha,
		author: str(v.author) ?? '',
		email: str(v.email) ?? '',
		timestamp,
		subject
	};
}

function commitDetail(v: JsonRecord): GitCommitDetail | null {
	const sha = str(v.sha);
	const shortSha = str(v.shortSha);
	const subject = str(v.subject);
	const timestamp = num(v.timestamp);
	if (!sha || !shortSha || !subject || timestamp === null) return null;
	return {
		sha,
		shortSha,
		author: str(v.author) ?? '',
		email: str(v.email) ?? '',
		timestamp,
		subject,
		body: str(v.body) ?? '',
		parents: Array.isArray(v.parents)
			? v.parents.filter((p): p is string => typeof p === 'string')
			: [],
		files: Array.isArray(v.files) ? v.files.map(nameStatusEntry).filter((f) => f !== null) : [],
		patch: str(v.patch) ?? undefined
	};
}

function commitTrailer(v: unknown): GitCommitTrailer | null {
	if (!isRecord(v)) return null;
	const token = str(v.token);
	const value = str(v.value);
	if (!token || value === null) return null;
	return { token, value };
}

export function parseGitToolResult(
	tool: string,
	argsJson: string,
	resultText: string | null
): GitRenderedResult | null {
	const t = tool.toLowerCase();
	const envelope = parseJsonRecord(resultText);
	if (!envelope) return null;
	// Unwrap the structured tool-result envelope: commit/diff/log data now nests
	// under `result`. Errored tools have no card. Bare records (legacy persisted
	// results) are used as-is.
	const result = unwrapEnvelopeResult(envelope);
	if (!result) return null;

	if (t === 'git_diff') {
		const args = parseArgs(argsJson);
		const output = str(args.output) ?? 'patch';
		if (!Array.isArray(result.files)) return null;
		if (output === 'stat' || output === 'numstat') {
			const files = result.files.map(fileStat).filter((f) => f !== null);
			const total = isRecord(result.total)
				? {
						filesChanged: num(result.total.filesChanged) ?? files.length,
						added: num(result.total.added) ?? 0,
						removed: num(result.total.removed) ?? 0
					}
				: null;
			return { kind: 'diff-stat', files, total };
		}
		if (output === 'name-only') {
			return {
				kind: 'diff-name-only',
				files: result.files.filter((f): f is string => typeof f === 'string')
			};
		}
		if (output === 'name-status') {
			return {
				kind: 'diff-name-status',
				files: result.files.map(nameStatusEntry).filter((f) => f !== null)
			};
		}
	}

	if (t === 'git_log' && Array.isArray(result.commits)) {
		return { kind: 'log', commits: result.commits.map(logEntry).filter((c) => c !== null) };
	}

	if (t === 'git_show_commit') {
		const commit = commitDetail(result);
		return commit ? { kind: 'commit', commit } : null;
	}

	if (t === 'git_commit') {
		const sha = str(result.sha);
		const shortSha = str(result.shortSha);
		const subject = str(result.subject);
		if (!sha || !shortSha || !subject) return null;
		const diffStat = isRecord(result.diffStat)
			? {
					filesChanged: num(result.diffStat.filesChanged) ?? 0,
					added: num(result.diffStat.added) ?? 0,
					removed: num(result.diffStat.removed) ?? 0
				}
			: null;
		// `followUpHint` is a reserved top-level envelope field (sibling to `ok`/
		// `result`), so read it from the envelope rather than the unwrapped payload.
		const followUpHint = str(envelope.followUpHint) ?? undefined;
		return {
			kind: 'commit-created',
			sha,
			shortSha,
			subject,
			body: str(result.body) ?? '',
			trailers: Array.isArray(result.trailers)
				? result.trailers.map(commitTrailer).filter((t) => t !== null)
				: [],
			files: Array.isArray(result.files)
				? result.files.map(nameStatusEntry).filter((f) => f !== null)
				: [],
			fileStats: Array.isArray(result.fileStats)
				? result.fileStats.map(fileStat).filter((f) => f !== null)
				: [],
			diffStat,
			remainingDirtyFiles: Array.isArray(result.remainingDirtyFiles)
				? result.remainingDirtyFiles.map(nameStatusEntry).filter((f) => f !== null)
				: [],
			followUpHint
		};
	}

	return null;
}
