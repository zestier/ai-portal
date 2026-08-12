import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture } from '../scripts/golden-fixture.mjs';
import { makeTmpDir } from './helpers/tmp';
import { goldenToolImplementations } from './golden-conformance-impls';

const GOLDEN_DIR = fileURLToPath(new URL('./fixtures/golden', import.meta.url));

interface GoldenCase {
	tool: string;
	name: string;
	toolUseId: string;
	isError: boolean;
}

interface GoldenManifest {
	sdkVersion: string;
	model: string;
	fixtureRoot: string;
	cases: GoldenCase[];
}

interface GoldenCaseFile {
	args: Record<string, unknown>;
	content: unknown;
}

/**
 * The exact projection a portal tool implementation must emit for a
 * tool_result (the contract the pi path feeds the model). Mirrored here so the integrity test can
 * verify each golden `.text` is exactly the projection of its `.json`
 * content.
 */
function toolResultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
	return content
		.map((part) => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object' && 'text' in part) {
				const text = (part as { text?: unknown }).text;
				return typeof text === 'string' ? text : JSON.stringify(part);
			}
			return JSON.stringify(part);
		})
		.join('\n');
}

/**
 * Known-intentional divergences between the SDK built-in output and a portal
 * replacement, applied to BOTH sides before comparison. Byte-exactness is the
 * default contract; this list is the documented exception, so every entry
 * earns a comment:
 *  - absolute fixture paths: the capture fixture lived at the manifest's
 *    `fixtureRoot`; the test replays it in a fresh tmpdir. Stripping the root
 *    maps `/tmp/.../sample.txt` and the test's own root to the same relative
 *    path.
 *  - persisted-output paths: Bash truncation reports a machine- and
 *    session-unique `tool-results/<id>.txt`; the whole path token is
 *    normalized to a placeholder.
 * Beyond this list, `Grep` file listings (e.g. `Grep/files`) follow the
 * captured fixture's directory order, which is filesystem-dependent. The
 * portal implementation preserves rg's traversal order like the SDK does, so
 * a replay in a different tmpdir can differ; `sortGrepFileList` below sorts
 * the file block on BOTH sides, making the comparison order-independent. This
 * is the documented divergence anticipated above.
 * If a portal implementation introduces a NEW divergence, document it here
 * rather than loosening the comparison.
 */
function normalize(text: string, root: string): string {
	return text
		.replaceAll(root + '/', '')
		.replaceAll(root, '')
		.replace(/saved to: \S+/g, 'saved to: <PERSISTED_OUTPUT_PATH>');
}

// Grep file listings are "Found N file(s)\n<path>\n<path>..." in rg's
// filesystem-dependent traversal order. Sort the block after the summary line
// so replays in a fresh tmpdir compare equal to the capture.
function sortGrepFileList(text: string): string {
	const lines = text.split('\n');
	const index = lines.findIndex((line) => /^Found \d+ file/.test(line));
	if (index < 0 || index >= lines.length - 1) return text;
	return [...lines.slice(0, index + 1), ...lines.slice(index + 1).sort()].join('\n');
}

async function readCaseFile(c: GoldenCase, ext: string): Promise<string> {
	return readFile(join(GOLDEN_DIR, c.tool, `${c.name}.${ext}`), 'utf8');
}

describe('golden corpus integrity', () => {
	let manifest: GoldenManifest;

	beforeAll(async () => {
		manifest = JSON.parse(
			await readFile(join(GOLDEN_DIR, 'manifest.json'), 'utf8')
		) as GoldenManifest;
	});

	it('records a fixtureRoot so tests can normalize captured paths', () => {
		expect(manifest.fixtureRoot.length).toBeGreaterThan(0);
	});

	it('every manifest case has both .text and .json, and the .text is exactly the projection of the .json content', async () => {
		expect(manifest.cases.length).toBeGreaterThan(0);
		for (const c of manifest.cases) {
			const [text, json] = await Promise.all([readCaseFile(c, 'text'), readCaseFile(c, 'json')]);
			const file = JSON.parse(json) as GoldenCaseFile;
			expect(typeof file.args).toBe('object');
			expect(toolResultText(file.content), `${c.tool}/${c.name}`).toBe(text);
		}
	});

	it('every case was captured with its canonical args (actualArgs is a superset of args)', async () => {
		for (const c of manifest.cases) {
			const file = JSON.parse(await readCaseFile(c, 'json')) as GoldenCaseFile & {
				actualArgs?: Record<string, unknown>;
			};
			for (const [key, value] of Object.entries(file.args)) {
				expect(
					JSON.stringify(file.actualArgs?.[key]),
					`${c.tool}/${c.name} drifts arg ${key}`
				).toBe(JSON.stringify(value));
			}
		}
	});

	it('left no .error file behind (every case captured a tool result)', async () => {
		for (const c of manifest.cases) {
			await expect(
				readFile(join(GOLDEN_DIR, c.tool, `${c.name}.error`), 'utf8'),
				`${c.tool}/${c.name} has a leftover .error file`
			).rejects.toThrow();
		}
	});
});

describe('golden conformance: portal tool implementations', () => {
	let manifest: GoldenManifest;

	beforeAll(async () => {
		manifest = JSON.parse(
			await readFile(join(GOLDEN_DIR, 'manifest.json'), 'utf8')
		) as GoldenManifest;
	});

	it('a registered implementation reproduces the golden .text for its cases', async () => {
		const impls = goldenToolImplementations();
		const registered = manifest.cases.filter((c) => impls.has(c.tool));
		// The reroute tickets register implementations via
		// registerGoldenToolImplementation; until then this is vacuously green
		// and the integrity tests above still guard the corpus.
		for (const c of registered) {
			const file = JSON.parse(await readCaseFile(c, 'json')) as GoldenCaseFile;
			const cwd = makeTmpDir('golden-conformance-');
			await buildFixture(cwd);
			const impl = impls.get(c.tool);
			if (!impl) throw new Error(`unreachable: ${c.tool} not in registry`);
			const actual = await impl.render(c.name, file.args, { cwd });
			const golden = await readCaseFile(c, 'text');
			const normalizeBoth = (text: string, root: string): string => {
				const normalized = normalize(text, root);
				return c.tool === 'Grep' ? sortGrepFileList(normalized) : normalized;
			};
			expect(normalizeBoth(actual, cwd), `${c.tool}/${c.name}`).toBe(
				normalizeBoth(golden, manifest.fixtureRoot)
			);
		}
	});
});
