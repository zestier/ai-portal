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
// Honors SIGINT/SIGTERM (forwarded to child) for clean Ctrl-C shutdown.

import { spawn } from 'node:child_process';
import { cpSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const buildDir = resolve(root, 'build'); // adapter output, freely rewritable
const liveDir = resolve(root, 'build.live'); // what the child actually runs
const prevDir = resolve(root, 'build.prev'); // last known-good live tree
const liveEntry = resolve(liveDir, 'index.js');

let child = null;
let stopping = false;
let restartTimer = null;
let lastSyncedMtimeMs = 0;

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

function start() {
	if (stopping) return;
	refreshLiveFromBuild();
	if (!existsSync(liveEntry)) {
		log(`build.live/ missing at ${liveEntry} — run \`pnpm run build\` first.`);
		process.exit(1);
	}
	log('starting node build.live');
	const deployedAt = new Date().toISOString();
	child = spawn(process.execPath, [liveDir], {
		stdio: 'inherit',
		cwd: root,
		env: { ...process.env, ZAP_DEPLOYED_AT: deployedAt }
	});
	child.on('exit', (code, signal) => {
		log(`child exited code=${code} signal=${signal}`);
		child = null;
		if (stopping) return;
		const delay = code === 0 ? 250 : 2000;
		restartTimer = setTimeout(start, delay);
	});
}

function shutdown(sig) {
	if (stopping) return;
	stopping = true;
	log(`received ${sig}, shutting down`);
	if (restartTimer) clearTimeout(restartTimer);
	if (child) {
		child.kill(sig);
		setTimeout(() => process.exit(0), 5000).unref();
	} else {
		process.exit(0);
	}
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
