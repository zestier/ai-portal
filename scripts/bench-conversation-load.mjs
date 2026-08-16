#!/usr/bin/env node
// Benchmark: how expensive is *opening* a long conversation?
//
// Seeds a synthetic conversation (~100 messages / ~600 tool calls / ~180
// reasoning blocks, with result sizes drawn to match the real distribution
// observed in a production ./data/portal.db — median small, tail up to
// ~280 KB) into a throwaway DATA_DIR, serves it from a production build, and
// reports the backend-projected transcript (BFF presentation layer) metrics:
//
//   ssrHtmlBytes          — bytes of SSR HTML for the conversation page.
//   transcriptPayloadBytes — bytes of the projected transcript JSON
//                           (`GET /api/conversations/[id]`, the same shape the
//                           page `load` embeds). This is the primary wire
//                           metric: the bounded hydrated tail + index, never
//                           the whole conversation.
//   ttiMs                 — time from navigation start until the transcript is
//                           mounted, hydrated and scrolled to the bottom.
//   cardsAfterLoad        — mounted `article.msg` (full message cards) right
//                           after load (windowed rendering bounds this).
//   cardsAtTop            — mounted cards after scrolling to the top (older
//                           messages hydrate near the viewport, the tail
//                           demotes to index rows).
//   jankFps               — rAF frame rate while scrolling the whole thread
//                           under a 4x CPU throttle (Chromium only; n/a when
//                           Chromium isn't installed).
//
// Targets (D7): transcript payload <= ~40 KB, <= 40 mounted cards at any
// time, TTI <= ~200 ms. The script exits non-zero when an assert fails.
//
// Recorded numbers for the default seed (100 messages / 600 tool calls /
// 180 reasoning blocks / 2.43 MB of text at rest, seed 1337):
//
//                        before            after
//   transcript payload   2.43 MB           462.7 KB    (pre-projection)
//   full page HTML       2.68 MB           736.5 KB
//
// Usage:
//   pnpm bench:conversation-load
//   pnpm bench:conversation-load -- --messages 100 --tool-calls 600 --runs 3
//
// The build is reused if `build/` already exists; pass `--build` to force a
// rebuild. The temp DATA_DIR is left on disk for post-mortem.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
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
		json: false,
		jank: true
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
		else if (a === '--no-jank') opts.jank = false;
		else if (a === '--help' || a === '-h') {
			console.log(
				'Usage: pnpm bench:conversation-load [--messages N] [--tool-calls N] [--reasoning-blocks N] [--runs N] [--seed N] [--build] [--serve] [--json] [--no-jank]'
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

// Field sizes are heavily skewed and the shape matters: the projection keeps
// small fields inline and summarizes the rest, so a benchmark with the wrong
// distribution measures the wrong thing. These bands are fitted to per-band
// counts and byte sums measured (read-only) on the worst real conversation in
// a production ./data/portal.db — 92 messages, 604 tool calls, 355 KB of
// `args_json`, 1.58 MB of `result_json`, 132 KB of message content and 131 KB
// of reasoning text.
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

// NOTE: ids are sequential integers — `messages` and its children use INTEGER
// PRIMARY KEYs since the integer-PK migration, so string ids no longer fit.
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
	const nextId = () => ++seq;

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
			const msgId = nextId();
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
					nextId(),
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
				insertReasoning.run(nextId(), msgId, r, text, r * 10, now + i * 60_000, 1_200);
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
				insertEdit.run(nextId(), msgId, `src/bench/file-${seq}.ts`, diff, now + i * 60_000, 0);
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

// The projected transcript JSON — the exact wire shape the page `load` embeds.
// This is the primary "initial payload" metric (target <= ~40 KB).
async function measureTranscriptPayloadBytes(baseUrl, conversationId) {
	const res = await fetch(`${baseUrl}/api/conversations/${conversationId}`);
	if (!res.ok) throw new Error(`conversation API returned ${res.status}`);
	const body = await res.arrayBuffer();
	return body.byteLength;
}

// Bytes of text at rest for the seeded conversation (the 2.43 MB baseline).
function measureStoredTranscriptBytes(db, conversationId) {
	const g = (sql, ...p) => db.prepare(sql).get(...p).t ?? 0;
	const content = g(
		'SELECT sum(length(CAST(content AS blob))) t FROM messages WHERE conversation_id = ?',
		conversationId
	);
	const sumOf = (table, col, join) =>
		g(
			`SELECT sum(length(CAST(${col} AS blob))) t
			   FROM ${table} x JOIN messages m ON m.id = x.message_id WHERE m.conversation_id = ?`,
			conversationId
		) + (join ?? 0);
	return {
		content,
		reasoning: sumOf('reasoning_blocks', 'text'),
		args: sumOf('tool_calls', 'args_json'),
		result: sumOf('tool_calls', 'result_json'),
		diff: sumOf('file_edits', 'diff'),
		total: 0
	};
}

// Instrumentation injected before any app code runs. Pollers:
//   __tti        — first frame on which the transcript is mounted AND scrolled
//                  to the bottom (Chat.svelte's own "usable now" signal).
//   __cards      — mounted `article.msg` count after load.
//   __topCards   — mounted `article.msg` count after scrolling to the top.
//   __scrollFps  — rAF frame rate sampled while scrolling to the top.
const INSTRUMENT = `
	window.__benchT0 = performance.now();
	window.__tti = null;
	window.__cards = null;
	window.__topCards = null;
	window.__scrollFps = null;
	const poll = () => {
		if (window.__tti === null) {
			const el = document.querySelector('.messages');
			if (el && el.scrollTop > 0 && el.scrollHeight > el.clientHeight) {
				window.__tti = performance.now() - window.__benchT0;
			}
		}
		if (window.__cards === null && document.querySelectorAll('article.msg').length > 0) {
			window.__cards = document.querySelectorAll('article.msg').length;
		}
		if (window.__tti === null || window.__cards === null) requestAnimationFrame(poll);
	};
	requestAnimationFrame(poll);
	// Frame-rate meter for the throttled scroll-to-top pass.
	const sampleFps = () => {
		const el = document.querySelector('.messages');
		if (!el || el.scrollTop <= 0) { window.__scrollFps = null; return; }
		let frames = 0;
		let t0 = performance.now();
		const tick = (t) => {
			frames++;
			if (t - t0 >= 500) {
				window.__scrollFps = (frames / ((t - t0) / 1000)).toFixed(1);
				return;
			}
			requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	};
	window.__startScrollToTop = () => {
		const el = document.querySelector('.messages');
		if (!el) return;
		sampleFps();
		const step = () => {
			if (el.scrollTop <= 0) {
				setTimeout(() => {
					window.__topCards = document.querySelectorAll('article.msg').length;
				}, 400);
				return;
			}
			el.scrollTop = Math.max(0, el.scrollTop - Math.max(400, el.clientHeight));
			requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	};
`;

async function measureClient(browser, baseUrl, conversationId) {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.addInitScript(INSTRUMENT);
	await page.goto(`${baseUrl}/conversations/${conversationId}`, { waitUntil: 'commit' });
	await page.waitForFunction(() => window.__tti !== null, undefined, { timeout: 60_000 });
	const ttiMs = await page.evaluate(() => window.__tti);
	await page
		.waitForFunction(() => window.__cards !== null, undefined, { timeout: 60_000 })
		.catch(() => {});
	const cardsAfterLoad = await page.evaluate(() => window.__cards);
	// Scroll to the top: older messages hydrate near the viewport and the tail
	// demotes to index rows; mounted cards must stay bounded.
	await page.evaluate(() => window.__startScrollToTop());
	await page.waitForFunction(() => window.__topCards !== null, undefined, { timeout: 60_000 });
	const cardsAtTop = await page.evaluate(() => window.__topCards);
	await context.close();
	return { ttiMs, cardsAfterLoad, cardsAtTop };
}

// Scroll-jank pass: rAF frame rate while scrolling the whole thread under a
// 4x CPU throttle. CDP emulation is Chromium-only; skipped when Chromium
// can't launch (reported as n/a).
async function measureJank(baseUrl, conversationId) {
	let chromium;
	try {
		({ chromium } = await import('@playwright/test'));
	} catch {
		return null;
	}
	let browser;
	try {
		browser = await chromium.launch();
	} catch {
		return null;
	}
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.addInitScript(INSTRUMENT);
		const cdp = await context.newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
		await page.goto(`${baseUrl}/conversations/${conversationId}`, { waitUntil: 'commit' });
		await page.waitForFunction(() => window.__tti !== null, undefined, { timeout: 60_000 });
		await page.evaluate(() => window.__startScrollToTop());
		await page.waitForFunction(() => window.__topCards !== null, undefined, { timeout: 60_000 });
		await page.waitForTimeout(600);
		const fps = await page.evaluate(() => window.__scrollFps);
		const cardsAtTop = await page.evaluate(() => window.__topCards);
		await context.close();
		return { fps: fps === null ? null : Number(fps), cardsAtTop };
	} catch {
		return null;
	} finally {
		await browser.close().catch(() => {});
	}
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
			I_KNOW_THIS_IS_LOCAL: '1',
			ENCRYPTION_KEY: randomBytes(32).toString('base64'),
			PI_STUB: '1',
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
		const stored = measureStoredTranscriptBytes(db, conversationId);
		db.close();
		stored.total = stored.content + stored.reasoning + stored.args + stored.result + stored.diff;
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

		const ssrBytes = await measureSsrBytes(baseUrl, conversationId);
		const transcriptPayloadBytes = await measureTranscriptPayloadBytes(baseUrl, conversationId);

		const { firefox } = await import('@playwright/test');
		browser = await firefox.launch();
		const runs = [];
		for (let i = 0; i < opts.runs; i++) {
			runs.push(await measureClient(browser, baseUrl, conversationId));
		}
		const jank = opts.jank ? await measureJank(baseUrl, conversationId) : null;

		const result = {
			seed: opts.seed,
			messages: stats.messages,
			toolCalls: stats.toolCalls,
			reasoningBlocks: stats.reasoningBlocks,
			fileEdits: stats.fileEdits,
			storedTranscriptBytes: stored.total,
			ssrHtmlBytes: ssrBytes,
			transcriptPayloadBytes,
			ttiMsMedian: median(runs.map((r) => r.ttiMs)),
			cardsAfterLoad: median(runs.map((r) => r.cardsAfterLoad)),
			cardsAtTop: median(runs.map((r) => r.cardsAtTop)),
			jankFps: jank?.fps ?? null,
			jankCardsAtTop: jank?.cardsAtTop ?? null,
			runs
		};

		// Assert the measurable targets (D7). The mounted-card bound and the
		// payload bound are the point of the whole ticket; TTI must not regress.
		const failures = [];
		if (result.transcriptPayloadBytes > 40960) {
			failures.push(`transcript payload ${result.transcriptPayloadBytes} B > 40960 B (~40 KB)`);
		}
		if (result.cardsAfterLoad > 40 || result.cardsAtTop > 40) {
			failures.push(
				`mounted cards ${result.cardsAfterLoad} (load) / ${result.cardsAtTop} (top) > 40`
			);
		}
		if (result.ttiMsMedian > 200) {
			failures.push(`TTI ${Math.round(result.ttiMsMedian)} ms > 200 ms`);
		}

		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log('');
			console.log('=== conversation-load benchmark ===');
			console.log(
				`  transcript payload : ${fmtBytes(transcriptPayloadBytes)} projected JSON ` +
					`(was ${fmtBytes(stored.total)} untrimmed — ${(stored.total / Math.max(1, transcriptPayloadBytes)).toFixed(1)}x smaller)`
			);
			console.log(`  full page HTML     : ${fmtBytes(ssrBytes)} (${ssrBytes} bytes)`);
			console.log(`  TTI (median)       : ${Math.round(result.ttiMsMedian)} ms`);
			console.log(
				`  mounted cards      : ${Math.round(result.cardsAfterLoad)} after load · ` +
					`${Math.round(result.cardsAtTop)} after scrolling to top (target ≤ 40)`
			);
			console.log(
				`  scroll jank (4x)   : ${
					jank?.fps === null || jank?.fps === undefined ? 'n/a (no Chromium)' : `${jank.fps} fps`
				}`
			);
			console.log(
				`  runs               : ${runs
					.map((r) => `${Math.round(r.ttiMs)}ms/${r.cardsAfterLoad}/${r.cardsAtTop}cards`)
					.join(', ')}`
			);
			if (failures.length > 0) {
				console.log('');
				console.log(`  FAILED targets:`);
				for (const f of failures) console.log(`    - ${f}`);
				process.exitCode = 1;
			}
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
