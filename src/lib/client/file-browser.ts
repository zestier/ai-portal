// Shared client-side types for the file browser.

import type { ChangeStatus, ChangeEntry, ChangesResponse } from '$lib/types';

export type { ChangeStatus, ChangeEntry, ChangesResponse };

export interface FsEntry {
	name: string;
	relPath: string;
	type: 'file' | 'directory' | 'symlink' | 'other';
	size: number | null;
	mtimeMs: number | null;
	status: ChangeStatus | null;
	containsChanges: ChangeStatus | null;
	added: number | null;
	removed: number | null;
}

export interface TreeResponse {
	path: string;
	entries: FsEntry[];
	git: { initialized: boolean };
}

export interface HeadInfo {
	initialized: true;
	branch: string | null;
	sha: string | null;
	shortSha: string | null;
	detached: boolean;
	upstream: string | null;
	ahead: number;
	behind: number;
	dirtyCount: number;
}
export type HeadStatus = HeadInfo | { initialized: false };

export async function fetchHeadStatus(conversationId: string): Promise<HeadStatus> {
	const res = await fetch(`/api/conversations/${conversationId}/git/status`);
	if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
	return ((await res.json()) as { status: HeadStatus }).status;
}

export interface LogEntry {
	sha: string;
	shortSha: string;
	author: string;
	email: string;
	timestamp: number;
	subject: string;
}

export interface CommitFile {
	status: ChangeStatus;
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
}

export interface FileResponseText {
	binary: false;
	path: string;
	content: string;
	size: number;
	truncated: boolean;
	ref?: string;
}
export interface FileResponseBinary {
	binary: true;
	path: string;
	size?: number;
	ref?: string;
	// Present when the binary file is a renderable image; the browser fetches
	// the bytes via `fs/file?path=…&raw=1` and shows it inline.
	imageMimeType?: string;
}
export type FileResponse = FileResponseText | FileResponseBinary;

export const STATUS_LABEL: Record<ChangeStatus, string> = {
	untracked: 'U',
	ignored: 'I',
	modified: 'M',
	added: 'A',
	deleted: 'D',
	renamed: 'R',
	conflicted: '!'
};

export const STATUS_COLOR: Record<ChangeStatus, string> = {
	untracked: 'var(--success)',
	ignored: 'var(--text-muted)',
	modified: 'var(--warning)',
	added: 'var(--success)',
	deleted: 'var(--danger)',
	renamed: 'var(--accent)',
	conflicted: 'var(--danger)'
};
