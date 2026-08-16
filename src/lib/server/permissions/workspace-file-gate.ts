// Hash-gated import for the checked-in workspace permissions file
// (`.zap/permissions.toml`).
//
// Threat model: the agent is trusted enough to run in the workspace, but it
// must not widen its OWN permissions by editing a checked-in file. So the file
// only ever becomes active grants through a human approval, and any drift
// from the last approved snapshot keeps the OLD state active (fail-closed)
// while raising a review dialog with a unified diff.
//
// The gate is fire-and-forget and non-blocking: it runs at the top of
// `decideCore` on every permission request and NEVER influences the request
// that triggered it. A drifted file re-raises its review on the next request
// until a human approves or the file returns to the approved hash.
//
// Precedence needs no change: the matcher already applies `deny` > `allow`
// regardless of source, so a file `deny` beats a user `allow`. File allows
// add to the user's grant set exactly like a Settings-created allow (including
// the same interaction with `deny-all` policy), so there is no separate
// envelope to enforce. The only thing that could outrank a file deny is
// `force-allow`, which is minted solely by the manual tool-rerun route — a
// deliberate, conversation-scoped, TTL'd human gesture — so it is outside
// this feature's threat model by design.
//
// The gate canonicalizes every root to its repository's main checkout root
// (`canonicalWorkspaceRoot`), so one approval covers the main checkout AND all
// its worktrees/leases — no per-path re-review, no silently-inert grants. A
// non-git root canonicalizes to itself, unchanged.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { zapSubdir } from '../tools/zap-dir';
import * as settingsRepo from '../db/repos/settings';
import { newRequestId, register as registerInteractive } from '../runtime/interactive-requests';
import { log } from '../log';
import {
	parseWorkspaceGrantFile,
	type ParseWorkspaceGrantFileResult
} from './workspace-file-format';
import { canonicalWorkspaceRoot } from './repo-root';
import type { PortalEvent } from '$lib/types';
import type { InteractiveRequestView, InteractiveRequestViewBody } from '$lib/types';

export const WORKSPACE_PERMISSIONS_FILE = 'permissions.toml';

/** The longest unified diff we'll ship to the UI; longer ones are truncated. */
const MAX_DIFF_CHARS = 100_000;

export function workspacePermissionsFilePath(workspaceRoot: string): string {
	return join(workspaceRoot, zapSubdir(WORKSPACE_PERMISSIONS_FILE));
}

export function hashWorkspaceFile(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface FileCacheEntry {
	text: string;
	hash: string;
	mtimeMs: number;
	size: number;
}

// mtime+size-keyed read cache: every permission request hits this, so we avoid
// re-reading + re-hashing the file unless it actually changed. `statSync` per
// call is cheap and detects creation/deletion (stat throws ENOENT → absent).
// Known ceiling (ponytail): a hostile edit that restores size+mtime slips past
// the cache and is never RE-reviewed, but the fail-closed property still holds
// — active grants only ever come from the DB, which keeps serving the last
// human-approved snapshot, and both the review dialog and the apply path read
// through the same cache so what gets approved is what gets applied.
const FILE_CACHE = new Map<string, FileCacheEntry>();

function readWorkspacePermissionsFile(
	workspaceRoot: string
): { text: string; hash: string } | null {
	const path = workspacePermissionsFilePath(workspaceRoot);
	let stat;
	try {
		stat = statSync(path);
	} catch {
		return null; // absent
	}
	if (!stat.isFile()) return null;
	const cached = FILE_CACHE.get(workspaceRoot);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
		return { text: cached.text, hash: cached.hash };
	}
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return null; // deleted between stat and read
	}
	const hash = hashWorkspaceFile(text);
	FILE_CACHE.set(workspaceRoot, { text, hash, mtimeMs: stat.mtimeMs, size: stat.size });
	return { text, hash };
}

// Parse results memoized by content hash so the gate's needsReview check (and
// the first-import path) don't re-parse the same bytes on every request.
const PARSE_CACHE = new Map<string, ParseWorkspaceGrantFileResult>();

function parseCached(text: string, hash: string): ParseWorkspaceGrantFileResult {
	const key = `${text.length}:${hash}`;
	let result = PARSE_CACHE.get(key);
	if (!result) {
		result = parseWorkspaceGrantFile(text);
		PARSE_CACHE.set(key, result);
	}
	return result;
}

/**
 * True when the current on-disk state warrants a review: a drift from the
 * accepted hash, a first import of a file that actually grants something (an
 * empty valid file is a no-op and skipped), an unparseable file, or the
 * deletion of an approved file. `acceptedHash === null` with no file is clean.
 */
function needsReview(
	file: { text: string; hash: string } | null,
	acceptedHash: string | null
): boolean {
	if (file === null) return acceptedHash !== null;
	if (acceptedHash === null) {
		const parsed = parseCached(file.text, file.hash);
		return !parsed.ok || parsed.grants.length > 0;
	}
	return file.hash !== acceptedHash;
}

function capDiff(diff: string): string {
	if (diff.length <= MAX_DIFF_CHARS) return diff;
	return `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated — ${diff.length} chars total)`;
}

function buildDiff(oldText: string | null, currentText: string): string {
	return createTwoFilesPatch(
		WORKSPACE_PERMISSIONS_FILE,
		WORKSPACE_PERMISSIONS_FILE,
		oldText ?? '',
		currentText,
		oldText === null ? 'new file' : 'approved snapshot',
		'current file'
	);
}

export interface WorkspaceFileGateOptions {
	userId: number;
	conversationId: number;
	/** The primary workspace root the request is scoped to; null to skip. */
	workspaceRoot: string | null;
	emit: (ev: PortalEvent) => void;
}

// Reviews already raised per (user, root, hash). Keeps one drift state from
// re-raising a dialog on every request in the same turn; a NEW hash re-keys
// and raises a fresh review (which is the point — the agent re-edited the file).
const PENDING = new Set<string>();

/**
 * Fire-and-forget gate check. Call from the permission decision path; it never
 * throws into the caller (all failures are logged). Only raises a review, it
 * never resolves or applies anything — approval comes back through the
 * interactive request's resolve callback.
 */
export function checkWorkspaceFileGate(opts: WorkspaceFileGateOptions): void {
	if (!opts.workspaceRoot) return;
	// Local const: the early-return narrowing of `opts.workspaceRoot` doesn't
	// survive into the resolve/reject closures below. Canonicalized to the
	// repository root so a worktree/lease of the same repo shares one approval.
	const workspaceRoot = canonicalWorkspaceRoot(opts.workspaceRoot);
	const file = readWorkspacePermissionsFile(workspaceRoot);
	const state = settingsRepo.getWorkspacePermissionState(opts.userId, workspaceRoot);
	const acceptedHash = state?.contentHash ?? null;
	if (!needsReview(file, acceptedHash)) return;

	const fileHash = file?.hash ?? null;
	// JSON-encoded tuple key (never collides: userId is a number, workspaceRoot
	// and hash are strings, so "1" and 1 serialize differently).
	const key = JSON.stringify([opts.userId, workspaceRoot, fileHash ?? 'missing']);
	if (PENDING.has(key)) return;
	PENDING.add(key);

	const currentText = file?.text ?? '';
	const parsed = file !== null ? parseCached(file.text, file.hash) : null;
	const view: InteractiveRequestViewBody = {
		kind: 'workspace_file',
		workspaceRoot,
		fileName: `.zap/${WORKSPACE_PERMISSIONS_FILE}`,
		currentText,
		currentHash: fileHash,
		acceptedHash,
		oldSnapshot: state?.snapshotText ?? null,
		diff: capDiff(buildDiff(state?.snapshotText ?? null, currentText)),
		activeGrantCount: settingsRepo.countWorkspaceFileGrants(opts.userId, workspaceRoot),
		...(parsed && !parsed.ok ? { parseError: parsed.error } : {}),
		summary: buildSummary(file, acceptedHash, parsed)
	};

	const requestId = newRequestId();
	const full = { requestId, ...view } as InteractiveRequestView;
	registerInteractive({
		requestId,
		conversationId: opts.conversationId,
		userId: opts.userId,
		kind: 'workspace_file',
		view: full,
		resolve: (response) => {
			PENDING.delete(key);
			if (response.kind !== 'workspace_file') return;
			if (response.decision !== 'approve') return;
			const result = applyWorkspaceFile({
				userId: opts.userId,
				workspaceRoot,
				expectedHash: fileHash
			});
			if (!result.ok) {
				log.warn('workspace_permissions.apply_failed', {
					userId: opts.userId,
					workspaceRoot,
					err: result.error
				});
				// Old state stays active; the next gate check re-raises a fresh review.
			}
		},
		reject: () => {
			PENDING.delete(key);
		},
		emit: opts.emit
	});
	opts.emit({ type: 'interactive.request', request: full });
}

function buildSummary(
	file: { text: string; hash: string } | null,
	acceptedHash: string | null,
	parsed: ParseWorkspaceGrantFileResult | null
): string {
	const fileName = `.zap/${WORKSPACE_PERMISSIONS_FILE}`;
	if (parsed && !parsed.ok) {
		return `The workspace permissions file ${fileName} could not be parsed. The previous state stays active; fix the file and it will be reviewed again.`;
	}
	if (file === null) {
		return `The approved workspace permissions file ${fileName} was deleted. Approving removes its active grants; rejecting keeps the current grants active.`;
	}
	if (acceptedHash === null) {
		const count = parsed?.ok ? parsed.grants.length : 0;
		return `A workspace permissions file (${fileName}) was found. Approving applies its ${count} checked-in grant${count === 1 ? '' : 's'} to this workspace.`;
	}
	return `The workspace permissions file ${fileName} changed since it was last approved. The previously approved state stays active until you decide.`;
}

export interface ApplyWorkspaceFileOptions {
	userId: number;
	workspaceRoot: string;
	/**
	 * When provided, the file must still hash to this value for the apply to
	 * proceed (TOCTOU guard on interactive approvals — the agent may have
	 * edited the file while the review was open). Omit for explicit human
	 * re-imports from Settings, which apply whatever is on disk right now.
	 */
	expectedHash?: string | null;
}

/**
 * Apply the current file as active grants: wipe the workspace's old
 * `workspace-file` rows, insert the freshly parsed grants, and record the
 * approved snapshot + hash. Deletion applies as "no grants + no snapshot".
 */
export function applyWorkspaceFile(
	opts: ApplyWorkspaceFileOptions
): { ok: true; applied: number } | { ok: false; error: string } {
	// Canonical root: file rows + approval state live per-repository, so an
	// approval raised in a worktree applies to the whole repo (and vice versa).
	const root = canonicalWorkspaceRoot(opts.workspaceRoot);
	const current = readWorkspacePermissionsFile(root);
	const hash = current?.hash ?? null;
	if (opts.expectedHash !== undefined && opts.expectedHash !== hash) {
		return {
			ok: false,
			error:
				'The permissions file changed since it was reviewed; nothing was applied. It will be presented for review again.'
		};
	}
	if (current === null) {
		const removed = settingsRepo.clearWorkspaceFileState(opts.userId, root);
		return { ok: true, applied: removed };
	}
	const parsed = parseWorkspaceGrantFile(current.text);
	if (!parsed.ok) {
		return { ok: false, error: parsed.error };
	}
	const applied = settingsRepo.replaceWorkspaceFileGrants(
		opts.userId,
		root,
		parsed.grants,
		current.text,
		current.hash
	);
	return { ok: true, applied };
}

export interface WorkspaceFileStatus {
	fileName: string;
	workspaceRoot: string;
	present: boolean;
	currentHash: string | null;
	acceptedHash: string | null;
	activeGrantCount: number;
	/** True when the file matches the approved snapshot (or none exists). */
	accepted: boolean;
	/** True when a review is warranted right now (mirrors the gate). */
	drift: boolean;
	parseError: string | null;
	diff: string | null;
	content: string | null;
}

/** Read-only status for the Settings page: gate state + the drift diff. */
export function getWorkspaceFileStatus(userId: number, workspaceRoot: string): WorkspaceFileStatus {
	const root = canonicalWorkspaceRoot(workspaceRoot);
	const file = readWorkspacePermissionsFile(root);
	const state = settingsRepo.getWorkspacePermissionState(userId, root);
	const acceptedHash = state?.contentHash ?? null;
	const accepted = !needsReview(file, acceptedHash);
	const parsed = file !== null ? parseCached(file.text, file.hash) : null;
	const diff = accepted ? null : capDiff(buildDiff(state?.snapshotText ?? null, file?.text ?? ''));
	return {
		fileName: `.zap/${WORKSPACE_PERMISSIONS_FILE}`,
		workspaceRoot: root,
		present: file !== null,
		currentHash: file?.hash ?? null,
		acceptedHash,
		activeGrantCount: settingsRepo.countWorkspaceFileGrants(userId, root),
		accepted,
		drift: !accepted,
		parseError: parsed && !parsed.ok ? parsed.error : null,
		diff,
		content: file?.text ?? null
	};
}
