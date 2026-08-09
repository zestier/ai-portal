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
// The corpus is the checked-in source of truth under tests/fixtures/golden/;
// `.zap/scratch/golden` is the disposable capture staging area. Re-capture
// after an SDK bump, review the diff, then copy the new corpus over the
// checked-in fixtures (move .zap/scratch/golden -> tests/fixtures/golden).
//
// Usage:
//   CLAUDE_AGENT_API_KEY=... pnpm run capture:tool-golden
//   GOLDEN_MODEL=... GOLDEN_DIR=... pnpm run capture:tool-golden -- --only Bash
//   pnpm run capture:tool-golden -- --dry-run     # print cases, call nothing
//   pnpm run capture:tool-golden -- --keep-work   # retain the fixture workspace after capture
//   (the fixture workspace under .zap/scratch/golden-work is deleted after a successful run)

import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildFixture } from './golden-fixture.mjs';

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
// Cases. Each is one forced tool call. Args are relative to WORK_DIR (the SDK
// runs with cwd=WORK_DIR) so captured text is portable across machines; the
// only remaining machine-specific bit is the Bash persisted-output path, which
// the conformance suite normalizes. `warmUp` prepends setup calls the CLI
// requires (Edit/Write demand a prior Read in the same session); those results
// are discarded — only the named tool's tool_result is captured.
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
	{ tool: 'Read', name: 'small', args: { file_path: 'sample.txt' } },
	{ tool: 'Read', name: 'range', args: { file_path: 'sample.txt', offset: 10, limit: 5 } },
	{ tool: 'Read', name: 'large', args: { file_path: 'big.txt' } },
	{ tool: 'Read', name: 'missing', args: { file_path: 'nope.txt' } },

	// Edit (SDK requires the file be Read first in the same session)
	{
		tool: 'Edit',
		name: 'replace',
		warmUp: [{ tool: 'Read', args: { file_path: 'sample.txt' } }],
		args: { file_path: 'sample.txt', old_string: 'gamma three', new_string: 'gamma THREE' }
	},
	{
		tool: 'Edit',
		name: 'replace_all',
		warmUp: [{ tool: 'Read', args: { file_path: 'sample.txt' } }],
		args: { file_path: 'sample.txt', old_string: 'twenty', new_string: 'TWENTY', replace_all: true }
	},
	{
		tool: 'Edit',
		name: 'not_found',
		warmUp: [{ tool: 'Read', args: { file_path: 'sample.txt' } }],
		args: { file_path: 'sample.txt', old_string: 'does not exist anywhere', new_string: 'nope' }
	},
	{
		tool: 'Edit',
		name: 'git_diff',
		warmUp: [{ tool: 'Read', args: { file_path: 'src/app.ts' } }],
		args: {
			file_path: 'src/app.ts',
			old_string: 'return value;',
			new_string: 'return value.toUpperCase();'
		}
	},

	// Write
	{ tool: 'Write', name: 'create', args: { file_path: 'new.txt', content: 'brand new\n' } },
	{
		tool: 'Write',
		name: 'overwrite',
		warmUp: [{ tool: 'Read', args: { file_path: 'sample.txt' } }],
		args: { file_path: 'sample.txt', content: 'completely replaced\n' }
	},
	{
		tool: 'Write',
		name: 'git_diff',
		warmUp: [{ tool: 'Read', args: { file_path: 'src/util.ts' } }],
		args: { file_path: 'src/util.ts', content: 'export const util = "v2";\n' }
	},

	// Glob
	{ tool: 'Glob', name: 'basic', args: { pattern: '**/*.ts' } },
	{ tool: 'Glob', name: 'none', args: { pattern: '*.nomatch' } },
	{ tool: 'Glob', name: 'ignored', args: { pattern: '**/*.js' } },

	// Grep
	{ tool: 'Grep', name: 'content', args: { pattern: 'line|one', path: 'sample.txt' } },
	{
		tool: 'Grep',
		name: 'files',
		args: { pattern: 'hello|golden', output_mode: 'files_with_matches' }
	},
	{
		tool: 'Grep',
		name: 'count',
		args: { pattern: 'line', output_mode: 'count', path: 'sample.txt' }
	},
	{ tool: 'Grep', name: 'context', args: { pattern: 'zeta', path: 'sample.txt', context: 2 } },
	{ tool: 'Grep', name: 'head_limit', args: { pattern: '.', head_limit: 5, path: 'sample.txt' } }
];

// ---------------------------------------------------------------------------
// Capture. Mirrors the portal's Claude-agent provider extraction so the golden
// text is exactly what the portal would feed the model. Only the named tool's
// tool_result is kept — warm-up calls (Read-before-Edit) and any stray calls
// the model makes to a tool the CLI has not enabled are discarded.
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

async function captureCase(workDir, { tool, args, warmUp = [] }) {
	const prompt = [
		...warmUp.map((w) => `First use the ${w.tool} tool to read: ${JSON.stringify(w.args)}`),
		`Then use the ${tool} tool with EXACTLY these arguments — do not modify, resolve, or add anything:\n${JSON.stringify(args)}`,
		`Call it exactly once, do not call any other tool after it, then answer only "done".`
	].join('\n\n');
	const abortController = new AbortController();
	const timer = setTimeout(() => abortController.abort(), 120_000);
	const result = {
		blocks: null,
		text: null,
		isError: null,
		toolUseId: null,
		actualArgs: null,
		error: null
	};
	const toolNameById = new Map();
	const toolInputById = new Map();
	try {
		const response = query({
			prompt,
			options: {
				cwd: workDir,
				env: env(),
				model: MODEL,
				tools: [...new Set([tool, ...warmUp.map((w) => w.tool)])],
				permissionMode: 'bypassPermissions',
				allowDangerouslySkipPermissions: true,
				maxTurns: 3,
				abortController
			}
		});
		for await (const message of response) {
			if (message.type === 'assistant' && Array.isArray(message.message.content)) {
				for (const block of message.message.content) {
					if (block.type === 'tool_use') {
						toolNameById.set(block.id, block.name);
						toolInputById.set(block.id, block.input);
					}
				}
			}
			if (message.type === 'user' && Array.isArray(message.message.content)) {
				for (const block of message.message.content) {
					if (block.type !== 'tool_result') continue;
					if (toolNameById.get(block.tool_use_id) !== tool) continue;
					// Keep the FIRST result from the named tool — the call that
					// directly answers the forced-args prompt. Later calls (model
					// deliberation) would pollute the golden.
					if (result.toolUseId !== null) continue;
					result.toolUseId = block.tool_use_id;
					result.actualArgs = toolInputById.get(block.tool_use_id) ?? null;
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

// True only when every key in `expected` is present in `actual` with an equal
// value. The model may add optional fields the schema allows (Bash
// `description`, Edit `replace_all: false`) without changing the call's
// meaning; those extras must not count as drift.
function argsSubset(actual, expected) {
	if (actual === null || typeof actual !== 'object') return false;
	return Object.entries(expected).every(
		([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value)
	);
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
	const manifest = {
		sdkVersion: SDK_VERSION,
		claudeCodeVersion: '2.1.224',
		model: MODEL,
		fixtureRoot: WORK_DIR,
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
		// Each case runs against a pristine fixture: earlier cases mutate files
		// (Edit/Write) and would otherwise change what later cases observe.
		await buildFixture(WORK_DIR);
		const r = await captureCase(WORK_DIR, c);
		if (r.text === null) {
			failed++;
			console.log(`NO TOOL RESULT${r.error ? ` — ${r.error}` : ''}`);
			await writeFile(join(outDir, `${c.name}.error`), r.error ?? 'no tool result');
			continue;
		}
		ran++;
		await writeFile(join(outDir, `${c.name}.text`), r.text);
		const drifted = !argsSubset(r.actualArgs, c.args);
		await writeFile(
			join(outDir, `${c.name}.json`),
			JSON.stringify(
				{
					args: c.args,
					actualArgs: r.actualArgs,
					toolUseId: r.toolUseId,
					isError: r.isError,
					content: r.blocks
				},
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
		console.log(
			`${r.isError ? `error (${r.text.length} bytes)` : `${r.text.length} bytes`}${drifted ? ' [drifted args]' : ''}`
		);
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
