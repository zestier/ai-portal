import { describe, it, expect, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';
import {
	sniffImageMime,
	detectImageMime,
	captureImageAttachment,
	isAllowlistedImageExtension,
	MAX_IMAGE_ATTACHMENT_BYTES
} from '../src/lib/server/copilot/image-attachment';
import {
	bufferAttachment,
	takeAttachment,
	dropAttachment,
	toolCallKey,
	pathKey,
	_bufferSize,
	_clearBuffer
} from '../src/lib/server/copilot/tool-attachment-buffer';
import { correlationKeys } from '../src/lib/server/copilot/tool-attachment-flush';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP_HEADER = Buffer.from([
	0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
]);
const BMP_HEADER = Buffer.from([0x42, 0x4d, 0x00, 0x00]);

describe('image-attachment detection', () => {
	it('sniffs the supported raster formats from magic bytes', () => {
		expect(sniffImageMime(PNG_HEADER)).toBe('image/png');
		expect(sniffImageMime(JPEG_HEADER)).toBe('image/jpeg');
		expect(sniffImageMime(GIF_HEADER)).toBe('image/gif');
		expect(sniffImageMime(WEBP_HEADER)).toBe('image/webp');
		expect(sniffImageMime(BMP_HEADER)).toBe('image/bmp');
	});

	it('returns null for non-image / truncated bytes', () => {
		expect(sniffImageMime(Buffer.from('not an image'))).toBeNull();
		expect(sniffImageMime(Buffer.from([0x89, 0x50]))).toBeNull();
		// SVG is intentionally excluded — it's XML, not a raster signature.
		expect(sniffImageMime(Buffer.from('<svg xmlns="..."></svg>'))).toBeNull();
	});

	it('gates the allowlist by extension AND magic bytes', () => {
		expect(isAllowlistedImageExtension('a.png')).toBe(true);
		expect(isAllowlistedImageExtension('a.PNG')).toBe(true);
		expect(isAllowlistedImageExtension('a.svg')).toBe(false);
		expect(isAllowlistedImageExtension('a.txt')).toBe(false);
		// non-allowlisted ext even with valid bytes → null
		expect(detectImageMime('a.txt', PNG_HEADER)).toBeNull();
		// magic bytes are authoritative for the mime even if the extension
		// disagrees (a .png that is really a jpeg is reported as jpeg).
		expect(detectImageMime('a.png', JPEG_HEADER)).toBe('image/jpeg');
		// allowlisted ext but bytes aren't an image at all → null
		expect(detectImageMime('a.png', Buffer.from('nope'))).toBeNull();
		expect(detectImageMime('a.png', PNG_HEADER)).toBe('image/png');
	});
});

describe('captureImageAttachment', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTmpDir('portal-image-capture-');
	});

	it('captures a real png file', () => {
		const p = join(dir, 'shot.png');
		const body = Buffer.concat([PNG_HEADER, Buffer.alloc(32, 1)]);
		writeFileSync(p, body);
		const captured = captureImageAttachment(p);
		expect(captured).not.toBeNull();
		expect(captured!.mimeType).toBe('image/png');
		expect(captured!.data.length).toBe(body.length);
	});

	it('skips non-image and oversized and missing files gracefully', () => {
		const txt = join(dir, 'notes.txt');
		writeFileSync(txt, 'hello');
		expect(captureImageAttachment(txt)).toBeNull();

		// allowlisted extension but content isn't an image
		const fake = join(dir, 'fake.png');
		writeFileSync(fake, 'definitely not a png');
		expect(captureImageAttachment(fake)).toBeNull();

		expect(captureImageAttachment(join(dir, 'missing.png'))).toBeNull();

		const big = join(dir, 'big.png');
		writeFileSync(
			big,
			Buffer.concat([PNG_HEADER, Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1, 2)])
		);
		expect(captureImageAttachment(big)).toBeNull();
	});
});

describe('attachment buffer + flush correlation', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-attach-buffer-');
		_clearBuffer();
	});

	function buffered(sourcePath = '/abs/shot.png') {
		return {
			kind: 'image' as const,
			mimeType: 'image/png',
			data: Buffer.from(PNG_HEADER),
			sourcePath,
			bufferedAt: Date.now()
		};
	}

	it('takes by toolCallId key and clears all aliases', () => {
		const keys = [pathKey('conv1', '/abs/shot.png'), toolCallKey('tc1')];
		bufferAttachment(keys, buffered());
		expect(_bufferSize()).toBe(2);

		// flush correlates by toolCallId first
		const got = takeAttachment(
			correlationKeys({
				toolCallId: 'tc1',
				conversationId: 'conv1',
				workingDirectory: '/abs',
				argsJson: JSON.stringify({ path: 'shot.png' })
			})
		);
		expect(got).not.toBeNull();
		expect(got!.mimeType).toBe('image/png');
		// both aliases removed → no double flush
		expect(_bufferSize()).toBe(0);
	});

	it('falls back to conversation+path when no toolCallId alias was stored', () => {
		// permission request carried no toolCallId, so only the path key exists
		bufferAttachment([pathKey('conv1', '/work/shot.png')], buffered('/work/shot.png'));
		const got = takeAttachment(
			correlationKeys({
				toolCallId: 'tc-exec-only',
				conversationId: 'conv1',
				workingDirectory: '/work',
				argsJson: JSON.stringify({ path: 'shot.png' })
			})
		);
		expect(got).not.toBeNull();
		expect(_bufferSize()).toBe(0);
	});

	it('drop removes staged bytes (deny path)', () => {
		const keys = [pathKey('conv1', '/abs/shot.png'), toolCallKey('tc1')];
		bufferAttachment(keys, buffered());
		dropAttachment(keys);
		expect(_bufferSize()).toBe(0);
		expect(takeAttachment([toolCallKey('tc1')])).toBeNull();
	});

	it('correlationKeys derives an absolute path key from relative args', () => {
		const keys = correlationKeys({
			toolCallId: 'tc9',
			conversationId: 'convX',
			workingDirectory: '/ws',
			argsJson: JSON.stringify({ path: 'sub/img.png' })
		});
		expect(keys).toContain(toolCallKey('tc9'));
		expect(keys).toContain(pathKey('convX', '/ws/sub/img.png'));
	});
});
