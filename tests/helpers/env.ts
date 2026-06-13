import { randomBytes } from 'node:crypto';
import { makeTmpDir } from './tmp';

/**
 * Configure env vars for a local (AUTH_MODE=none) server with an isolated
 * data dir, and reset cached config + DB handles. Returns the data dir.
 */
export async function setupLocalEnv(prefix = 'portal-test-'): Promise<string> {
	const dir = makeTmpDir(prefix);
	process.env.DATA_DIR = dir;
	process.env.HOST = '127.0.0.1';
	process.env.AUTH_MODE = 'none';
	process.env.I_KNOW_THIS_IS_LOCAL = '1';
	delete process.env.SESSION_SECRET;
	delete process.env.SHARED_SECRET;
	await resetServerSingletons();
	return dir;
}

/**
 * Configure env for AUTH_MODE=shared-secret with fresh secrets.
 */
export async function setupAuthedEnv(prefix = 'portal-test-'): Promise<string> {
	const dir = makeTmpDir(prefix);
	process.env.DATA_DIR = dir;
	process.env.HOST = '127.0.0.1';
	process.env.AUTH_MODE = 'shared-secret';
	process.env.SHARED_SECRET = 'test-secret-0123456789-abcdef-0123456789';
	process.env.SESSION_SECRET = randomBytes(48).toString('base64');
	process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
	delete process.env.I_KNOW_THIS_IS_LOCAL;
	await resetServerSingletons();
	return dir;
}

/**
 * Drop cached config + DB handle so the next import/getDb picks up the
 * new DATA_DIR / env. Safe to call when modules aren't loaded yet.
 */
export async function resetServerSingletons(): Promise<void> {
	try {
		const { resetConfigForTests } = await import('../../src/lib/server/config');
		resetConfigForTests();
	} catch {
		// config module not yet imported in this test — nothing to reset.
	}
	try {
		const { closeDb } = await import('../../src/lib/server/db');
		closeDb();
	} catch {
		// db module not yet imported — nothing to close.
	}
}
