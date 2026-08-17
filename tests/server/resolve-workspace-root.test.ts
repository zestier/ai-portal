import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWorkspaceRoot,
  resetWorkspaceRootForTests,
} from "../../src/lib/server/files";

// Probe symlink support at module load (see tests/files.test.ts for why this
// can't live in beforeAll).
const symlinksWork = (() => {
  const probe = mkdtempSync(join(tmpdir(), "rwr-probe-"));
  try {
    symlinkSync(probe, join(probe, "self"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

describe("resolveWorkspaceRoot", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "rwr-test-"));
    resetWorkspaceRootForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetWorkspaceRootForTests();
    rmSync(base, { recursive: true, force: true });
  });

  it("resolves a root to its realpath", () => {
    const real = join(base, "real");
    mkdirSync(real);
    const link = join(base, "link");
    if (!symlinksWork) return; // nothing meaningful to assert without symlinks
    symlinkSync(real, link);
    expect(resolveWorkspaceRoot(link)).toBe(realpathSync(real));
  });

  it.skipIf(!symlinksWork)(
    "re-resolves a repointed symlinked root once the cache TTL expires",
    () => {
      const v1 = join(base, "workspace-v1");
      const v2 = join(base, "workspace-v2");
      mkdirSync(v1);
      mkdirSync(v2);
      const link = join(base, "workspace");
      symlinkSync(v1, link);

      vi.useFakeTimers();

      // First resolution caches v1's realpath.
      expect(resolveWorkspaceRoot(link)).toBe(realpathSync(v1));

      // Repoint the symlink at v2 (rolling-deploy style).
      unlinkSync(link);
      symlinkSync(v2, link);

      // Within the TTL the cached (now stale) realpath is still returned.
      vi.advanceTimersByTime(1_000);
      expect(resolveWorkspaceRoot(link)).toBe(realpathSync(v1));

      // Past the TTL the realpath is re-resolved and tracks the new target.
      vi.advanceTimersByTime(5_000);
      expect(resolveWorkspaceRoot(link)).toBe(realpathSync(v2));
    },
  );

  it("falls back to the lexical path (uncached) when the root is missing", () => {
    const missing = join(base, "does-not-exist");
    // Returns the lexical absolute path without throwing or caching.
    expect(resolveWorkspaceRoot(missing)).toBe(missing);
    // Once the path exists a later call resolves it for real (no stale miss).
    mkdirSync(missing);
    expect(resolveWorkspaceRoot(missing)).toBe(realpathSync(missing));
  });
});
