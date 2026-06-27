// Pure image detection + capture, with no dependency on any feature area.
//
// Detection is deliberately conservative: an extension allowlist gates which
// files we even look at, and a magic-byte sniff confirms the real format (and
// derives the mime). SVG is intentionally excluded — it is an XML/script vector,
// not a raster image we want to inline. The buffer-taking helpers are pure so
// they can be unit-tested without touching the filesystem.
//
// Used both by the `view`-tool attachment capture (copilot/image-attachment.ts)
// and the file browser's image preview (server/files.ts), so it lives in a
// neutral location neither feature owns.

import { statSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

// Hard ceiling on a single captured/served image. Larger images are skipped
// gracefully (no capture, no inline render) rather than loading huge blobs.
export const MAX_IMAGE_ATTACHMENT_BYTES = 5 * 1024 * 1024;

// Below this size the bytes are cheap enough to embed in a permission dialog as
// a base64 preview. Larger (but still under the hard cap) images are captured
// and rendered via an authed endpoint, but get no inline base64 preview.
export const MAX_IMAGE_PREVIEW_BYTES = 1.5 * 1024 * 1024;

const EXTENSION_MIME: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.bmp': 'image/bmp'
};

export function isAllowlistedImageExtension(path: string): boolean {
	return extname(path).toLowerCase() in EXTENSION_MIME;
}

/**
 * Sniff the leading bytes of a file to determine its image mime type. Returns
 * null when the bytes don't match a supported raster image signature. This is
 * the authority on the mime — the extension only decides whether we bother
 * reading the file.
 */
export function sniffImageMime(head: Uint8Array): string | null {
	const b = head;
	// PNG: 89 50 4E 47 0D 0A 1A 0A
	if (
		b.length >= 8 &&
		b[0] === 0x89 &&
		b[1] === 0x50 &&
		b[2] === 0x4e &&
		b[3] === 0x47 &&
		b[4] === 0x0d &&
		b[5] === 0x0a &&
		b[6] === 0x1a &&
		b[7] === 0x0a
	) {
		return 'image/png';
	}
	// JPEG: FF D8 FF
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		return 'image/jpeg';
	}
	// GIF: "GIF87a" / "GIF89a"
	if (
		b.length >= 6 &&
		b[0] === 0x47 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x38 &&
		(b[4] === 0x37 || b[4] === 0x39) &&
		b[5] === 0x61
	) {
		return 'image/gif';
	}
	// WEBP: "RIFF" .... "WEBP"
	if (
		b.length >= 12 &&
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	) {
		return 'image/webp';
	}
	// BMP: "BM"
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) {
		return 'image/bmp';
	}
	return null;
}

/**
 * Decide the mime for a path given its extension and head bytes. The extension
 * gates the lookup, and the magic bytes must sniff to a supported format
 * (the bytes are authoritative for the returned mime). Returns null otherwise.
 */
export function detectImageMime(path: string, head: Uint8Array): string | null {
	if (!isAllowlistedImageExtension(path)) return null;
	return sniffImageMime(head);
}

export interface CapturedImage {
	mimeType: string;
	data: Buffer;
}

/**
 * Read an image file at `absPath` if it is an allowlisted, magic-byte-confirmed
 * raster image within the size cap. Returns null (never throws) on any miss:
 * not an image, too large, missing, unreadable, content-excluded, etc.
 */
export function readImageFile(absPath: string): CapturedImage | null {
	try {
		if (!isAllowlistedImageExtension(absPath)) return null;
		const st = statSync(absPath);
		if (!st.isFile()) return null;
		if (st.size <= 0 || st.size > MAX_IMAGE_ATTACHMENT_BYTES) return null;
		const data = readFileSync(absPath);
		const mimeType = sniffImageMime(data.subarray(0, 16));
		if (!mimeType) return null;
		return { mimeType, data };
	} catch {
		return null;
	}
}
