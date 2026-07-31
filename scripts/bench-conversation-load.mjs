#!/usr/bin/env node
// Benchmark: how expensive is *opening* a long conversation?
//
// Seeds a synthetic conversation (~100 messages / ~600 tool calls / ~180
// reasoning blocks, with result sizes drawn to match the real distribution
// observed in a production ./data/portal.db — median small, tail up to
// ~280 KB) into a throwaway DATA_DIR, serves it from a production build, and
// reports two numbers:
//
//   ssrBytes  — bytes of SSR HTML the server ships for the conversation page.
//   ttiMs     — time from navigation start until the transcript is mounted,
//               hydrated and scrolled to the bottom (i.e. usable).
//
// Also reports `fullRenderMs` (every message mounted) so progressive rendering
// can be seen to finish, not just to defer.
//
// Recorded numbers for the default seed (100 messages / 600 tool calls /
// 180 reasoning blocks / 2.43 MB of text at rest, seed 1337), measured in a
// dev container:
//
//                        before            after
//   transcript payload   2.43 MB           462.7 KB    (5.4x smaller)
//   full page HTML       2.68 MB           736.5 KB    (3.7x smaller)
//   TTI (median)         615 ms            161 ms      (-74%)
//   fully rendered       615 ms            395 ms
//
// "before" was taken by disabling both halves of the change (the
// `inlineMaxBytes` option on the conversation page load, and Chat.svelte's
// deferred-render window) and re-running against the identical seeded data.
//
// Usage:
//   pnpm bench:conversation-load
//   pnpm bench:conversation-load -- --messages 100 --tool-calls 600 --runs 3
//
// The build is reused if `build/` already exists; pass `--build` to force a
// rebuild. The temp DATA_DIR is left on disk for post-mortem.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function parseArgs(argv) {
	const opts = {
		messages: 100,
		toolCalls: 600,
		reasoningBlocks: 180,
		runs: 3,
		build: false,
		serve: false,
		seed: 1337,
		json: false
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const num = () => Number(argv[++i]);
		// pnpm inserts a bare `--` separator before forwarded flags.
		if (a === '--') continue;
		if (a === '--messages') opts.messages = num();
		else if (a === '--tool-calls') opts.toolCalls = num();
		else if (a === '--reasoning-blocks') opts.reasoningBlocks = num();
		else if (a === '--runs') opts.runs = num();
		else if (a === '--seed') opts.seed = num();
		else if (a === '--build') opts.build = true;
		else if (a === '--serve') opts.serve = true;
		else if (a === '--json') opts.json = true;
		else if (a === '--help' || a === '-h') {
			console.log(
				'Usage: pnpm bench:conversation-load [--messages N] [--tool-calls N] [--reasoning-blocks N] [--runs N] [--seed N] [--build] [--serve] [--json]'
			);
			process.exit(0);
		} else throw new Error(`unknown argument: ${a}`);
	}
	return opts;
}

// Deterministic PRNG so two runs (baseline vs. after) seed byte-identical data.
function mulberry32(a) {
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function freePort() {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.on('error', rej);
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => res(port));
		});
	});
}

async function waitForHealth(baseUrl, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const r = await fetch(`${baseUrl}/api/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		if (Date.now() > deadline) throw new Error('server did not become healthy in time');
		await new Promise((r) => setTimeout(r, 250));
	}
}

// Mutating /api/* calls require an Origin match *and* a double-submit CSRF
// token: the value is pinned in an httpOnly cookie and echoed back in the
// X-CSRF-Token header. Prime both by loading any page first.
async function csrfHandshake(baseUrl) {
	const res = await fetch(`${baseUrl}/`, { redirect: 'manual' });
	const setCookies = res.headers.getSetCookie?.() ?? [];
	await res.arrayBuffer().catch(() => {});
	const cookiePairs = setCookies.map((c) => c.split(';')[0]);
	const csrfPair = cookiePairs.find((c) => c.startsWith('portal_csrf='));
	if (!csrfPair) throw new Error('no CSRF cookie issued by the server');
	return { cookie: cookiePairs.join('; '), token: csrfPair.split('=')[1] };
}

// ---------------------------------------------------------------------------
// Synthetic transcript
// ---------------------------------------------------------------------------

function lorem(rand, bytes) {
	const words = [
		'portal',
		'conversation',
		'tool',
		'result',
		'render',
		'payload',
		'hydrate',
		'sqlite',
		'stream',
		'message',
		'benchmark',
		'threshold'
	];
	let out = '';
	while (out.length < bytes) out += words[Math.floor(rand() * words.length)] + ' ';
	return out.slice(0, bytes);
}

// Field sizes are heavily skewed and the shape matters: the trim keeps small
// fields inline, so a benchmark with the wrong distribution measures the wrong
// thing. These bands are fitted to per-band counts and byte sums measured
// (read-only) on the worst real conversation in a production ./data/portal.db —
// 92 messages, 604 tool calls, 355 KB of `args_json`, 1.58 MB of `result_json`,
// 132 KB of message content and 131 KB of reasoning text.
//
// Each entry is [probability, minBytes, maxBytes]; draws are log-uniform within
// a band so a 2x-wide band reproduces the observed mean (~1.44x its floor)
// rather than collapsing onto its midpoint.
const ARGS_BANDS = [
	[0.5762, 60, 256], // 348 calls, 47 KB
	[0.1623, 256, 512], // 98 calls, 35 KB
	[0.1159, 512, 1024], // 70 calls, 49 KB
	[0.0712, 1024, 2048], // 43 calls, 62 KB
	[0.053, 2048, 4096], // 32 calls, 88 KB
	[0.0199, 4096, 8192], // 12 calls, 64 KB
	[0.0017, 8192, 16384] // 1 call, 10 KB
];
const RESULT_BANDS = [
	[0.0787, 60, 256], // 47 calls, 7 KB
	[0.0653, 256, 512], // 39 calls, 15 KB
	[0.2245, 512, 1024], // 134 calls, 107 KB
	[0.273, 1024, 2048], // 163 calls, 225 KB
	[0.1893, 2048, 4096], // 113 calls, 322 KB
	[0.0972, 4096, 8192], // 58 calls, 324 KB
	[0.0536, 8192, 16384], // 32 calls, 340 KB
	[0.0168, 16384, 32768], // 10 calls, 203 KB
	[0.0017, 32768, 65536] // 1 call, 41 KB
];

function drawFromBands(rand, bands) {
	let r = rand();
	for (const [p, lo, hi] of bands) {
		if (r < p) {
			// Log-uniform within the band keeps the heavy tail from collapsing
			// onto its own midpoint.
			const t = rand();
			return Math.round(Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo))));
		}
		r -= p;
	}
	const [, lo, hi] = bands[bands.length - 1];
	return Math.round((lo + hi) / 2);
}

function drawResultBytes(rand) {
	return drawFromBands(rand, RESULT_BANDS);
}

function drawArgsBytes(rand) {
	return drawFromBands(rand, ARGS_BANDS);
}

// Builds a JSON string whose *serialized* length hits `targetBytes`, so the
// band distributions above describe the bytes that actually reach the payload
// rather than the filler inside the envelope.
function jsonOfSize(rand, envelope, fillKey, targetBytes) {
	const overhead = JSON.stringify({ ...envelope, [fillKey]: '' }).length;
	return JSON.stringify({
		...envelope,
		[fillKey]: lorem(rand, Math.max(0, targetBytes - overhead))
	});
}

function seedConversation(db, conversationId, opts) {
	const rand = mulberry32(opts.seed);
	const now = Date.now() - opts.messages * 60_000;

	const insertMsg = db.prepare(
		`INSERT INTO messages(id, conversation_id, role, content, status, error_code, created_at, reasoning, reasoning_duration_ms)
		 VALUES (?, ?, ?, ?, 'complete', NULL, ?, NULL, NULL)`
	);
	const insertTool = db.prepare(
		`INSERT INTO tool_calls(id, message_id, tool, args_json, result_json, status, started_at, ended_at, text_offset, parent_tool_call_id)
		 VALUES (?, ?, ?, ?, ?, 'ok', ?, ?, ?, NULL)`
	);
	const insertReasoning = db.prepare(
		`INSERT INTO reasoning_blocks(id, message_id, segment_index, text, kind, text_offset, started_at, duration_ms, parent_tool_call_id)
		 VALUES (?, ?, ?, ?, 'reasoning', ?, ?, ?, NULL)`
	);
	const insertEdit = db.prepare(
		`INSERT INTO file_edits(id, message_id, path, diff, created_at, text_offset, parent_tool_call_id)
		 VALUES (?, ?, ?, ?, ?, ?, NULL)`
	);

	const tools = ['bash', 'view', 'grep', 'glob', 'edit', 'git_status', 'task'];
	let seq = 0;
	const nextId = (p) => `${p}${String(++seq).padStart(10, '0')}bench`;

	const stats = {
		messages: 0,
		toolCalls: 0,
		reasoningBlocks: 0,
		fileEdits: 0,
		dbBytes: 0,
		contentBytes: 0,
		argsBytes: 0,
		resultBytes: 0,
		reasoningBytes: 0,
		diffBytes: 0
	};
	// Assistant messages carry the tool calls; distribute evenly across them.
	const assistantCount = Math.floor(opts.messages / 2);
	const toolsPerAssistant = Math.ceil(opts.toolCalls / Math.max(1, assistantCount));
	const reasoningPerAssistant = Math.ceil(opts.reasoningBlocks / Math.max(1, assistantCount));
	let toolsLeft = opts.toolCalls;
	let reasoningLeft = opts.reasoningBlocks;
	let editsLeft = Math.max(1, Math.floor(opts.messages / 10));

	const tx = db.transaction(() => {
		for (let i = 0; i < opts.messages; i++) {
			const role = i % 2 === 0 ? 'user' : 'assistant';
			const msgId = nextId('m');
			const content = lorem(rand, role === 'user' ? 400 : 2_200);
			stats.dbBytes += content.length;
			stats.contentBytes += content.length;
			insertMsg.run(msgId, conversationId, role, content, now + i * 60_000);
			stats.messages++;
			if (role !== 'assistant') continue;

			for (let t = 0; t < toolsPerAssistant && toolsLeft > 0; t++, toolsLeft--) {
				const tool = tools[Math.floor(rand() * tools.length)];
				const args = jsonOfSize(
					rand,
					{
						description: `${tool} step ${seq}`,
						path: `src/lib/server/bench/file-${seq}.ts`
					},
					'payload',
					drawArgsBytes(rand)
				);
				const result = jsonOfSize(rand, { ok: true }, 'result', drawResultBytes(rand));
				stats.dbBytes += args.length + result.length;
				stats.argsBytes += args.length;
				stats.resultBytes += result.length;
				insertTool.run(
					nextId('t'),
					msgId,
					tool,
					args,
					result,
					now + i * 60_000,
					now + i * 60_000 + 100,
					t * 10
				);
				stats.toolCalls++;
			}
			for (let r = 0; r < reasoningPerAssistant && reasoningLeft > 0; r++, reasoningLeft--) {
				const text = lorem(rand, 300 + Math.floor(rand() * 900));
				stats.dbBytes += text.length;
				stats.reasoningBytes += text.length;
				insertReasoning.run(nextId('r'), msgId, r, text, r * 10, now + i * 60_000, 1_200);
				stats.reasoningBlocks++;
			}
			if (editsLeft > 0) {
				editsLeft--;
				const diff = [
					`--- a/src/bench/file-${seq}.ts`,
					`+++ b/src/bench/file-${seq}.ts`,
					'@@ -1,3 +1,3 @@',
					...Array.from({ length: 150 }, (_, k) => `+${lorem(rand, 60)}${k}`)
				].join('\n');
				stats.dbBytes += diff.length;
				stats.diffBytes += diff.length;
				insertEdit.run(nextId('e'), msgId, `src/bench/file-${seq}.ts`, diff, now + i * 60_000, 0);
				stats.fileEdits++;
			}
		}
	});
	tx();
	return stats;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

async function measureSsrBytes(baseUrl, conversationId) {
	const res = await fetch(`${baseUrl}/conversations/${conversationId}`, {
		headers: { accept: 'text/html' }
	});
	if (!res.ok) throw new Error(`conversation page returned ${res.status}`);
	const body = await res.arrayBuffer();
	return body.byteLength;
}

// `GET /api/conversations/:id` deliberately does NOT trim, so it is a live,
// same-run stand-in for the pre-change transcript payload: the exact same rows,
// serialized in full. Reporting both makes the reduction reproducible without
// having to check out the old code.
async function measureUntrimmedTranscriptBytes(baseUrl, conversationId) {
	const res = await fetch(`${baseUrl}/api/conversations/${conversationId}`);
	if (!res.ok) throw new Error(`conversation API returned ${res.status}`);
	const body = await res.arrayBuffer();
	return body.byteLength;
}

// Transcript bytes the page ships after the trim, in the same unit the ticket's
// 2.25 MB baseline was stated in (summed column bytes). Thresholds are imported
// from the production module, so this can't drift from what the server does.
function measureInlineTranscriptBytes(db, conversationId, limits) {
	const g = (sql, ...p) => db.prepare(sql).get(...p).t ?? 0;
	const content = g(
		'SELECT sum(length(CAST(content AS blob))) t FROM messages WHERE conversation_id = ?',
		conversationId
	);
	const reasoning = g(
		`SELECT sum(length(CAST(rb.text AS blob))) t FROM reasoning_blocks rb
		   JOIN messages m ON m.id = rb.message_id WHERE m.conversation_id = ?`,
		conversationId
	);
	const inlineSum = (table, col, join, max) =>
		g(
			`SELECT sum(CASE WHEN length(CAST(${col} AS blob)) <= ? THEN length(CAST(${col} AS blob)) ELSE 0 END) t
			   FROM ${table} x JOIN messages m ON m.id = x.message_id WHERE m.conversation_id = ?`,
			max,
			conversationId
		) + (join ?? 0);
	const args = inlineSum('tool_calls', 'args_json', 0, limits.args);
	const result = inlineSum('tool_calls', 'result_json', 0, limits.result);
	const diff = inlineSum('file_edits', 'diff', 0, limits.diff);
	return {
		content,
		reasoning,
		args,
		result,
		diff,
		total: content + reasoning + args + result + diff
	};
}

function measureStoredTranscriptBytes(db, conversationId) {
	return measureInlineTranscriptBytes(db, conversationId, {
		args: Number.MAX_SAFE_INTEGER,
		result: Number.MAX_SAFE_INTEGER,
		diff: Number.MAX_SAFE_INTEGER
	});
}

// Instrumentation injected before any app code runs. Two rAF pollers:
//   __tti        — first frame on which the transcript is mounted AND scrolled
//                  to the bottom. Mounting + scroll-to-bottom is Chat.svelte's
//                  own "the page is usable now" signal, and rAF callbacks are
//                  starved while the main thread hydrates, so the timestamp
//                  naturally includes hydration cost.
//   __fullRender — first frame on which every message is in the DOM.
const INSTRUMENT = (expectedMessages) => `
	window.__benchT0 = performance.now();
	window.__tti = null;
	window.__fullRender = null;
	const expected = ${expectedMessages};
	const poll = () => {
		if (window.__tti === null) {
			const el = document.querySelector('.messages');
			if (el && el.scrollTop > 0 && el.scrollHeight > el.clientHeight) {
				window.__tti = performance.now() - window.__benchT0;
			}
		}
		if (window.__fullRender === null) {
			if (document.querySelectorAll('article.msg').length >= expected) {
				window.__fullRender = performance.now() - window.__benchT0;
			}
		}
		if (window.__tti === null || window.__fullRender === null) requestAnimationFrame(poll);
	};
	requestAnimationFrame(poll);
`;

async function measureClient(browser, baseUrl, conversationId, expectedMessages) {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.addInitScript(INSTRUMENT(expectedMessages));
	await page.goto(`${baseUrl}/conversations/${conversationId}`, { waitUntil: 'commit' });
	await page.waitForFunction(() => window.__tti !== null, undefined, { timeout: 60_000 });
	const tti = await page.evaluate(() => window.__tti);
	await page
		.waitForFunction(() => window.__fullRender !== null, undefined, { timeout: 60_000 })
		.catch(() => {});
	const fullRender = await page.evaluate(() => window.__fullRender);
	const domMessages = await page.evaluate(() => document.querySelectorAll('article.msg').length);
	await context.close();
	return { ttiMs: tti, fullRenderMs: fullRender, domMessages };
}

// Single source of truth for the thresholds: read them out of the production
// module rather than duplicating the numbers here.
function readInlineLimits() {
	const src = readFileSync(join(repoRoot, 'src/lib/payload-limits.ts'), 'utf8');
	const read = (name) => {
		const m = src.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`));
		if (!m) throw new Error(`could not read ${name} from src/lib/payload-limits.ts`);
		return Number(m[1]);
	};
	return {
		args: read('INLINE_ARGS_MAX_BYTES'),
		result: read('INLINE_RESULT_MAX_BYTES'),
		diff: read('INLINE_DIFF_MAX_BYTES')
	};
}

function fmtBytes(n) {
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

function median(xs) {
	const s = [...xs].filter((x) => typeof x === 'number').sort((a, b) => a - b);
	if (s.length === 0) return null;
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------------------

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	if (opts.build || !existsSync(join(repoRoot, 'build', 'index.js'))) {
		console.log('[bench] building…');
		const r = spawnSync('pnpm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
		if (r.status !== 0) throw new Error('build failed');
	}

	const dataDir = mkdtempSync(join(tmpdir(), 'zap-bench-'));
	const port = await freePort();
	const baseUrl = `http://127.0.0.1:${port}`;
	console.log(`[bench] DATA_DIR=${dataDir}`);

	const server = spawn(process.execPath, [join(repoRoot, 'build')], {
		cwd: dataDir,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(port),
			DATA_DIR: dataDir,
			AUTH_MODE: 'none',
			I_KNOW_THIS_IS_LOCAL: '1',
			ENCRYPTION_KEY: randomBytes(32).toString('base64'),
			COPILOT_STUB: '1',
			LOG_LEVEL: 'warn',
			DB_MIGRATIONS_DIR: join(repoRoot, 'src/lib/server/db/migrations'),
			ORIGIN: baseUrl,
			GIT_CEILING_DIRECTORIES: dataDir
		}
	});
	server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

	let browser;
	let keepServing = false;
	try {
		await waitForHealth(baseUrl);
		const csrf = await csrfHandshake(baseUrl);

		const created = await fetch(`${baseUrl}/api/conversations`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: baseUrl,
				cookie: csrf.cookie,
				'x-csrf-token': csrf.token
			},
			body: JSON.stringify({ title: 'bench: long conversation' })
		});
		if (!created.ok) throw new Error(`create conversation failed: ${created.status}`);
		const conversationId = (await created.json()).conversation.id;

		const { default: Database } = await import('better-sqlite3');
		const db = new Database(join(dataDir, 'portal.db'));
		const stats = seedConversation(db, conversationId, opts);
		const limits = readInlineLimits();
		const storedTranscript = measureStoredTranscriptBytes(db, conversationId);
		const inlineTranscript = measureInlineTranscriptBytes(db, conversationId, limits);
		db.close();
		console.log(
			`[bench] seeded ${stats.messages} messages, ${stats.toolCalls} tool calls, ` +
				`${stats.reasoningBlocks} reasoning blocks, ${stats.fileEdits} file edits ` +
				`(${fmtBytes(stats.dbBytes)} of text at rest)`
		);
		console.log(
			`[bench]   content ${fmtBytes(stats.contentBytes)} · args ${fmtBytes(stats.argsBytes)} · ` +
				`result ${fmtBytes(stats.resultBytes)} · reasoning ${fmtBytes(stats.reasoningBytes)} · ` +
				`diffs ${fmtBytes(stats.diffBytes)}`
		);
		console.log(
			`[bench]   thresholds: args ≤${limits.args}B, result ≤${limits.result}B, diff ≤${limits.diff}B`
		);

		const ssrBytes = await measureSsrBytes(baseUrl, conversationId);
		const untrimmedBytes = await measureUntrimmedTranscriptBytes(baseUrl, conversationId);

		const { firefox } = await import('@playwright/test');
		browser = await firefox.launch();
		const runs = [];
		for (let i = 0; i < opts.runs; i++) {
			runs.push(await measureClient(browser, baseUrl, conversationId, opts.messages));
		}

		const result = {
			seed: opts.seed,
			messages: stats.messages,
			toolCalls: stats.toolCalls,
			reasoningBlocks: stats.reasoningBlocks,
			fileEdits: stats.fileEdits,
			inlineLimits: limits,
			storedTranscriptBytes: storedTranscript.total,
			inlineTranscriptBytes: inlineTranscript.total,
			inlineTranscriptBreakdown: inlineTranscript,
			ssrHtmlBytes: ssrBytes,
			untrimmedTranscriptJsonBytes: untrimmedBytes,
			ttiMsMedian: median(runs.map((r) => r.ttiMs)),
			fullRenderMsMedian: median(runs.map((r) => r.fullRenderMs)),
			runs
		};

		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			const ratio = storedTranscript.total / Math.max(1, inlineTranscript.total);
			console.log('');
			console.log('=== conversation-load benchmark ===');
			// Headline metric, in the same unit as the ticket's 2.25 MB baseline:
			// summed transcript column bytes the page carries.
			console.log(
				`  transcript payload : ${fmtBytes(inlineTranscript.total)} inline ` +
					`(was ${fmtBytes(storedTranscript.total)} untrimmed — ${ratio.toFixed(1)}x smaller)`
			);
			console.log(
				`    breakdown        : content ${fmtBytes(inlineTranscript.content)} · ` +
					`reasoning ${fmtBytes(inlineTranscript.reasoning)} · args ${fmtBytes(inlineTranscript.args)} · ` +
					`result ${fmtBytes(inlineTranscript.result)} · diff ${fmtBytes(inlineTranscript.diff)}`
			);
			console.log(`  full page HTML     : ${fmtBytes(ssrBytes)} (${ssrBytes} bytes)`);
			console.log(
				`  untrimmed API JSON : ${fmtBytes(untrimmedBytes)} ` +
					`(same rows via /api/conversations/:id, which never trims)`
			);
			console.log(`  TTI (median)       : ${Math.round(result.ttiMsMedian)} ms`);
			console.log(
				`  Fully rendered     : ${
					result.fullRenderMsMedian === null ? 'n/a' : `${Math.round(result.fullRenderMsMedian)} ms`
				}`
			);
			console.log(
				`  runs               : ${runs
					.map((r) => `${Math.round(r.ttiMs)}ms/${r.domMessages}msgs`)
					.join(', ')}`
			);
			console.log('');
		}

		if (opts.serve) {
			// Leave the seeded server up so a human (or `playwright-cli`) can poke
			// at a genuinely long conversation without touching the live ./data.
			keepServing = true;
			console.log(`[bench] serving at ${baseUrl}/conversations/${conversationId}`);
			console.log('[bench] press Ctrl-C to stop');
			await new Promise(() => {});
		}
	} finally {
		if (browser) await browser.close().catch(() => {});
		if (!keepServing) server.kill('SIGTERM');
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
