import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resetConfigForTests } from '../../src/lib/server/config';
import { extensionId } from '../../src/lib/ids';
import { setupLocalEnv } from '../helpers/env';
import { makeTmpDir } from '../helpers/tmp';

describe('portal extensions service', () => {
	let projectRoot: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-ext-service-');
		projectRoot = makeTmpDir('portal-ext-project-');
		process.env.PROJECT_ROOT = projectRoot;
		await resetConfigForTests();
	});

	afterEach(() => {
		delete process.env.PROJECT_ROOT;
	});

	it('validateExtensionValue accepts pinned specs and rejects bare/unpinned/bad input', async () => {
		const { validateExtensionValue } = await import('../../src/lib/server/extensions');
		expect(validateExtensionValue('package', 'npm:scope/pkg@1.2.3')).toBeNull();
		expect(validateExtensionValue('package', 'npm:@scope/pkg@1.2.3')).toBeNull();
		expect(validateExtensionValue('package', 'git:github.com/user/repo@v1')).toBeNull();
		expect(validateExtensionValue('package', 'npm:scope/pkg')).toMatch(/explicit version\/ref/);
		expect(validateExtensionValue('package', 'git:github.com/user/repo')).toMatch(
			/explicit version\/ref/
		);
		expect(validateExtensionValue('package', 'npm:scope/pkg@')).toMatch(/explicit version\/ref/);
		expect(validateExtensionValue('package', '')).toMatch(/cannot be empty/);
		expect(validateExtensionValue('package', 'npm:'.padEnd(501, 'a'))).toMatch(/500/);
		expect(validateExtensionValue('file', 'extensions/my.ts')).toBeNull();
		expect(validateExtensionValue('inline', 'x'.repeat(100))).toBeNull();
		expect(validateExtensionValue('inline', '')).toMatch(/cannot be empty/);
		expect(validateExtensionValue('inline', 'x'.repeat(200_001))).toMatch(/200,000/);
	});

	it('materializes inline files under DATA_DIR and removes stale/disabled ones', async () => {
		const users = await import('../../src/lib/server/db/repos/users');
		const exts = await import('../../src/lib/server/db/repos/extensions');
		const svc = await import('../../src/lib/server/extensions');
		const user = users.ensureLocalUser();

		const e = exts.create(user.id, {
			name: 'Inline',
			kind: 'inline',
			value: 'export default () => 1',
			enabled: true
		});
		await svc.materializeInlineFiles(user.id);
		const file = join(svc.EXTENSION_DIR(loadConfig()), `portal-ext-${extensionId.parse(e.id)}.ts`);
		expect(readFileSync(file, 'utf8')).toBe('export default () => 1');

		// Content change → rewritten; no-op otherwise.
		exts.update(user.id, e.id, { value: 'export default () => 2' });
		await svc.materializeInlineFiles(user.id);
		expect(readFileSync(file, 'utf8')).toBe('export default () => 2');
		await svc.materializeInlineFiles(user.id);
		expect(readFileSync(file, 'utf8')).toBe('export default () => 2');

		// Disabled → file removed best-effort.
		exts.setEnabled(user.id, e.id, false);
		await svc.materializeInlineFiles(user.id);
		expect(existsSync(file)).toBe(false);
	});

	it('enabledExtensionPaths resolves kinds (file vs PROJECT_ROOT, inline vs DATA_DIR, package passthrough)', async () => {
		const users = await import('../../src/lib/server/db/repos/users');
		const exts = await import('../../src/lib/server/db/repos/extensions');
		const svc = await import('../../src/lib/server/extensions');
		const user = users.ensureLocalUser();

		const inline = exts.create(user.id, {
			name: 'Inline',
			kind: 'inline',
			value: 'export default () => 1'
		});
		const file = exts.create(user.id, {
			name: 'File',
			kind: 'file',
			value: 'extensions/thing.ts'
		});
		exts.create(user.id, {
			name: 'Pkg',
			kind: 'package',
			value: 'npm:foo@1.2.3'
		});

		const paths = await svc.enabledExtensionPaths(user.id);
		expect(paths).toContain(
			join(svc.EXTENSION_DIR(loadConfig()), `portal-ext-${extensionId.parse(inline.id)}.ts`)
		);
		expect(paths).toContain(join(projectRoot, 'extensions/thing.ts'));
		// Package spec passed through unchanged (the SDK resolves it).
		expect(paths).toContain('npm:foo@1.2.3');

		// Absolute file paths pass through.
		const abs = makeTmpDir('portal-ext-abs-');
		exts.create(user.id, { name: 'Abs', kind: 'file', value: abs });
		const paths2 = await svc.enabledExtensionPaths(user.id);
		expect(paths2).toContain(abs);

		// Disabled entries drop out.
		exts.setEnabled(user.id, file.id, false);
		const paths3 = await svc.enabledExtensionPaths(user.id);
		expect(paths3).not.toContain(join(projectRoot, 'extensions/thing.ts'));
	});

	it('fingerprint is stable across calls and changes on mutation', async () => {
		const users = await import('../../src/lib/server/db/repos/users');
		const exts = await import('../../src/lib/server/db/repos/extensions');
		const svc = await import('../../src/lib/server/extensions');
		const user = users.ensureLocalUser();

		// Empty set → stable.
		const empty1 = await svc.fingerprint(user.id);
		const empty2 = await svc.fingerprint(user.id);
		expect(empty1).toBe(empty2);
		expect(empty1).toMatch(/^[0-9a-f]{40}$/);

		// Adding an entry changes it; stable while unchanged.
		exts.create(user.id, { name: 'A', kind: 'inline', value: 'export default () => 1' });
		const one1 = await svc.fingerprint(user.id);
		const one2 = await svc.fingerprint(user.id);
		expect(one1).toBe(one2);
		expect(one1).not.toBe(empty1);

		// Value change (a package version bump counts) changes it.
		const a = exts.list(user.id)[0];
		exts.update(user.id, a.id, { value: 'export default () => 2' });
		const mutated = await svc.fingerprint(user.id);
		expect(mutated).not.toBe(one1);

		// Disabling changes it.
		exts.setEnabled(user.id, a.id, false);
		const disabled = await svc.fingerprint(user.id);
		expect(disabled).not.toBe(mutated);
	});

	it('verify reports loaded for a valid inline, error entries for a broken factory and a missing file, and never throws', async () => {
		const users = await import('../../src/lib/server/db/repos/users');
		const exts = await import('../../src/lib/server/db/repos/extensions');
		const svc = await import('../../src/lib/server/extensions');
		const user = users.ensureLocalUser();

		const valid = exts.create(user.id, {
			name: 'Valid',
			kind: 'inline',
			value: 'export default (pi) => {}'
		});
		const broken = exts.create(user.id, {
			name: 'Broken',
			kind: 'inline',
			value: 'export default (pi) => { throw new Error("boom"); }'
		});
		const missing = exts.create(user.id, {
			name: 'Missing',
			kind: 'file',
			value: 'does/not/exist.ts'
		});

		// Single-entry verify: the valid one loads.
		const ok = await svc.verify(user.id, valid.id);
		expect(ok.errors.length).toBe(0);
		expect(ok.loaded.some((p) => p.includes(`portal-ext-${extensionId.parse(valid.id)}.ts`))).toBe(
			true
		);

		// The broken factory never blocks and surfaces an error.
		const bad = await svc.verify(user.id, broken.id);
		expect(bad.errors.length).toBeGreaterThan(0);

		// A missing file path is a non-fatal verify error.
		const miss = await svc.verify(user.id, missing.id);
		expect(miss.loaded.length).toBe(0);
		expect(miss.errors.some((e) => e.path.includes('does/not/exist.ts'))).toBe(true);

		// Verify-all still never throws even with broken/missing entries.
		const all = await svc.verify(user.id);
		expect(all.loaded.length).toBeGreaterThanOrEqual(1);
		expect(all.errors.length).toBeGreaterThan(0);

		// Unknown id → error entry, never throws.
		const unknown = await svc.verify(user.id, 'EX999999');
		expect(unknown.errors.length).toBe(1);
	});
});
