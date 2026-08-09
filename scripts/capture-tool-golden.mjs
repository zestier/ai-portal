#!/usr/bin/env node
// Capture golden tool-result output from the real Claude Agent SDK CLI.
//
// For each canonical case this runs ONE `query()` turn that forces exactly one
// built-in tool call, then dumps the tool_result the MODEL would see to
// `.zap/scratch/golden/<tool>/<case>.<json|text>`:
//
//   - `.json` — the raw content blocks + tool metadata (tool_use_id, is_error),
//     so structured output (persistedOutputPath, gitDiff, image blocks) is kept
//     verbatim for later schema work.
//   - `.text` — the extracted text, mirroring the portal's `toolResultText`
//     (the same projection the portal's Claude-agent provider feeds the model).
//
// Why: rerouting each built-in tool to a portal implementation only preserves
// the built-in system prompt's instructions if the replacement emits the same
// rendered text the model was trained/prompted on. This text is the
// byte-fidelity contract for that rerouting. Structured shapes (sdk-tools.d.ts)
// guide the implementation; the golden text is the acceptance bar.
//
// Usage:
//   CLAUDE_AGENT_API_KEY=... pnpm run capture:tool-golden
//   GOLDEN_MODEL=... GOLDEN_DIR=... pnpm run capture:tool-golden -- --only Bash
//   pnpm run capture:tool-golden -- --dry-run     # print cases, call nothing
//   pnpm run capture:tool-golden -- --keep-work   # retain the fixture workspace after capture
//   (the fixture workspace under .zap/scratch/golden-work is deleted after a successful run)

import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const ONLY = argValue('--only');
const DRY_RUN = process.argv.includes('--dry-run');
const KEEP_WORK = process.argv.includes('--keep-work');
const MODEL = process.env.GOLDEN_MODEL ?? 'claude-sonnet-4-6';
// Same env contract as the Claude-agent provider: base URL optional.
const API_KEY = process.env.CLAUDE_AGENT_API_KEY;
const BASE_URL = process.env.CLAUDE_AGENT_BASE_URL;
if (!DRY_RUN && !API_KEY) {
	console.error('set CLAUDE_AGENT_API_KEY (or pass --dry-run)');
	process.exit(1);
}

const SDK_VERSION = '0.3.224'; // bump with package.json
const WORK_DIR = resolve(process.env.GOLDEN_WORK_DIR ?? '.zap/scratch/golden-work');
const OUT_DIR = resolve(process.env.GOLDEN_DIR ?? '.zap/scratch/golden');

function argValue(name) {
	const i = process.argv.indexOf(name);
	return i === -1 ? undefined : process.argv[i + 1];
}

// ---------------------------------------------------------------------------
// Fixtures: a disposable git repo exercising read/edit/write/grep/glob/bash in
// one realistic tree. Lives under .zap/scratch (already gitignored).
// ---------------------------------------------------------------------------

function git(...args) {
	execFileSync('git', args, { cwd: WORK_DIR, stdio: 'pipe' });
}

async function buildWorkspace() {
	await mkdir(WORK_DIR, { recursive: true });
	await rm(WORK_DIR, { recursive: true, force: true });
	await mkdir(join(WORK_DIR, 'src'), { recursive: true });
	await mkdir(join(WORK_DIR, 'node_modules', 'dep'), { recursive: true });

	const sample = [
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
	].join('\n');

	await writeFile(join(WORK_DIR, 'sample.txt'), sample + '\n');
	await writeFile(
		join(WORK_DIR, 'src', 'app.ts'),
		'import { helper } from "./util";\n\nexport function main() {\n\tconst value = helper("golden");\n\treturn value;\n}\n'
	);
	await writeFile(
		join(WORK_DIR, 'src', 'util.ts'),
		'export function helper(name: string): string {\n\treturn `hello ${name}`;\n}\n'
	);
	// Ignored tree, so Glob ignore semantics are observable.
	await writeFile(join(WORK_DIR, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
	await writeFile(join(WORK_DIR, '.gitignore'), 'node_modules/\n');

	// Large enough to exercise Read auto-pagination and Bash truncation.
	const big = Array.from({ length: 40_000 }, (_, i) => `line ${i + 1} of big file`).join('\n');
	await writeFile(join(WORK_DIR, 'big.txt'), big + '\n');

	git('init', '-q');
	git('config', 'user.email', 'golden@test.invalid');
	git('config', 'user.name', 'Golden Capture');
	git('add', '-A');
	git('commit', '-q', '-m', 'fixtures');
}

// ---------------------------------------------------------------------------
// Cases. Each is one forced tool call. args are supplied verbatim so the model
// has nothing to decide; the CLI's real pipeline (rendering, structured output,
// truncation, permission bypass) is what we are capturing.
// ---------------------------------------------------------------------------

const CASES = [
	// Bash
	{ tool: 'Bash', name: 'hello', args: { command: 'echo "hello world"' } },
	{
		tool: 'Bash',
		name: 'stderr',
		args: { command: 'printf "to stdout\\n"; printf "to stderr\\n" >&2' }
	},
	{ tool: 'Bash', name: 'nonzero', args: { command: 'exit 3' } },
	{ tool: 'Bash', name: 'large', args: { command: 'seq 1 100000' } },
	{ tool: 'Bash', name: 'git_status', args: { command: 'git status --porcelain' } },

	// Read
	{ tool: 'Read', name: 'small', args: { file_path: join(WORK_DIR, 'sample.txt') } },
	{
		tool: 'Read',
		name: 'range',
		args: { file_path: join(WORK_DIR, 'sample.txt'), offset: 10, limit: 5 }
	},
	{ tool: 'Read', name: 'large', args: { file_path: join(WORK_DIR, 'big.txt') } },
	{ tool: 'Read', name: 'missing', args: { file_path: join(WORK_DIR, 'nope.txt') } },

	// Edit
	{
		tool: 'Edit',
		name: 'replace',
		args: {
			file_path: join(WORK_DIR, 'sample.txt'),
			old_string: 'gamma three',
			new_string: 'gamma THREE'
		}
	},
	{
		tool: 'Edit',
		name: 'replace_all',
		args: {
			file_path: join(WORK_DIR, 'sample.txt'),
			old_string: 'line',
			new_string: 'LINE',
			replace_all: true
		}
	},
	{
		tool: 'Edit',
		name: 'not_found',
		args: {
			file_path: join(WORK_DIR, 'sample.txt'),
			old_string: 'does not exist anywhere',
			new_string: 'nope'
		}
	},
	{
		tool: 'Edit',
		name: 'git_diff',
		args: {
			file_path: join(WORK_DIR, 'src', 'app.ts'),
			old_string: 'return value;',
			new_string: 'return value.toUpperCase();'
		}
	},

	// Write
	{
		tool: 'Write',
		name: 'create',
		args: { file_path: join(WORK_DIR, 'new.txt'), content: 'brand new\n' }
	},
	{
		tool: 'Write',
		name: 'overwrite',
		args: { file_path: join(WORK_DIR, 'sample.txt'), content: 'completely replaced\n' }
	},
	{
		tool: 'Write',
		name: 'git_diff',
		args: {
			file_path: join(WORK_DIR, 'src', 'util.ts'),
			content: 'export const util = "v2";\n'
		}
	},

	// Glob
	{ tool: 'Glob', name: 'basic', args: { pattern: '**/*.ts' } },
	{ tool: 'Glob', name: 'none', args: { pattern: '*.nomatch' } },
	{ tool: 'Glob', name: 'ignored', args: { pattern: '**/*.js' } },

	// Grep
	{
		tool: 'Grep',
		name: 'content',
		args: { pattern: 'line|one', path: join(WORK_DIR, 'sample.txt') }
	},
	{
		tool: 'Grep',
		name: 'files',
		args: { pattern: 'hello|golden', output_mode: 'files_with_matches' }
	},
	{
		tool: 'Grep',
		name: 'count',
		args: { pattern: 'line', output_mode: 'count', path: join(WORK_DIR, 'sample.txt') }
	},
	{
		tool: 'Grep',
		name: 'context',
		args: { pattern: 'zeta', path: join(WORK_DIR, 'sample.txt'), context: 2 }
	},
	{
		tool: 'Grep',
		name: 'head_limit',
		args: { pattern: '.', head_limit: 5, path: join(WORK_DIR, 'sample.txt') }
	}
];

// ---------------------------------------------------------------------------
// Capture. Mirrors the portal's Claude-agent provider extraction so the golden
// text is exactly what the portal would feed the model.
// ---------------------------------------------------------------------------

function toolResultText(content) {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
	return content
		.map((part) => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object' && 'text' in part) {
				const text = part.text;
				return typeof text === 'string' ? text : JSON.stringify(part);
			}
			return JSON.stringify(part);
		})
		.join('\n');
}

function env() {
	return {
		...process.env,
		...(BASE_URL
			? {
					ANTHROPIC_BASE_URL: BASE_URL,
					ANTHROPIC_AUTH_TOKEN: API_KEY,
					ANTHROPIC_API_KEY: undefined
				}
			: { ANTHROPIC_API_KEY: API_KEY, ANTHROPIC_AUTH_TOKEN: undefined })
	};
}

async function captureCase(workDir, { tool, args }) {
	const prompt = `Use the ${tool} tool with exactly the following JSON arguments:\n${JSON.stringify(args)}\n\nMake the tool call, then answer only "done".`;
	const abortController = new AbortController();
	const timer = setTimeout(() => abortController.abort(), 120_000);
	const result = { blocks: [], text: null, isError: null, toolUseId: null, error: null };
	try {
		const response = query({
			prompt,
			options: {
				cwd: workDir,
				env: env(),
				model: MODEL,
				tools: [tool],
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
				maxTurns: 3,
				abortController
			}
		});
		for await (const message of response) {
			if (message.type === 'user' && Array.isArray(message.message.content)) {
				for (const block of message.message.content) {
					if (block.type !== 'tool_result') continue;
					result.toolUseId = block.tool_use_id;
					result.isError = block.is_error === true;
					result.text = toolResultText(block.content);
					result.blocks = block.content;
				}
			}
			if (message.type === 'result' && message.subtype !== 'success') {
				result.error = message.errors.join('\n');
			}
		}
	} catch (e) {
		result.error = e instanceof Error ? e.message : String(e);
	} finally {
		clearTimeout(timer);
	}
	return result;
}

async function main() {
	if (DRY_RUN) {
		for (const c of CASES) {
			if (ONLY && c.tool !== ONLY) continue;
			console.log(`${c.tool}/${c.name}`);
		}
		console.log(`\n${ONLY ? CASES.filter((c) => c.tool === ONLY).length : CASES.length} case(s).`);
		return;
	}
	await buildWorkspace();
	const manifest = {
		sdkVersion: SDK_VERSION,
		claudeCodeVersion: '2.1.224',
		model: MODEL,
		capturedAt: new Date().toISOString(),
		cases: []
	};
	let ran = 0;
	let failed = 0;
	for (const c of CASES) {
		if (ONLY && c.tool !== ONLY) continue;
		const outDir = join(OUT_DIR, c.tool);
		await mkdir(outDir, { recursive: true });
		process.stdout.write(`${c.tool}/${c.name} ... `);
		const r = await captureCase(WORK_DIR, c);
		if (r.text === null) {
			failed++;
			console.log(`NO TOOL RESULT${r.error ? ` — ${r.error}` : ''}`);
			await writeFile(join(outDir, `${c.name}.error`), r.error ?? 'no tool result');
			continue;
		}
		ran++;
		await writeFile(join(outDir, `${c.name}.text`), r.text);
		await writeFile(
			join(outDir, `${c.name}.json`),
			JSON.stringify(
				{ args: c.args, toolUseId: r.toolUseId, isError: r.isError, content: r.blocks },
				null,
				2
			)
		);
		manifest.cases.push({
			tool: c.tool,
			name: c.name,
			toolUseId: r.toolUseId,
			isError: r.isError
		});
		console.log(r.isError ? `error (${r.text.length} bytes)` : `${r.text.length} bytes`);
	}
	await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
	console.log(`\n${ran} captured, ${failed} failed → ${OUT_DIR}`);
	if (!KEEP_WORK) {
		await rm(WORK_DIR, { recursive: true, force: true });
		console.log(`fixture workspace cleaned (pass --keep-work to retain: ${WORK_DIR})`);
	}
	if (failed > 0) process.exitCode = 1;
}

main();
