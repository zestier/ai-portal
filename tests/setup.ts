import { afterAll, afterEach, beforeEach } from "vitest";
import { cleanupTmpDirs } from "./helpers/tmp";

/**
 * Per-test env snapshot/restore. Many tests mutate process.env (DATA_DIR,
 * ENCRYPTION_KEY, …); without restoration the leaks can change
 * the behavior of unrelated tests. Snapshot once per test and roll back.
 */
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  cleanupTmpDirs();
});

// Default to warn-level logging so the suite isn't drowned in
// db.migration.applied / db.open lines.
if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "warn";
