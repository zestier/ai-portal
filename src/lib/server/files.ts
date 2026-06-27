// Path-safe filesystem helpers bounded to a root realpath.
//
// All public functions take a `root` (an absolute path that the caller has
// already validated — typically a conversation's workdir) and a `rel` path
// supplied by the user. They guarantee that the resolved path stays under
// the realpath of `root`, even when intermediate path components are
// symlinks. Symlinks that escape the root are rejected.

import {
	realpathSync,
	statSync,
	readdirSync,
	openSync,
	readSync,
	closeSync,
	type Dirent
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join, relative, sep, isAbsolute, normalize } from 'node:path';
import { effectiveWorkdir, projectRoot } from './workdir';
import {
	MAX_IMAGE_ATTACHMENT_BYTES,
	detectImageMime,
	readImageFile,
	type CapturedImage
} from './image-detect';

/**
 * Resolve a workspace root to a stable absolute realpath, caching by the
 * lexical root so repeated route hits don't pay the realpath cost.
 */
const cachedRoots = new Map<string, string>();

export function resolveWorkspaceRoot(root: string): string {
	const abs = resolve(root);
	const cached = cachedRoots.get(abs);
	if (cached) return cached;
	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		// realpath failed (path missing or transient I/O error): fall back to the
		// lexical path without caching, so a future call retries the realpath
		// resolution once the path exists.
		return abs;
	}
	cachedRoots.set(abs, real);
	return real;
}

/**
 * The default root the file browser and git endpoints operate on when they are
 * not scoped to a specific conversation.
 */
export function workspaceRoot(): string {
	return resolveWorkspaceRoot(projectRoot());
}

/**
 * Resolve the root a conversation-scoped file or git route should operate on.
 * The conversation row is authoritative; legacy stored workdirs still fold
 * back to PROJECT_ROOT via effectiveWorkdir().
 */
export function conversationWorkspaceRoot(workdir: string | null | undefined): string {
	return resolveWorkspaceRoot(effectiveWorkdir(workdir));
}

/** Test-only: reset the cached workspace root. */
export function resetWorkspaceRootForTests() {
	cachedRoots.clear();
}

export interface DirEntry {
	name: string;
	relPath: string;
	type: 'file' | 'directory' | 'symlink' | 'other';
	size: number | null;
	mtimeMs: number | null;
}

export interface ResolveOk {
	ok: true;
	/** Absolute realpath inside the root. */
	abs: string;
	/** Path relative to the root, using POSIX separators. */
	rel: string;
}
export interface ResolveErr {
	ok: false;
	reason: string;
}
export type ResolveResult = ResolveOk | ResolveErr;

const FORBIDDEN_RE = /\0/;

function toPosix(p: string): string {
	return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * Resolve `rel` against the realpath of `root`, ensuring the result stays
 * inside the root after realpath resolution. The path is allowed to not
 * exist (callers may want to read either an existing file or report 404);
 * in that case we resolve the deepest existing prefix and check containment.
 */
export function safeResolve(root: string, rel: string): ResolveResult {
	if (FORBIDDEN_RE.test(rel)) return { ok: false, reason: 'invalid path' };
	// Disallow absolute paths from the client side; rel must be relative.
	if (isAbsolute(rel)) return { ok: false, reason: 'absolute paths not allowed' };
	let rootReal: string;
	try {
		rootReal = realpathSync(root);
	} catch {
		return { ok: false, reason: 'root does not exist' };
	}
	// Normalize "" / "." to root.
	const normalized = normalize(rel).replace(/^[/\\]+/, '');
	if (normalized === '' || normalized === '.') {
		return { ok: true, abs: rootReal, rel: '' };
	}
	const candidate = resolve(rootReal, normalized);
	// Quick lexical check.
	const r = relative(rootReal, candidate);
	if (r.startsWith('..') || isAbsolute(r)) {
		return { ok: false, reason: 'path escapes root' };
	}
	// Walk the path; for each existing component, realpath it and re-check.
	// This catches symlinks pointing outside the root.
	const parts = r.split(sep);
	let curr = rootReal;
	for (const part of parts) {
		curr = join(curr, part);
		try {
			const real = realpathSync(curr);
			const insideR = relative(rootReal, real);
			if (insideR.startsWith('..') || isAbsolute(insideR)) {
				return { ok: false, reason: 'symlink escapes root' };
			}
			curr = real;
		} catch {
			// Component does not exist (yet). That's fine — remaining parts
			// can't contain new symlinks until they're created. Use lexical
			// resolution for the rest.
			break;
		}
	}
	return { ok: true, abs: candidate, rel: toPosix(r) };
}

function classify(d: Dirent): DirEntry['type'] {
	if (d.isDirectory()) return 'directory';
	if (d.isFile()) return 'file';
	if (d.isSymbolicLink()) return 'symlink';
	return 'other';
}

export interface ListDirOptions {
	includeHidden?: boolean;
}

export function listDir(
	root: string,
	rel: string,
	opts: ListDirOptions = {}
): { ok: true; entries: DirEntry[] } | { ok: false; reason: string; status?: number } {
	const r = safeResolve(root, rel);
	if (!r.ok) return { ok: false, reason: r.reason, status: 400 };
	let dirents: Dirent[];
	try {
		const st = statSync(r.abs);
		if (!st.isDirectory()) return { ok: false, reason: 'not a directory', status: 400 };
		dirents = readdirSync(r.abs, { withFileTypes: true });
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') return { ok: false, reason: 'not found', status: 404 };
		return { ok: false, reason: err.message || 'readdir failed', status: 500 };
	}
	const entries: DirEntry[] = [];
	for (const d of dirents) {
		if (!opts.includeHidden && d.name.startsWith('.') && d.name !== '.gitignore') {
			// Hide dotfiles (including .git/) by default; keep .gitignore visible.
			continue;
		}
		const entryRel = r.rel ? `${r.rel}/${d.name}` : d.name;
		let size: number | null = null;
		let mtimeMs: number | null = null;
		try {
			const st = statSync(join(r.abs, d.name));
			size = st.isFile() ? st.size : null;
			mtimeMs = st.mtimeMs;
		} catch {
			// ignore
		}
		entries.push({
			name: d.name,
			relPath: entryRel,
			type: classify(d),
			size,
			mtimeMs
		});
	}
	// Sort: directories first, then files, both alphabetical.
	entries.sort((a, b) => {
		if (a.type !== b.type) {
			if (a.type === 'directory') return -1;
			if (b.type === 'directory') return 1;
		}
		return a.name.localeCompare(b.name);
	});
	return { ok: true, entries };
}

const TEXT_PROBE_BYTES = 8192;
const MAX_TEXT_BYTES = 1024 * 1024; // 1 MiB

export interface FileResultText {
	ok: true;
	binary: false;
	encoding: 'utf-8';
	content: string;
	size: number;
	truncated: boolean;
}
export interface FileResultBinary {
	ok: true;
	binary: true;
	size: number;
	// When the binary file is an allowlisted, magic-byte-confirmed raster image
	// within the size cap, its mime type — signals the client to render it
	// inline (fetching the bytes via the `fs/file?raw=1` mode) rather than
	// showing a "binary file" placeholder. Absent for non-image binaries.
	imageMimeType?: string;
}
export interface FileResultErr {
	ok: false;
	reason: string;
	status?: number;
}
export type FileResult = FileResultText | FileResultBinary | FileResultErr;

function looksBinary(buf: Buffer): boolean {
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
}

export async function readFileSafe(root: string, rel: string): Promise<FileResult> {
	const r = safeResolve(root, rel);
	if (!r.ok) return { ok: false, reason: r.reason, status: 400 };
	let size: number;
	try {
		const st = statSync(r.abs);
		if (!st.isFile()) return { ok: false, reason: 'not a file', status: 400 };
		size = st.size;
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') return { ok: false, reason: 'not found', status: 404 };
		return { ok: false, reason: err.message || 'stat failed', status: 500 };
	}

	// Probe for binary content before loading the whole file.
	const probe = Buffer.alloc(Math.min(TEXT_PROBE_BYTES, size));
	if (probe.length > 0) {
		const fd = openSync(r.abs, 'r');
		try {
			readSync(fd, probe, 0, probe.length, 0);
		} finally {
			closeSync(fd);
		}
		if (looksBinary(probe)) {
			// An allowlisted image confirmed by magic bytes is still "binary",
			// but we surface its mime so the client can render it inline instead
			// of showing a placeholder. The `probe` already holds the file head,
			// so sniff from it rather than re-reading the file; cap at the same
			// size the raw endpoint enforces so the flag stays consistent.
			const imageMimeType =
				size <= MAX_IMAGE_ATTACHMENT_BYTES
					? (detectImageMime(r.abs, probe) ?? undefined)
					: undefined;
			return { ok: true, binary: true, size, imageMimeType };
		}
	}

	const truncated = size > MAX_TEXT_BYTES;
	const buf = await readFile(r.abs);
	const slice = truncated ? buf.subarray(0, MAX_TEXT_BYTES) : buf;
	return {
		ok: true,
		binary: false,
		encoding: 'utf-8',
		content: slice.toString('utf-8'),
		size,
		truncated
	};
}

export type ImageBytesResult =
	| { ok: true; mimeType: string; data: Buffer }
	| { ok: false; reason: string; status?: number };

/**
 * Resolve `rel` under `root` (same symlink-safe containment as readFileSafe) and
 * read it as an image, enforcing the allowlist + magic-byte sniff + size cap.
 * Returns the bytes for serving inline, or a 4xx-ish error. Never reads files
 * outside the root and never returns non-image bytes.
 */
export function readImageFileSafe(root: string, rel: string): ImageBytesResult {
	const r = safeResolve(root, rel);
	if (!r.ok) return { ok: false, reason: r.reason, status: 400 };
	const img: CapturedImage | null = readImageFile(r.abs);
	if (!img) return { ok: false, reason: 'not an image', status: 404 };
	return { ok: true, mimeType: img.mimeType, data: img.data };
}
