import { makeTmpDir } from "./tmp";

/**
 * Configure env vars for a local server (single shared local user — no auth
 * layer) with an isolated data dir, and reset cached config + DB handles.
 * Returns the data dir.
 */
export async function setupLocalEnv(prefix = "portal-test-"): Promise<string> {
  const dir = makeTmpDir(prefix);
  process.env.DATA_DIR = dir;
  process.env.HOST = "127.0.0.1";
  process.env.I_KNOW_THIS_IS_LOCAL = "1";
  await resetServerSingletons();
  return dir;
}

/**
 * Drop cached config + DB handle so the next import/getDb picks up the
 * new DATA_DIR / env. Safe to call when modules aren't loaded yet.
 */
export async function resetServerSingletons(): Promise<void> {
  try {
    const { resetConfigForTests } = await import("../../src/lib/server/config");
    resetConfigForTests();
  } catch {
    // config module not yet imported in this test — nothing to reset.
  }
  try {
    const { closeDb } = await import("../../src/lib/server/db");
    closeDb();
  } catch {
    // db module not yet imported — nothing to close.
  }
}
