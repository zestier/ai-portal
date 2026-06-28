#!/usr/bin/env node
// Tiny supervisor: runs `node build.live` and respawns it whenever it exits.
//
// Use this instead of `node build` directly so the in-app "redeploy" button
// can rebuild and then exit(0) to roll itself over onto the new code, without
// needing systemd / pm2 / docker.
//
// Crucially, the child does NOT run out of `build/` — the supervisor keeps
// its own runtime copy at `build.live/` and only refreshes it between
// restarts. That way `pnpm run build` (manual, from the redeploy endpoint,
// from `test:e2e`, ...) can freely overwrite `build/` while the live
// process is serving, without thrashing the chunks it's lazy-loading.
// The previous runtime tree is kept at `build.prev/` as a one-step rollback.
//
//   pnpm run build          # one-time, or done by redeploy
//   pnpm run serve          # long-running, like `pnpm run dev`
//
// Honors SIGINT/SIGTERM (forwarded to child, escalating to SIGKILL) for clean
// Ctrl-C shutdown, and auto-rolls-back to build.prev/ if a fresh build
// crash-loops.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { restartDelayMs, shouldRollback } from './lib/serve-supervisor.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const buildDir = resolve(root, 'build'); // adapter output, freely rewritable
const liveDir = resolve(root, 'build.live'); // what the child actually runs
const prevDir = resolve(root, 'build.prev'); // last known-good live tree
const brokenDir = resolve(root, 'build.broken'); // crash-looped tree, kept for post-mortem
const liveEntry = resolve(liveDir, 'index.js');
const prevEntry = resolve(prevDir, 'index.js'); // known-good entry we can roll back to

// A non-zero exit faster than this looks like a crash-loop (bad migration,
// missing env, partial write) rather than normal operation, so we roll back.
const CRASH_THRESHOLD_MS = 5000;
// How long to wait after a graceful signal before escalating to SIGKILL.
const SHUTDOWN_GRACE_MS = 5000;
// Hard-exit backstop after SIGKILL, in case the child's exit event never fires.
const SIGKILL_EXIT_BACKSTOP_MS = 1000;

let child = null;
let stopping = false;
let restartTimer = null;
let lastSyncedMtimeMs = 0;
let childStartedAt = 0;

function log(...args) {
	console.log('[serve]', ...args);
}

// Refresh `build.live/` from `build/` if the source has changed since we
// last copied it. Keeps the previous live tree at `build.prev/`. Only
// called between restarts, when no process has fds open into
// `build.live/`, so the swap is safe.
function refreshLiveFromBuild() {
	if (!existsSync(buildDir)) return;
	let srcMtime;
	try {
		srcMtime = statSync(resolve(buildDir, 'index.js')).mtimeMs;
	} catch {
		log('build/index.js missing — not refreshing live tree.');
		return;
	}
	if (existsSync(liveEntry) && srcMtime === lastSyncedMtimeMs) return;

	const tmpDir = resolve(root, 'build.live.tmp');
	try {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
		cpSync(buildDir, tmpDir, { recursive: true });
		if (!existsSync(resolve(tmpDir, 'index.js'))) {
			log('copied build/ is missing index.js — aborting refresh.');
			rmSync(tmpDir, { recursive: true, force: true });
			return;
		}
		if (existsSync(prevDir)) rmSync(prevDir, { recursive: true, force: true });
		if (existsSync(liveDir)) renameSync(liveDir, prevDir);
		renameSync(tmpDir, liveDir);
		lastSyncedMtimeMs = srcMtime;
		log('refreshed build.live/ from build/');
	} catch (err) {
		log(`refresh failed: ${err.message}`);
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch (cleanupErr) {
			log(`failed to clean up tmp dir: ${cleanupErr.message}`);
		}
	}
}

// Restore build.live/ from build.prev/ after a crash-loop. One-step: prevDir is
// consumed (renamed onto liveDir), so we never roll back twice in a row, and the
// broken tree is set aside at build.broken/ for post-mortem rather than deleted.
function rollbackToPrev() {
	if (!existsSync(prevEntry)) {
		log('rollback requested but build.prev/ has no index.js — staying on current tree.');
		return false;
	}
	try {
		// Leave lastSyncedMtimeMs as-is: it already holds the broken build's mtime
		// (refreshLiveFromBuild set it when it copied that build into build.live/),
		// so the next start()'s refreshLiveFromBuild treats the broken build as
		// already-synced and will NOT re-copy it over the rollback. A genuinely
		// newer build/ (different mtime) still refreshes normally. Re-statting
		// build/ here would be wrong — a good build that landed mid-run would get
		// pinned and suppressed.
		if (existsSync(brokenDir)) rmSync(brokenDir, { recursive: true, force: true });
		if (existsSync(liveDir)) renameSync(liveDir, brokenDir);
		renameSync(prevDir, liveDir);
		log('rolled back build.live/ from build.prev/ (broken tree kept at build.broken/)');
		return true;
	} catch (err) {
		log(`rollback failed: ${err.message}`);
		return false;
	}
}

function start() {
	if (stopping) return;
	refreshLiveFromBuild();
	if (!existsSync(liveEntry)) {
		log(`build.live/ missing at ${liveEntry} — run \`pnpm run build\` first.`);
		process.exit(1);
	}
	log('starting node build.live');
	const deployedAt = new Date().toISOString();
	childStartedAt = Date.now();
	child = spawn(process.execPath, [liveDir], {
		stdio: 'inherit',
		cwd: root,
		env: { ...process.env, ZAP_DEPLOYED_AT: deployedAt }
	});
	child.on('exit', (code, signal) => {
		const uptimeMs = Date.now() - childStartedAt;
		log(`child exited code=${code} signal=${signal} uptime=${uptimeMs}ms`);
		child = null;
		if (stopping) {
			// Graceful shutdown in progress and the child is gone — exit now rather
			// than waiting out the SIGKILL backstop timer.
			process.exit(0);
			return;
		}
		if (
			shouldRollback({
				code,
				uptimeMs,
				// Match rollbackToPrev's own guard (a usable entry, not just the
				// directory) so we don't announce a rollback we can't perform and
				// then restart the same broken build.
				hasPrev: existsSync(prevEntry),
				thresholdMs: CRASH_THRESHOLD_MS
			})
		) {
			log(`child crash-looped (non-zero exit within ${CRASH_THRESHOLD_MS}ms) — rolling back.`);
			rollbackToPrev();
		}
		restartTimer = setTimeout(start, restartDelayMs(code));
	});
}

function shutdown(sig) {
	if (stopping) return;
	stopping = true;
	log(`received ${sig}, shutting down`);
	if (restartTimer) clearTimeout(restartTimer);
	if (!child) {
		process.exit(0);
		return;
	}
	child.kill(sig);
	// tini reaps zombies but won't kill a still-running orphan, so if the child
	// ignores the graceful signal we must escalate to SIGKILL ourselves. When the
	// child does exit, its exit handler calls process.exit(0) promptly.
	setTimeout(() => {
		if (!child) {
			process.exit(0);
			return;
		}
		log(`child still running ${SHUTDOWN_GRACE_MS}ms after ${sig} — sending SIGKILL`);
		try {
			child.kill('SIGKILL');
		} catch (err) {
			log(`SIGKILL failed: ${err.message}`);
		}
		// Backstop: exit even if the child's exit event somehow never fires.
		setTimeout(() => process.exit(0), SIGKILL_EXIT_BACKSTOP_MS).unref();
	}, SHUTDOWN_GRACE_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
