import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { log } from '../log';

const PLUGINS_DIR = 'agent-plugins';

// Project-scoped plugin loader. `agent-plugins/` lives at the project root
// (the conversation's working directory) and every immediate subfolder is a
// Claude Agent SDK plugin. Folder-based on purpose: git submodules drop in as
// plain subfolders, so third-party plugins and repo-committed plugins both
// load through one path with no download or pinning. Detection is the SDK's
// own plugin contract — a `<plugin>/.claude-plugin/plugin.json` manifest —
// so `agent-plugins/` can also hold non-plugin folders without them being
// picked up. Missing folder or a subfolder without a manifest is silently
// skipped; a present-but-broken manifest is logged and skipped so one bad
// plugin can never fail a session.
export async function discoverRepoPlugins(workingDirectory: string): Promise<string[]> {
	const pluginsRoot = resolve(workingDirectory, PLUGINS_DIR);
	let entries;
	try {
		entries = await readdir(pluginsRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	const pluginPaths: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const pluginDir = resolve(pluginsRoot, entry.name);
		if (await isPlugin(pluginDir)) pluginPaths.push(pluginDir);
	}
	return pluginPaths;
}

async function isPlugin(pluginDir: string): Promise<boolean> {
	let raw: string;
	try {
		raw = await readFile(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8');
	} catch {
		// No manifest: not a plugin, skip silently.
		return false;
	}
	try {
		const manifest = JSON.parse(raw) as { name?: unknown };
		return typeof manifest.name === 'string' && manifest.name.length > 0;
	} catch {
		log.warn('claude_agent.repo_plugin.invalid_manifest', { plugin: pluginDir });
		return false;
	}
}
