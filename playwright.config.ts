import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, 'e2e/.tmp-data');

// Never reuse/attach to an already-running server. The in-app redeploy
// (src/lib/server/redeploy.ts) runs the full verify gate — including this e2e
// suite — while the live portal is still serving. `reuseExistingServer` is on
// outside CI, so without this Playwright could attach to the LIVE server (if it
// shared the e2e port) and run destructive specs against live data. Redeploy
// sets E2E_ISOLATED=1 to force a fresh, throwaway server + DB on the e2e port.
const isolated = !!process.env.E2E_ISOLATED;

const PORT = Number(process.env.E2E_PORT ?? 4173);
const buildEntry = resolve(__dirname, 'build');
const requestedWorkers = Number(process.env.E2E_WORKERS ?? 2);
const workers = Number.isFinite(requestedWorkers) ? Math.max(1, requestedWorkers) : 2;

// Synchronously probe whether something is already listening on PORT.
// We need this at config-evaluation time so we can decide whether it's
// safe to wipe DATA_DIR — wiping the directory out from under a server
// with an open SQLite handle is a footgun, and Playwright lets us reuse
// a running dev server in non-CI runs.
//
// `net.createConnection` is async, but we need a sync answer here, so we
// run the probe in a tiny child node process and capture its exit code.
function isPortInUse(port: number): boolean {
	const script = `
		const net = require('node:net');
		const sock = net.createConnection({ host: '127.0.0.1', port: ${port} });
		const done = (code) => { sock.destroy(); process.exit(code); };
		sock.once('connect', () => done(0));
		sock.once('error', () => done(1));
		setTimeout(() => done(1), 400);
	`;
	const r = spawnSync(process.execPath, ['-e', script], { stdio: 'ignore', timeout: 1500 });
	return r.status === 0;
}

const willReuseServer = !process.env.CI && !isolated && isPortInUse(PORT);
if (!willReuseServer) {
	rmSync(dataDir, { recursive: true, force: true });
	mkdirSync(dataDir, { recursive: true });
}

export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers,
	reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
	timeout: 30_000,
	expect: { timeout: 5_000 },
	use: {
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: 'retain-on-failure',
		video: 'retain-on-failure',
		// The hooks.server.ts CSRF guard rejects mutating /api/* calls that
		// have neither an Origin nor a Referer matching event.url.origin.
		// Playwright's APIRequestContext sends neither by default, so every
		// `request.post(...)` would 403. Inject the expected Origin here so
		// the API-driven specs (chat, conversations, files, fork) get past
		// the guard the same way the browser-driven ones do.
		extraHTTPHeaders: {
			Origin: `http://127.0.0.1:${PORT}`
		}
	},
	projects: [
		{
			name: 'firefox',
			use: { ...devices['Desktop Firefox'] }
		}
	],
	webServer: {
		command: `node ${JSON.stringify(buildEntry)}`,
		url: `http://127.0.0.1:${PORT}/api/health`,
		reuseExistingServer: !process.env.CI && !isolated,
		timeout: 60_000,
		stdout: 'pipe',
		stderr: 'pipe',
		cwd: dataDir,
		env: {
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(PORT),
			DATA_DIR: dataDir,
			// PROJECT_ROOT defaults to process.cwd(), but Playwright merges the
			// parent's env (via `...process.env`) into the web server's env — so a
			// host running the portal with PROJECT_ROOT set would leak it here and
			// point every e2e conversation's workdir at the real project tree. Pin
			// it to the isolated dataDir so test writes (e.g. the view-image stub
			// fixtures) never land in the repo root.
			PROJECT_ROOT: dataDir,
			I_KNOW_THIS_IS_LOCAL: '1',
			E2E_ISOLATED: '1',
			ENCRYPTION_KEY: randomBytes(32).toString('base64'),
			PI_STUB: '1',
			LOG_LEVEL: 'warn',
			DB_MIGRATIONS_DIR: resolve(__dirname, 'src/lib/server/db/migrations'),
			// @sveltejs/adapter-node defaults the request protocol to `https`
			// when ORIGIN is unset, so event.url.origin ends up as
			// `https://127.0.0.1:4173` and our same-origin check rejects the
			// browser's `http://...` Origin header. Pin it explicitly.
			ORIGIN: `http://127.0.0.1:${PORT}`,
			// Each conversation's workdir lives under $DATA_DIR/workspaces/<id>.
			// dataDir lives inside the ZAP source tree, which is itself a
			// git repo. Without this, git commands run inside conversation workdirs
			// would walk up into the outer repo. Tell git to stop at dataDir so each
			// test sees an isolated workspace.
			GIT_CEILING_DIRECTORIES: dataDir
		}
	}
});
