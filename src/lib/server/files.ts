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
import { MAX_SVG_BYTES } from './svg-sanitize';

/**
 * Resolve a workspace root to a stable absolute realpath, caching by the
 * lexical root so repeated route hits don't pay the realpath cost.
 *
 * The cache is bounded by a short TTL rather than living forever: the lexical
 * root can point at a *different* realpath over time (a rolling deploy that
 * repoints a `/workspace` symlink at `/workspace-v2`, or a per-request
 * sandboxed workdir reusing the same mount point). Without expiry a stale
 * realpath would silently become the containment root for every later
 * safeResolve/listDir/readFileSafe call. The TTL is long enough to absorb the
 * burst of realpath hits from a single request yet short enough that a
 * repointed root is picked up promptly.
 */
const ROOT_CACHE_TTL_MS = 5_000;

interface CachedRoot {
	real: string;
	expiresAt: number;
}

const cachedRoots = new Map<string, CachedRoot>();

export function resolveWorkspaceRoot(root: string): string {
	const abs = resolve(root);
	const now = Date.now();
	const cached = cachedRoots.get(abs);
	if (cached && cached.expiresAt > now) return cached.real;
	let real: string;
	try {
		real = realpathSync(abs);
	} catch {
		// realpath failed (path missing or transient I/O error): drop any stale
		// entry and fall back to the lexical path without caching, so a future
		// call retries the realpath resolution once the path exists.
		cachedRoots.delete(abs);
		return abs;
	}
	cachedRoots.set(abs, { real, expiresAt: now + ROOT_CACHE_TTL_MS });
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
	// This catches symlinks pointing outside the root. When we reach a
	// not-yet-existing component, anchor the remaining (lexical) parts on the
	// realpath of the deepest existing prefix instead of the lexical
	// `candidate`. That removes the TOCTOU hole where the lexical prefix is an
	// out-of-root symlink the caller would later follow: a concurrent actor
	// can still create the missing tail component, but it can only appear under
	// a directory we already verified stays inside the root, so the deepest
	// existing prefix can never relocate the path outside the workspace.
	const parts = r.split(sep);
	let curr = rootReal;
	let escaped = false;
	for (let i = 0; i < parts.length; i++) {
		curr = join(curr, parts[i]);
		try {
			const real = realpathSync(curr);
			const insideR = relative(rootReal, real);
			if (insideR.startsWith('..') || isAbsolute(insideR)) {
				return { ok: false, reason: 'symlink escapes root' };
			}
			curr = real;
		} catch {
			// Component does not exist (yet). Build the rest lexically on top of
			// the deepest existing prefix's realpath, then confirm containment.
			escaped = true;
			curr = join(curr, ...parts.slice(i + 1));
			break;
		}
	}
	const finalInside = relative(rootReal, curr);
	if (finalInside.startsWith('..') || isAbsolute(finalInside)) {
		return { ok: false, reason: 'path escapes root' };
	}
	return { ok: true, abs: escaped ? curr : candidate, rel: toPosix(r) };
}

/**
 * Re-validate that `abs` still resolves inside `rootReal` at use time,
 * narrowing the TOCTOU window between `safeResolve` and the caller's read:
 * `safeResolve` may return a path whose final component does not yet exist, and
 * a concurrent actor can create it as a symlink pointing out of the root before
 * the caller touches it. We realpath the path that the OS will actually follow
 * and confirm containment; ENOENT (still missing) is contained by construction.
 * A residual race remains between this check and the caller's stat/open (a
 * path-string API can't fully close it without holding an fd), but escaping
 * symlinks present at check time are rejected. Returns true when safe to use.
 */
function stillContained(rootReal: string, abs: string): boolean {
	let resolved: string;
	try {
		resolved = realpathSync(abs);
	} catch (e) {
		// Missing target is fine: there's nothing to follow out of the root.
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return true;
		return false;
	}
	const inside = relative(rootReal, resolved);
	return resolved === rootReal || (!inside.startsWith('..') && !isAbsolute(inside));
}

/**
 * Resolve a model-supplied tool `path` argument — which may be absolute or
 * relative — against `root`, enforcing the same symlink-safe containment as the
 * file browser (`safeResolve`). Returns the safe absolute path when it stays
 * inside the workspace root, or null when it escapes (or `root` is unusable).
 *
 * The image-capture side-channel uses this so a prompt-injected
 * `view /home/user/secrets/whatever.png` can't read image bytes from outside
 * the conversation workspace. Absolute paths are accepted only when they fall
 * inside the root; everything else (including `..` escapes and out-of-root
 * symlinks) is rejected by `safeResolve`.
 */
export function resolveContainedToolPath(root: string, p: string): string | null {
	if (typeof p !== 'string' || p.length === 0) return null;
	// Convert an absolute model path into a root-relative one so safeResolve
	// (which rejects absolute `rel`) can apply its containment + symlink walk.
	// The model addresses files using the *lexical* workspace root it was given
	// (`workingDirectory`), so strip that lexical prefix here — not the realpath
	// — otherwise a symlinked root (e.g. `/workspace` → `/data/workspace-v2`)
	// would turn a legitimate in-workspace absolute path into a false `..`
	// escape. safeResolve still enforces realpath containment on the result, so
	// any genuine out-of-root path (or escaping symlink) is still rejected.
	const rel = isAbsolute(p) ? relative(resolve(root), p) : p;
	const r = safeResolve(root, rel);
	return r.ok ? r.abs : null;
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
	if (!stillContained(realpathSync(root), r.abs)) {
		return { ok: false, reason: 'path escapes root', status: 400 };
	}
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
	imageMimeType?: string | undefined;
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
	if (!stillContained(realpathSync(root), r.abs)) {
		return { ok: false, reason: 'path escapes root', status: 400 };
	}
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
	// SVG is text (no NUL) so it lands here, but it's an image surface: flag it
	// so the client renders it inline via the raw endpoint (which sanitizes and
	// sandboxes the bytes) rather than dumping the markup as source. Cap at
	// MAX_SVG_BYTES — the same ceiling readImageFile enforces — so a larger SVG
	// stays a (truncated) source view instead of flagging a never-served image.
	const svgMime = detectImageMime(r.abs, buf.subarray(0, 8192));
	if (svgMime === 'image/svg+xml' && size <= MAX_SVG_BYTES) {
		return { ok: true, binary: true, size, imageMimeType: svgMime };
	}
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
	if (!stillContained(realpathSync(root), r.abs)) {
		return { ok: false, reason: 'path escapes root', status: 400 };
	}
	const img: CapturedImage | null = readImageFile(r.abs);
	if (!img) return { ok: false, reason: 'not an image', status: 404 };
	return { ok: true, mimeType: img.mimeType, data: img.data };
}
