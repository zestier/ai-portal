#!/usr/bin/env node
// Starts `vite dev` against a throwaway DATA_DIR so exploratory testing
// (curl / Playwright / manual poking) never touches the real ./data
// database used by the live portal.
//
// Why this exists: the app has a single shared "local-dev" user (no auth). If
// you point a dev server at the live ./data, any conversations you create
// during testing land in that user's sidebar — which is the same identity
// your real local portal session uses. Use this script for any throwaway dev
// work; use `pnpm dev` only when you specifically want to share state with
// the live portal.
//
// The temp dir is created fresh each run under the OS tmpdir and is
// NOT deleted on exit (so you can post-mortem it); they're small.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'zap-dev-'));
console.log(`[dev-isolated] DATA_DIR=${dataDir}`);
console.log('[dev-isolated] loopback only (no auth)');

const child = spawn('pnpm', ['exec', 'vite', 'dev', ...process.argv.slice(2)], {
	stdio: 'inherit',
	env: {
		...process.env,
		DATA_DIR: dataDir,
		HOST: '127.0.0.1',
		I_KNOW_THIS_IS_LOCAL: '1'
		// ENCRYPTION_KEY is intentionally not set: it's optional here (only
		// needed for provider/BYOK API-key at-rest encryption, which throwaway
		// dev doesn't use).
	}
});

const forward = (sig) => child.kill(sig);
process.on('SIGINT', forward);
process.on('SIGTERM', forward);
child.on('exit', (code, sig) => {
	if (sig) process.kill(process.pid, sig);
	else process.exit(code ?? 0);
});
