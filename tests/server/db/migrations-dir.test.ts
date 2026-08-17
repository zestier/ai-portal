import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMigrationsDir } from "../../../src/lib/server/db";

describe("resolveMigrationsDir", () => {
  const scratchDirs: string[] = [];

  afterEach(() => {
    for (const dir of scratchDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    scratchDirs.length = 0;
  });

  it("finds migrations shipped at an installed package root", () => {
    const consumer = mkdtempSync(join(tmpdir(), "zap-migrations-test-"));
    scratchDirs.push(consumer);
    const packageRoot = join(consumer, "node_modules", "zap");
    const compiledModuleDir = join(packageRoot, "build/server/chunks/chunks");
    const migrations = join(packageRoot, "src/lib/server/db/migrations");
    mkdirSync(compiledModuleDir, { recursive: true });
    mkdirSync(migrations, { recursive: true });

    expect(resolveMigrationsDir(undefined, compiledModuleDir, consumer)).toBe(
      migrations,
    );
  });
});
