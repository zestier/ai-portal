import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	safeResolve,
	listDir,
	readFileSafe,
	readImageFileSafe,
	resolveContainedToolPath
} from '../../src/lib/server/files';
import { realpathSync } from 'node:fs';

let root: string;
let outside: string;

// Probe symlink support at module load. `it.skipIf` is evaluated at test
// collection time — before `beforeAll` runs — so this can't live there.
const symlinksWork = (() => {
	const probe = mkdtempSync(join(tmpdir(), 'files-probe-'));
	try {
		symlinkSync(probe, join(probe, 'self'));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'files-test-'));
	outside = mkdtempSync(join(tmpdir(), 'files-outside-'));
	mkdirSync(join(root, 'sub'));
	writeFileSync(join(root, 'a.txt'), 'hello\n');
	writeFileSync(join(root, 'sub', 'b.txt'), 'world\n');
	writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET');
	if (symlinksWork) {
		symlinkSync(outside, join(root, 'escape'));
	}
	// Binary file.
	writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 5]));
	// A real PNG (8-byte signature + a NUL so the binary probe also flags it).
	writeFileSync(
		join(root, 'pic.png'),
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02])
	);
	// A .png extension whose bytes are NOT an image (and contain a NUL).
	writeFileSync(join(root, 'fake.png'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
	// SVG: text (no NUL) so it lands in the text branch; should be flagged image.
	writeFileSync(
		join(root, 'logo.svg'),
		'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>'
	);
	// .svg extension that isn't SVG markup → not flagged as image.
	writeFileSync(join(root, 'notreally.svg'), 'plain text, not svg');
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe('safeResolve', () => {
	it('resolves a simple relative path', () => {
		const r = safeResolve(root, 'a.txt');
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.rel).toBe('a.txt');
	});

	it('treats "" and "." as root', () => {
		expect(safeResolve(root, '').ok).toBe(true);
		expect(safeResolve(root, '.').ok).toBe(true);
	});

	it('rejects absolute paths', () => {
		const r = safeResolve(root, '/etc/passwd');
		expect(r.ok).toBe(false);
	});

	it('rejects "../" escape', () => {
		const r = safeResolve(root, '../foo');
		expect(r.ok).toBe(false);
	});

	it('rejects null bytes', () => {
		const r = safeResolve(root, 'a\0b');
		expect(r.ok).toBe(false);
	});

	it.skipIf(!symlinksWork)('rejects paths through escaping symlinks', () => {
		const r = safeResolve(root, 'escape/secret.txt');
		expect(r.ok).toBe(false);
	});

	it.skipIf(!symlinksWork)(
		'anchors a not-yet-existing tail on the deepest existing realpath',
		() => {
			// `missing` does not exist; the deepest existing prefix is root, so
			// the resolved abs must live under root's realpath, not be a bare
			// lexical join that a later out-of-root symlink could redirect.
			const r = safeResolve(root, 'missing/deep.txt');
			expect(r.ok).toBe(true);
			if (r.ok) {
				const inside = realpathSync(root);
				expect(r.abs.startsWith(inside)).toBe(true);
			}
		}
	);
});

describe('listDir', () => {
	it('lists directories first, then files alphabetically', () => {
		const r = listDir(root, '');
		expect(r.ok).toBe(true);
		if (r.ok) {
			const names = r.entries.map((e) => e.name);
			// "sub" (dir) should come before files.
			expect(names.indexOf('sub')).toBeLessThan(names.indexOf('a.txt'));
		}
	});

	it('404s on missing dir', () => {
		const r = listDir(root, 'no-such-dir');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(404);
	});

	it('400s on escape attempt', () => {
		const r = listDir(root, '../');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
	});
});

describe('readFileSafe', () => {
	it('reads text', async () => {
		const r = await readFileSafe(root, 'a.txt');
		expect(r.ok).toBe(true);
		if (r.ok && !('binary' in r && r.binary)) {
			expect((r as { content: string }).content).toBe('hello\n');
		}
	});

	it('detects binary', async () => {
		const r = await readFileSafe(root, 'bin.dat');
		expect(r.ok).toBe(true);
		if (r.ok) expect((r as { binary: boolean }).binary).toBe(true);
	});

	it('404s on missing', async () => {
		const r = await readFileSafe(root, 'no.txt');
		expect(r.ok).toBe(false);
	});

	it('flags a real image binary with its mime type', async () => {
		const r = await readFileSafe(root, 'pic.png');
		expect(r.ok).toBe(true);
		if (r.ok && 'binary' in r && r.binary) {
			expect(r.imageMimeType).toBe('image/png');
		} else {
			throw new Error('expected a binary image result');
		}
	});

	it('does not flag a non-image binary (or mis-typed .png) as an image', async () => {
		const bin = await readFileSafe(root, 'bin.dat');
		if (bin.ok && 'binary' in bin && bin.binary) expect(bin.imageMimeType).toBeUndefined();
		const fake = await readFileSafe(root, 'fake.png');
		if (fake.ok && 'binary' in fake && fake.binary) expect(fake.imageMimeType).toBeUndefined();
	});

	it('flags an SVG as a renderable image even though it is text', async () => {
		const r = await readFileSafe(root, 'logo.svg');
		expect(r.ok).toBe(true);
		if (r.ok && 'binary' in r && r.binary) {
			expect(r.imageMimeType).toBe('image/svg+xml');
		} else {
			throw new Error('expected an svg image result');
		}
	});

	it.skipIf(!symlinksWork)('refuses to read through a tail symlink that escapes root', async () => {
		const linkRel = 'leak.txt';
		symlinkSync(join(outside, 'secret.txt'), join(root, linkRel));
		try {
			const r = await readFileSafe(root, linkRel);
			expect(r.ok).toBe(false);
		} finally {
			rmSync(join(root, linkRel), { force: true });
		}
	});
});

describe('readImageFileSafe', () => {
	it('returns bytes + mime for a real image', () => {
		const r = readImageFileSafe(root, 'pic.png');
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.mimeType).toBe('image/png');
			expect(r.data.length).toBeGreaterThan(0);
		}
	});

	it('404s for a non-image / mis-typed path', () => {
		expect(readImageFileSafe(root, 'a.txt').ok).toBe(false);
		expect(readImageFileSafe(root, 'fake.png').ok).toBe(false);
	});

	it('serves sanitized SVG bytes', () => {
		const r = readImageFileSafe(root, 'logo.svg');
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.mimeType).toBe('image/svg+xml');
			expect(r.data.toString('utf-8')).not.toMatch(/<script/i);
			expect(r.data.toString('utf-8')).toContain('<rect');
		}
	});

	it('400s on an escape attempt and never serves out-of-root files', () => {
		const r = readImageFileSafe(root, '../foo.png');
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.status).toBe(400);
	});
});

describe('resolveContainedToolPath', () => {
	it('resolves an in-workspace relative path to its absolute realpath', () => {
		const abs = resolveContainedToolPath(root, 'pic.png');
		expect(abs).toBe(realpathSync(join(root, 'pic.png')));
	});

	it('accepts an absolute path that falls inside the root', () => {
		const inside = join(root, 'sub', 'b.txt');
		expect(resolveContainedToolPath(root, inside)).toBe(realpathSync(inside));
	});

	it('rejects an absolute path outside the root', () => {
		// The core of the vuln: a model-supplied absolute path anywhere on the
		// host must not resolve to a readable target.
		expect(resolveContainedToolPath(root, join(outside, 'secret.txt'))).toBeNull();
		expect(resolveContainedToolPath(root, '/etc/passwd')).toBeNull();
	});

	it('rejects a "../" escape from a relative path', () => {
		expect(resolveContainedToolPath(root, '../foo.png')).toBeNull();
		expect(resolveContainedToolPath(root, '../../etc/hosts')).toBeNull();
	});

	it('rejects empty / null-byte paths', () => {
		expect(resolveContainedToolPath(root, '')).toBeNull();
		expect(resolveContainedToolPath(root, 'a\0b')).toBeNull();
	});

	it.skipIf(!symlinksWork)('rejects an absolute path reached via an escaping symlink', () => {
		expect(resolveContainedToolPath(root, join(root, 'escape', 'secret.txt'))).toBeNull();
	});

	it.skipIf(!symlinksWork)(
		'accepts an in-workspace absolute path when the root itself is a symlink',
		() => {
			// Regression: the model names files using the lexical workingDirectory.
			// If the root is a symlink, converting an absolute path against the
			// realpath root would turn a legitimate file into a false `..` escape.
			const linkRoot = mkdtempSync(join(tmpdir(), 'files-linkparent-'));
			const linkedRoot = join(linkRoot, 'link');
			symlinkSync(root, linkedRoot);
			try {
				// Lexical root differs from its realpath (`root`); an absolute path
				// under the lexical root must still resolve and capture.
				const abs = resolveContainedToolPath(linkedRoot, join(linkedRoot, 'pic.png'));
				expect(abs).toBe(realpathSync(join(root, 'pic.png')));
				// Out-of-root absolute paths are still rejected through the symlinked root.
				expect(resolveContainedToolPath(linkedRoot, join(outside, 'secret.txt'))).toBeNull();
			} finally {
				rmSync(linkRoot, { recursive: true, force: true });
			}
		}
	);
});
