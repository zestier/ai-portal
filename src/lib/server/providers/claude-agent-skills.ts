import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import extractZip from 'extract-zip';

const DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const PLUGINS = [
	{
		name: 'caveman',
		release: 'v1.10.0',
		revision: 'fcf7663366c217dc8f334a11028de52ed950ceab',
		sha256: '608460fe668c7dd719f963bf218778a4499140ad187e42a95a48280fd33b3853',
		url: 'https://github.com/JuliusBrussee/caveman/archive/fcf7663366c217dc8f334a11028de52ed950ceab.zip'
	},
	{
		name: 'ponytail',
		release: 'v4.9.0',
		revision: '0a4dd63ad4541f4f655c4108a295916f3c1d8fda',
		sha256: '8676bd99a35c1eead292010d2aa72d4c633d095a303cb469fe6fb9e786e42c6b',
		url: 'https://github.com/DietrichGebert/ponytail/archive/0a4dd63ad4541f4f655c4108a295916f3c1d8fda.zip'
	}
] as const;

const installs = new Map<string, Promise<string[]>>();

export function ensureClaudeAgentSkills(dataDir: string): Promise<string[]> {
	const installDir = resolve(
		dataDir,
		'claude-agent-skills',
		PLUGINS.map((plugin) => plugin.revision.slice(0, 12)).join('-')
	);
	let install = installs.get(installDir);
	if (!install) {
		install = installPlugins(installDir);
		installs.set(installDir, install);
		void install.catch(() => installs.delete(installDir));
	}
	return install;
}

async function installPlugins(installDir: string): Promise<string[]> {
	const pluginPaths = () => PLUGINS.map((plugin) => join(installDir, plugin.name));
	const markerPath = join(installDir, '.installed');
	try {
		if ((await readFile(markerPath, 'utf8')) === installMarker()) return pluginPaths();
	} catch {
		// A missing or stale marker rebuilds both complete plugins.
	}

	const temporaryDir = `${installDir}.tmp-${process.pid}-${Date.now()}`;
	await rm(temporaryDir, { recursive: true, force: true });
	try {
		await mkdir(temporaryDir, { recursive: true });
		await Promise.all(PLUGINS.map((plugin) => installPlugin(plugin, temporaryDir)));
		await writeFile(join(temporaryDir, '.installed'), installMarker(), 'utf8');
		await mkdir(resolve(installDir, '..'), { recursive: true });
		await rm(installDir, { recursive: true, force: true });
		await rename(temporaryDir, installDir);
		return pluginPaths();
	} catch (error) {
		await rm(temporaryDir, { recursive: true, force: true });
		throw error;
	}
}

async function installPlugin(plugin: (typeof PLUGINS)[number], temporaryDir: string) {
	const archivePath = join(temporaryDir, `${plugin.name}.zip`);
	const extractionDir = join(temporaryDir, `.extract-${plugin.name}`);
	const response = await fetch(plugin.url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
	});
	if (!response.ok) {
		throw new Error(
			`Failed to download ${plugin.name} ${plugin.release}: HTTP ${response.status}.`
		);
	}
	const contentLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
		throw new Error(`Downloaded ${plugin.name} archive exceeds the size limit.`);
	}
	const archive = Buffer.from(await response.arrayBuffer());
	if (archive.byteLength > MAX_ARCHIVE_BYTES) {
		throw new Error(`Downloaded ${plugin.name} archive exceeds the size limit.`);
	}
	verifyClaudeAgentSkillArchive(plugin.name, archive, plugin.sha256);
	await writeFile(archivePath, archive);
	await mkdir(extractionDir, { recursive: true });
	await extractZip(archivePath, { dir: extractionDir });

	const roots = (await readdir(extractionDir, { withFileTypes: true })).filter((entry) =>
		entry.isDirectory()
	);
	if (roots.length !== 1) throw new Error(`${plugin.name} archive has an invalid root layout.`);
	const extractedRoot = join(extractionDir, roots[0].name);
	const manifest = JSON.parse(
		await readFile(join(extractedRoot, '.claude-plugin', 'plugin.json'), 'utf8')
	) as { name?: unknown };
	if (manifest.name !== plugin.name) {
		throw new Error(`${plugin.name} archive has an invalid Claude plugin manifest.`);
	}
	await rename(extractedRoot, join(temporaryDir, plugin.name));
	await Promise.all([
		rm(archivePath, { force: true }),
		rm(extractionDir, { recursive: true, force: true })
	]);
}

export function verifyClaudeAgentSkillArchive(
	pluginName: string,
	archive: Uint8Array,
	expectedSha256: string
): void {
	const actualSha256 = createHash('sha256').update(archive).digest('hex');
	if (actualSha256 !== expectedSha256) {
		throw new Error(`Downloaded ${pluginName} archive failed its SHA-256 integrity check.`);
	}
}

function installMarker(): string {
	return `${PLUGINS.map(
		(plugin) => `${plugin.name}:${plugin.release}:${plugin.revision}:${plugin.sha256}`
	).join('\n')}\n`;
}
