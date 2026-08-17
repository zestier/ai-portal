// SQLite singleton + migrations.

import Database from "better-sqlite3";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config";
import {
  appGlobalSymbols,
  clearGlobalSingletonValues,
  getGlobalSingletonValue,
  setGlobalSingletonValue,
} from "../global-singleton";
import { log } from "../log";

// Pin the singleton on globalThis so that Vite HMR re-importing this module
// in dev doesn't create a parallel connection (and lose any in-memory state
// like prepared-statement caches).
const DB_KEYS = appGlobalSymbols("db");
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
  const path = join(dataDir, "portal.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // Checkpoint the WAL back into the main DB more eagerly than the 1000-page
  // (~4 MB) default so a large write burst can't let the WAL grow unbounded
  // before the next idle checkpoint. The periodic maintenance task also runs an
  // explicit PASSIVE checkpoint.
  db.pragma("wal_autocheckpoint = 400");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  runMigrations(db);
  dropLegacyEmbeddingTables(db);
  setCached(db);
  log.info("db.open", { path });
  return db;
}

// One-time teardown for the removed memory-embedding / sqlite-vec layer. Older
// deployments carry `memory_embeddings`, `memory_embedding_vec_map`, and the
// runtime-created `memory_embedding_vec_<dims>` vec0 virtual tables. Since the
// sqlite-vec extension is no longer loaded, those virtual tables can't be
// dropped normally ("no such module: vec0"), so remove their schema definitions
// via writable_schema, then drop the now-ordinary shadow + base tables so their
// pages are freed. No-ops cheaply once the tables are gone.
function dropLegacyEmbeddingTables(db: Database.Database) {
  const hasAny = db
    .prepare(
      `SELECT 1 FROM sqlite_master
			  WHERE name = 'memory_embeddings'
			     OR name = 'memory_embedding_vec_map'
			     OR name GLOB 'memory_embedding_vec_*'
			  LIMIT 1`,
    )
    .get();
  if (!hasAny) return;
  db.unsafeMode(true);
  try {
    db.exec(`PRAGMA writable_schema=ON;`);
    // Scope to our own vec0 tables so an unrelated virtual table can never be
    // caught by the `USING vec0` match.
    db.prepare(
      `DELETE FROM sqlite_master
			  WHERE sql LIKE '%USING vec0%'
			    AND name GLOB 'memory_embedding_vec_*'`,
    ).run();
    db.exec(`PRAGMA writable_schema=RESET;`);
    db.exec(`PRAGMA writable_schema=OFF;`);
    const shadow = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE name GLOB 'memory_embedding_vec_*'`,
      )
      .all() as { name: string }[];
    for (const t of shadow) db.exec(`DROP TABLE IF EXISTS "${t.name}";`);
    db.exec(`DROP TABLE IF EXISTS memory_embedding_vec_map;`);
    db.exec(`DROP TABLE IF EXISTS memory_embeddings;`);
    log.info("db.legacy_embeddings.dropped", {});
  } catch (e) {
    log.warn("db.legacy_embeddings.drop_failed", { err: String(e) });
  } finally {
    db.unsafeMode(false);
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
    join(here, "migrations"),
    join(here, "..", "migrations"),
    resolve(process.cwd(), "src/lib/server/db/migrations"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("Could not locate db migrations directory");
}

function runMigrations(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at INTEGER NOT NULL
	)`);
  const applied = new Set<number>(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((r: unknown) => (r as { version: number }).version),
  );

  const dir = migrationsDir();
  const leadingVersion = (f: string) => {
    const m = f.match(/^(\d+)_/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => leadingVersion(a) - leadingVersion(b));
  for (const file of files) {
    const m = file.match(/^(\d+)_/);
    if (!m) continue;
    const version = parseInt(m[1], 10);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
      ).run(version, Date.now());
    });
    tx();
    log.info("db.migration.applied", { version, file });
  }
}

export function closeDb() {
  const cached = getCached();
  if (cached) {
    cached.close();
    clearGlobalSingletonValues(DB_KEYS);
  }
}

// Force a WAL checkpoint, folding the write-ahead log back into the main DB
// file. PASSIVE never blocks on concurrent readers/writers (it checkpoints as
// many frames as it can without waiting), so it's safe to call from the
// periodic maintenance task as a backstop to the autocheckpoint.
export function checkpointWal(): void {
  getDb().pragma("wal_checkpoint(PASSIVE)");
}
