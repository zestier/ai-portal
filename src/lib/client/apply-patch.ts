import { parsePatch, type ParsedDiff } from 'diff';

export interface ApplyPatchChange {
	kind: 'add' | 'delete' | 'update';
	path: string;
	diff: string;
	oldPath: string | null;
	newPath: string | null;
}

function displayPath(oldPath: string | null, newPath: string | null): string {
	if (oldPath && newPath && oldPath !== newPath) return `${oldPath} -> ${newPath}`;
	return newPath ?? oldPath ?? '';
}

function decodePath(path: string, stripGitPrefix: boolean): string | null {
	let decoded = path;
	if (decoded.startsWith('"')) {
		try {
			decoded = JSON.parse(decoded) as string;
		} catch {
			return null;
		}
	}
	if (decoded === '/dev/null') return null;
	if (stripGitPrefix && /^(?:a|b)\//.test(decoded)) return decoded.slice(2);
	return decoded;
}

function metadataPath(lines: string[], prefix: string): string | null {
	const line = lines.find((candidate) => candidate.startsWith(prefix));
	return line ? decodePath(line.slice(prefix.length), false) : null;
}

function splitUnifiedDiff(input: string): string[] | null {
	const lines = input.split(/\r?\n/);
	const gitStarts = lines.flatMap((line, index) => (line.startsWith('diff --git ') ? [index] : []));
	if (gitStarts.length > 0) {
		if (lines.slice(0, gitStarts[0]).some((line) => line.trim() !== '')) return null;
		return gitStarts.map((start, index) =>
			lines.slice(start, gitStarts[index + 1] ?? lines.length).join('\n')
		);
	}

	const fileStarts = lines.flatMap((line, index) =>
		line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ') ? [index] : []
	);
	if (fileStarts.length === 0) return null;
	if (lines.slice(0, fileStarts[0]).some((line) => line.trim() !== '')) return null;
	return fileStarts.map((start, index) =>
		lines.slice(start, fileStarts[index + 1] ?? lines.length).join('\n')
	);
}

function hasValidHunks(lines: string[], parsedHunks: number): boolean {
	const headers = lines.filter((line) => line.startsWith('@@'));
	return (
		headers.length === parsedHunks &&
		headers.every((line) => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(?: .*)?$/.test(line))
	);
}

function parseSection(section: string): ParsedDiff | null {
	try {
		const parsed = parsePatch(section);
		return parsed.length === 1 ? parsed[0] : null;
	} catch {
		return null;
	}
}

// Returns parsed changes, [] for recognized but malformed unified diff input,
// or null when the input is not a unified diff at all.
export function parseApplyPatch(input: string | null): ApplyPatchChange[] | null {
	if (input === null) return null;
	const sections = splitUnifiedDiff(input);
	if (!sections) return null;

	const changes: ApplyPatchChange[] = [];
	for (const section of sections) {
		const lines = section.split('\n');
		const parsed = parseSection(section);
		if (!parsed) return [];

		const renamedFrom = metadataPath(lines, 'rename from ');
		const renamedTo = metadataPath(lines, 'rename to ');
		if ((renamedFrom === null) !== (renamedTo === null)) return [];
		if (!hasValidHunks(lines, parsed.hunks.length)) return [];
		if (parsed.hunks.length === 0 && (!renamedFrom || !renamedTo)) return [];

		const oldPath =
			renamedFrom ?? (parsed.oldFileName ? decodePath(parsed.oldFileName, true) : null);
		const newPath = renamedTo ?? (parsed.newFileName ? decodePath(parsed.newFileName, true) : null);
		if (!oldPath && !newPath) return [];

		changes.push({
			kind: oldPath === null ? 'add' : newPath === null ? 'delete' : 'update',
			path: displayPath(oldPath, newPath),
			oldPath,
			newPath,
			diff: section
		});
	}

	return changes;
}
