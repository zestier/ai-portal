import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverRepoPlugins } from '../src/lib/server/providers/claude-agent-repo-plugins';
import { makeTmpDir } from './helpers/tmp';

function pluginDir(root: string, name: string): string {
	const dir = join(root, 'agent-plugins', name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe('discoverRepoPlugins', () => {
	it('returns an empty list when agent-plugins does not exist', async () => {
		const root = makeTmpDir('portal-repo-plugin-');
		await expect(discoverRepoPlugins(root)).resolves.toEqual([]);
	});

	it('returns plugin folders carrying a valid manifest', async () => {
		const root = makeTmpDir('portal-repo-plugin-');
		const good = pluginDir(root, 'repo-skills');
		mkdirSync(join(good, '.claude-plugin'), { recursive: true });
		writeFileSync(
			join(good, '.claude-plugin', 'plugin.json'),
			JSON.stringify({ name: 'repo-skills', version: '1.0.0' })
		);

		await expect(discoverRepoPlugins(root)).resolves.toEqual([good]);
	});

	it('skips subfolders without a manifest and hidden folders', async () => {
		const root = makeTmpDir('portal-repo-plugin-');
		const good = pluginDir(root, 'repo-skills');
		mkdirSync(join(good, '.claude-plugin'), { recursive: true });
		writeFileSync(join(good, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 's' }));
		pluginDir(root, 'not-a-plugin');
		pluginDir(root, '.git');

		await expect(discoverRepoPlugins(root)).resolves.toEqual([good]);
	});

	it('skips a folder whose manifest is not valid JSON', async () => {
		const root = makeTmpDir('portal-repo-plugin-');
		const broken = pluginDir(root, 'broken');
		mkdirSync(join(broken, '.claude-plugin'), { recursive: true });
		writeFileSync(join(broken, '.claude-plugin', 'plugin.json'), 'not json');

		await expect(discoverRepoPlugins(root)).resolves.toEqual([]);
	});

	it('skips a folder whose manifest lacks a name', async () => {
		const root = makeTmpDir('portal-repo-plugin-');
		const unnamed = pluginDir(root, 'unnamed');
		mkdirSync(join(unnamed, '.claude-plugin'), { recursive: true });
		writeFileSync(join(unnamed, '.claude-plugin', 'plugin.json'), JSON.stringify({}));

		await expect(discoverRepoPlugins(root)).resolves.toEqual([]);
	});
});
