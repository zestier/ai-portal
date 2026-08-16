import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	zapDir,
	zapSubdir,
	scratchDir,
	scratchSubdir,
	ensureZapGitignore
} from '../../../src/lib/server/tools/zap-dir';
import { makeTmpDir } from '../../helpers/tmp';

describe('zap-dir', () => {
	it('defaults to .zap when ZAP_DIR is unset', () => {
		expect(zapDir({})).toBe('.zap');
	});

	it('honors a valid single-segment ZAP_DIR override', () => {
		expect(zapDir({ ZAP_DIR: '.portal' })).toBe('.portal');
		expect(zapDir({ ZAP_DIR: '  .portal  ' })).toBe('.portal');
	});

	it('falls back to the default for unsafe overrides', () => {
		for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'x\0y', '/abs']) {
			expect(zapDir({ ZAP_DIR: bad })).toBe('.zap');
		}
	});

	it('builds config paths directly under the dir', () => {
		expect(zapSubdir('config.json', {})).toBe('.zap/config.json');
		expect(zapSubdir('config.json', { ZAP_DIR: '.portal' })).toBe('.portal/config.json');
	});

	it('builds ephemeral paths under the scratch tree', () => {
		expect(scratchDir({})).toBe('.zap/scratch');
		expect(scratchSubdir('trash', {})).toBe('.zap/scratch/trash');
		expect(scratchSubdir('notes', { ZAP_DIR: '.portal' })).toBe('.portal/scratch/notes');
	});
});

describe('ensureZapGitignore', () => {
	let root: string;
	beforeEach(() => {
		root = makeTmpDir('zapignore-');
	});

	it('creates .zap/.gitignore ignoring the scratch tree', async () => {
		await ensureZapGitignore(root);
		const file = join(root, '.zap', '.gitignore');
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, 'utf-8')).toContain('/scratch/');
	});

	it('honors a ZAP_DIR override for the location', async () => {
		await ensureZapGitignore(root, { ZAP_DIR: '.portal' });
		expect(existsSync(join(root, '.portal', '.gitignore'))).toBe(true);
	});

	it('never clobbers an existing file', async () => {
		mkdirSync(join(root, '.zap'), { recursive: true });
		writeFileSync(join(root, '.zap', '.gitignore'), '# mine\n');
		await ensureZapGitignore(root);
		expect(readFileSync(join(root, '.zap', '.gitignore'), 'utf-8')).toBe('# mine\n');
	});

	it('is idempotent across repeated calls', async () => {
		await ensureZapGitignore(root);
		const first = readFileSync(join(root, '.zap', '.gitignore'), 'utf-8');
		await ensureZapGitignore(root);
		expect(readFileSync(join(root, '.zap', '.gitignore'), 'utf-8')).toBe(first);
	});
});
