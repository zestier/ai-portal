import { describe, it, expect, beforeEach } from 'vitest';
import { resolve, join, sep } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setupLocalEnv, resetServerSingletons } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

async function freshImport() {
	return await import('../src/lib/server/workdir');
}

describe('workdir resolution', () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await setupLocalEnv('portal-workdir-test-');
	});

	async function withProjectRoot(root: string) {
		process.env.PROJECT_ROOT = root;
		await resetServerSingletons();
		return freshImport();
	}

	describe('projectRoot', () => {
		it('returns the configured PROJECT_ROOT as an absolute path', async () => {
			const root = makeTmpDir('portal-proot-');
			const { projectRoot } = await withProjectRoot(root);
			expect(projectRoot()).toBe(resolve(root));
		});

		it('resolves a relative PROJECT_ROOT against cwd', async () => {
			const { projectRoot } = await withProjectRoot('some/rel/dir');
			expect(projectRoot()).toBe(resolve('some/rel/dir'));
		});
	});

	describe('effectiveWorkdir', () => {
		it('falls back to PROJECT_ROOT for empty/null/undefined stored values', async () => {
			const root = makeTmpDir('portal-proot-');
			const { effectiveWorkdir, projectRoot } = await withProjectRoot(root);
			expect(effectiveWorkdir(null)).toBe(projectRoot());
			expect(effectiveWorkdir(undefined)).toBe(projectRoot());
			expect(effectiveWorkdir('')).toBe(projectRoot());
		});

		it('returns a normalized absolute path for a real stored workdir', async () => {
			const root = makeTmpDir('portal-proot-');
			const { effectiveWorkdir } = await withProjectRoot(root);
			const stored = '/srv/projects/app/.';
			expect(effectiveWorkdir(stored)).toBe(resolve(stored));
		});

		it('resolves a relative stored workdir against cwd', async () => {
			const root = makeTmpDir('portal-proot-');
			const { effectiveWorkdir } = await withProjectRoot(root);
			expect(effectiveWorkdir('rel/work')).toBe(resolve('rel/work'));
		});

		it('routes the legacy workspaces dir itself back to PROJECT_ROOT', async () => {
			const root = makeTmpDir('portal-proot-');
			const { effectiveWorkdir, projectRoot } = await withProjectRoot(root);
			const legacy = resolve(dataDir, 'workspaces');
			expect(effectiveWorkdir(legacy)).toBe(projectRoot());
		});

		it('routes legacy per-conversation subdirs back to PROJECT_ROOT', async () => {
			const root = makeTmpDir('portal-proot-');
			const { effectiveWorkdir, projectRoot } = await withProjectRoot(root);
			const legacyChild = join(resolve(dataDir, 'workspaces'), 'conv-123');
			expect(effectiveWorkdir(legacyChild)).toBe(projectRoot());
		});

		it('does not treat a sibling that merely shares the legacy prefix as legacy', async () => {
			const root = makeTmpDir('portal-proot-');
			const { effectiveWorkdir } = await withProjectRoot(root);
			// `<dataDir>/workspaces-other` shares the string prefix but is not
			// inside `<dataDir>/workspaces/`, so it must be preserved.
			const sibling = resolve(dataDir, 'workspaces-other');
			expect(effectiveWorkdir(sibling)).toBe(sibling);
			expect(effectiveWorkdir(sibling)).not.toBe(resolve(root));
		});
	});

	describe('resolveAndValidate', () => {
		it('accepts an existing directory and returns its absolute path', async () => {
			const { resolveAndValidate } = await freshImport();
			const dir = makeTmpDir('portal-valid-wd-');
			const res = resolveAndValidate(dir);
			expect(res).toEqual({ ok: true, path: resolve(dir) });
		});

		it('normalizes traversal segments before validating', async () => {
			const { resolveAndValidate } = await freshImport();
			const dir = makeTmpDir('portal-valid-wd-');
			const messy = join(dir, 'sub', '..');
			const res = resolveAndValidate(messy);
			expect(res).toEqual({ ok: true, path: resolve(dir) });
		});

		it('rejects a path that does not exist', async () => {
			const { resolveAndValidate } = await freshImport();
			const missing = join(makeTmpDir('portal-valid-wd-'), 'nope');
			const res = resolveAndValidate(missing);
			expect(res).toEqual({ ok: false, reason: 'workdir does not exist' });
		});

		it('rejects a path that exists but is a file, not a directory', async () => {
			const { resolveAndValidate } = await freshImport();
			const dir = makeTmpDir('portal-valid-wd-');
			const file = join(dir, 'a.txt');
			writeFileSync(file, 'hi\n');
			const res = resolveAndValidate(file);
			expect(res).toEqual({ ok: false, reason: 'workdir is not a directory' });
		});
	});

	it('legacy containment is anchored at a path separator', async () => {
		// Guards the `startsWith(legacy + sep)` check: the trailing separator
		// is what prevents `workspaces-other` from being swallowed.
		const root = makeTmpDir('portal-proot-');
		const { effectiveWorkdir, projectRoot } = await withProjectRoot(root);
		const legacy = resolve(dataDir, 'workspaces');
		expect(effectiveWorkdir(legacy + sep + 'deep' + sep + 'nested')).toBe(projectRoot());
	});
});
