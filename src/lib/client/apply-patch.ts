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

function normalizeHunkHeader(line: string): string {
	if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) return line;
	return '@@ -1,1 +1,1 @@';
}

function buildDiff(
	oldPath: string | null,
	newPath: string | null,
	body: string[],
	meta: string[] = []
): string {
	const lines = [
		`--- ${oldPath ? `a/${oldPath}` : '/dev/null'}`,
		`+++ ${newPath ? `b/${newPath}` : '/dev/null'}`,
		...meta,
		...body
	];
	return lines.join('\n');
}

// Returns the parsed changes, an empty array if the input is recognized as
// apply_patch format but is malformed/unparseable, or null if the input is not
// apply_patch format at all. Distinguishing [] from null lets callers debug
// malformed patches instead of silently treating them as "no diffs".
export function parseApplyPatch(input: string): ApplyPatchChange[] | null {
	// Not apply_patch format: missing the envelope markers entirely.
	if (!input.includes('*** Begin Patch') || !input.includes('*** End Patch')) return null;
	const lines = input.split(/\r?\n/);
	if (lines[0] !== '*** Begin Patch') return null;

	const changes: ApplyPatchChange[] = [];
	let i = 1;

	while (i < lines.length) {
		const line = lines[i];
		if (line === '*** End Patch') return changes;

		if (line.startsWith('*** Add File: ')) {
			const path = line.slice('*** Add File: '.length);
			i += 1;
			const body: string[] = [];
			while (i < lines.length && !lines[i].startsWith('*** ')) {
				body.push(lines[i]);
				i += 1;
			}
			changes.push({
				kind: 'add',
				path,
				oldPath: null,
				newPath: path,
				diff: buildDiff(null, path, body.length ? ['@@ -0,0 +1,1 @@', ...body] : [])
			});
			continue;
		}

		if (line.startsWith('*** Delete File: ')) {
			const path = line.slice('*** Delete File: '.length);
			changes.push({
				kind: 'delete',
				path,
				oldPath: path,
				newPath: null,
				diff: buildDiff(path, null, [])
			});
			i += 1;
			continue;
		}

		if (line.startsWith('*** Update File: ')) {
			const oldPath = line.slice('*** Update File: '.length);
			i += 1;
			let newPath = oldPath;
			if (i < lines.length && lines[i].startsWith('*** Move to: ')) {
				newPath = lines[i].slice('*** Move to: '.length);
				i += 1;
			}

			const body: string[] = [];
			while (i < lines.length && (!lines[i].startsWith('*** ') || lines[i] === '*** End of File')) {
				const raw = lines[i];
				if (raw === '*** End of File') {
					i += 1;
					continue;
				}
				if (raw.startsWith('@@')) body.push(normalizeHunkHeader(raw));
				else if (
					raw.startsWith('+') ||
					raw.startsWith('-') ||
					raw.startsWith(' ') ||
					raw.startsWith('\\')
				) {
					body.push(raw);
				}
				i += 1;
			}

			const meta = newPath !== oldPath ? [`rename from ${oldPath}`, `rename to ${newPath}`] : [];
			changes.push({
				kind: 'update',
				path: displayPath(oldPath, newPath),
				oldPath,
				newPath,
				diff: buildDiff(oldPath, newPath, body, meta)
			});
			continue;
		}

		// Recognized as apply_patch (had Begin/End markers) but hit an
		// unrecognized line: malformed. Return [] so callers can tell this
		// apart from "not apply_patch format" (null).
		return [];
	}

	// Ran off the end of input without seeing '*** End Patch': malformed.
	return [];
}
