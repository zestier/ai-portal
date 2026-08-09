// Shared golden-capture fixture. One deterministic git tree, used BOTH by
// scripts/capture-tool-golden.mjs (which captures goldens from the real SDK
// built-ins) and tests/golden-conformance.test.ts (which replays the same tree
// to reproduce them against a portal tool implementation). The captured `.text`
// files are the byte-fidelity contract, so this tree must stay byte-identical
// on both sides — change it and re-capture.
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SAMPLE_LINES = [
	'alpha one',
	'beta two',
	'gamma three',
	'delta four',
	'epsilon five',
	'zeta six',
	'eta seven',
	'theta eight',
	'iota nine',
	'kappa ten',
	'lambda eleven',
	'mu twelve',
	'nu thirteen',
	'xi fourteen',
	'omicron fifteen',
	'pi sixteen',
	'rho seventeen',
	'sigma eighteen',
	'tau nineteen',
	'upsilon twenty',
	'phi twenty one',
	'chi twenty two',
	'psi twenty three',
	'omega twenty four'
];

/** Static fixture files, keyed by workspace-relative path. */
export const FIXTURE_FILES = {
	'sample.txt': SAMPLE_LINES.join('\n') + '\n',
	'src/app.ts':
		'import { helper } from "./util";\n\nexport function main() {\n\tconst value = helper("golden");\n\treturn value;\n}\n',
	'src/util.ts': 'export function helper(name: string): string {\n\treturn `hello ${name}`;\n}\n',
	// Ignored tree, so Glob ignore semantics are observable.
	'node_modules/dep/index.js': 'module.exports = 1;\n',
	'.gitignore': 'node_modules/\n'
};

/** Line count for the generated big.txt; large enough to trip the Read size cap. */
export const BIG_LINE_COUNT = 40_000;

/** The generated big.txt content. */
export function bigText() {
	return (
		Array.from({ length: BIG_LINE_COUNT }, (_, i) => `line ${i + 1} of big file`).join('\n') + '\n'
	);
}

/**
 * (Re)build the fixture git workspace at `dir`. Destroys any prior content.
 * The tree must match what the goldens were captured against.
 * @param {string} dir
 */
export async function buildFixture(dir) {
	await mkdir(dir, { recursive: true });
	await rm(dir, { recursive: true, force: true });
	for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
		const abs = join(dir, rel);
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, content);
	}
	await writeFile(join(dir, 'big.txt'), bigText());
	git(dir, 'init', '-q');
	git(dir, 'config', 'user.email', 'golden@test.invalid');
	git(dir, 'config', 'user.name', 'Golden Capture');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', 'fixtures');
}

/**
 * @param {string} dir
 * @param {string[]} args
 */
function git(dir, ...args) {
	execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
}
