// SQLite singleton + migrations.

import Database from 'better-sqlite3';
import { getLoadablePath, load as loadSqliteVec } from 'sqlite-vec';
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config';
import {
	appGlobalSymbols,
	clearGlobalSingletonValues,
	getGlobalSingletonValue,
	setGlobalSingletonValue
} from '../global-singleton';
import { log } from '../log';

// Pin the singleton on globalThis so that Vite HMR re-importing this module
// in dev doesn't create a parallel connection (and lose any in-memory state
// like prepared-statement caches).
const DB_KEYS = appGlobalSymbols('db');
function getCached(): Database.Database | null {
	return getGlobalSingletonValue<Database.Database>(DB_KEYS);
}
function setCached(db: Database.Database) {
	setGlobalSingletonValue(DB_KEYS, db);
}

export function getDb(): Database.Database {
	const cached = getCached();
	if (cached) return cached;
	const cfg = loadConfig();
	const dataDir = resolve(cfg.DATA_DIR);
	mkdirSync(dataDir, { recursive: true });
	const path = join(dataDir, 'portal.db');
	const db = new Database(path);
	loadVectorExtension(db);
	db.pragma('journal_mode = WAL');
	db.pragma('synchronous = NORMAL');
	db.pragma('foreign_keys = ON');
	db.pragma('busy_timeout = 5000');
	runMigrations(db);
	setCached(db);
	log.info('db.open', { path });
	return db;
}

function loadVectorExtension(db: Database.Database) {
	try {
		loadSqliteVec(db);
		log.info('db.sqlite_vec.loaded', { path: getLoadablePath() });
	} catch (e) {
		log.warn('db.sqlite_vec.load_failed', { err: String(e) });
	}
}

function migrationsDir(): string {
	const cfg = loadConfig();
	// Explicit override (used by tests / non-standard layouts where cwd is
	// not the repository root).
	if (cfg.DB_MIGRATIONS_DIR && existsSync(cfg.DB_MIGRATIONS_DIR)) {
		return cfg.DB_MIGRATIONS_DIR;
	}
	// At runtime under SvelteKit/Vite, import.meta.url points into compiled output.
	// Try alongside this file first; fall back to source path during dev.
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, 'migrations'),
		join(here, '..', 'migrations'),
		resolve(process.cwd(), 'src/lib/server/db/migrations')
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	throw new Error('Could not locate db migrations directory');
}

function runMigrations(db: Database.Database) {
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`);
	const applied = new Set<number>(
		db
			.prepare('SELECT version FROM schema_migrations')
			.all()
			.map((r: unknown) => (r as { version: number }).version)
	);

	const dir = migrationsDir();
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	for (const file of files) {
		const m = file.match(/^(\d+)_/);
		if (!m) continue;
		const version = parseInt(m[1], 10);
		if (applied.has(version)) continue;
		const sql = readFileSync(join(dir, file), 'utf8');
		const tx = db.transaction(() => {
			db.exec(sql);
			db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
				version,
				Date.now()
			);
		});
		tx();
		log.info('db.migration.applied', { version, file });
	}
}

export function closeDb() {
	const cached = getCached();
	if (cached) {
		cached.close();
		clearGlobalSingletonValues(DB_KEYS);
	}
}
