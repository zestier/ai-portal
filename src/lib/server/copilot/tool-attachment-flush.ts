// Persist an image attachment for a tool call once the owning `tool_calls` row
// exists. Called from the turn runner on `tool.call` (execution_start) — the
// first moment the FK target is present.
//
// Two capture paths, in priority order:
//  1. Buffered bytes staged at permission (read) time, correlated by the
//     execution's toolCallId or (conversationId + resolved arg path). This is
//     the path that also powered the pre-approval preview.
//  2. A direct read of the tool's `path` argument as a fallback. The native
//     `view` tool's in-workspace reads are auto-allowed by the SDK *without*
//     invoking our permission callback, so nothing gets buffered for them.
//     Capturing here keeps render-in-card always-on: the file is still present
//     immediately after the view, and the read is the same one the tool just
//     performed (no new access). `view` is read-only, so this never mutates.

import { isAbsolute, resolve as resolvePath } from 'node:path';
import * as toolAttachments from '../db/repos/tool-attachments';
import type { ToolAttachmentMeta } from '$lib/types';
import { takeAttachment, toolCallKey, pathKey } from './tool-attachment-buffer';
import { captureImageAttachment } from './image-attachment';
import { resolveContainedToolPath } from '../files';
import { log } from '../log';

// Tools whose `path` argument we'll fall back to reading directly as an image
// when nothing was buffered. Limited to read-only file viewers.
const DIRECT_CAPTURE_TOOLS = new Set(['view', 'read', 'read_file']);

export interface FlushInput {
	toolCallId: string;
	conversationId: string;
	workingDirectory: string;
	argsJson: string | null;
	// Tool name from the execution_start event; gates the direct-capture
	// fallback so we only sniff paths for known read-only file viewers.
	tool?: string;
}

function argPath(argsJson: string | null): string | null {
	if (!argsJson) return null;
	try {
		const a = JSON.parse(argsJson);
		if (a && typeof a === 'object' && !Array.isArray(a)) {
			const p = (a as Record<string, unknown>).path;
			if (typeof p === 'string' && p.length > 0) return p;
		}
	} catch {
		/* ignore malformed args */
	}
	return null;
}

export function correlationKeys(input: FlushInput): string[] {
	const keys = [toolCallKey(input.toolCallId)];
	const p = argPath(input.argsJson);
	if (p) {
		const abs = isAbsolute(p)
			? resolvePath(p)
			: resolvePath(input.workingDirectory || process.cwd(), p);
		keys.push(pathKey(input.conversationId, abs));
	}
	return keys;
}

interface ResolvedImage {
	kind: 'image';
	mimeType: string;
	data: Buffer;
	sourcePath: string | null;
}

// Buffered bytes from permission time take priority (they also fed the
// preview); otherwise fall back to a direct read of the tool's path arg for
// known read-only viewers whose reads bypassed our permission callback.
function resolveImage(input: FlushInput): ResolvedImage | null {
	const buffered = takeAttachment(correlationKeys(input));
	if (buffered) {
		return {
			kind: buffered.kind,
			mimeType: buffered.mimeType,
			data: buffered.data,
			sourcePath: buffered.sourcePath
		};
	}
	if (!input.tool || !DIRECT_CAPTURE_TOOLS.has(input.tool)) return null;
	const p = argPath(input.argsJson);
	if (!p) return null;
	// Containment guard: `path` is model-controlled, so resolve it against the
	// session workspace root and refuse anything that escapes it (same
	// symlink-safe check the file browser uses). Without this, a prompt-injected
	// `view /home/user/secrets/whatever.png` would let this side-channel read
	// image bytes from anywhere on the host.
	const abs = resolveContainedToolPath(input.workingDirectory || process.cwd(), p);
	if (!abs) return null;
	const captured = captureImageAttachment(abs);
	if (!captured) return null;
	return { kind: 'image', mimeType: captured.mimeType, data: captured.data, sourcePath: abs };
}

/**
 * Persist an image attachment for this tool call into `tool_attachments`.
 * Returns the metadata, or null when there's no image (the common case: the
 * tool call isn't an image read). Never throws — a side-store failure must not
 * break the turn.
 */
export function flushToolAttachment(input: FlushInput): ToolAttachmentMeta | null {
	const img = resolveImage(input);
	if (!img) return null;
	try {
		const id = toolAttachments.insert({
			toolCallId: input.toolCallId,
			kind: img.kind,
			mimeType: img.mimeType,
			byteSize: img.data.length,
			sourcePath: img.sourcePath,
			data: img.data
		});
		return {
			id,
			toolCallId: input.toolCallId,
			kind: img.kind,
			mimeType: img.mimeType,
			byteSize: img.data.length
		};
	} catch (e) {
		log.warn('tool_attachment.flush_failed', {
			conversationId: input.conversationId,
			toolCallId: input.toolCallId,
			err: String(e)
		});
		return null;
	}
}
