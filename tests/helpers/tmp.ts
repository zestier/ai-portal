import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created = new Set<string>();

/**
 * Make a tmpdir that is automatically removed after the test file finishes.
 * Tests should prefer this over raw mkdtempSync so /tmp doesn't accumulate.
 */
export function makeTmpDir(prefix = "portal-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.add(dir);
  return dir;
}

/** Remove all tmpdirs created via makeTmpDir. Called from tests/setup.ts. */
export function cleanupTmpDirs(): void {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort; nothing to do on EBUSY/permission errors.
    }
  }
  created.clear();
}
