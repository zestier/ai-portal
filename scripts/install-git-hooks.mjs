#!/usr/bin/env node
// Point git at the repo-tracked hooks directory. Safe to run anywhere:
// silently no-ops outside a git working tree (e.g. inside the Docker build,
// fresh tarball installs, etc.).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

if (!existsSync(resolve(repoRoot, ".git"))) {
  process.exit(0);
}

const hooksPath = "scripts/git-hooks";
const result = spawnSync("git", ["config", "core.hooksPath", hooksPath], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.status !== 0) {
  console.warn(`[install-git-hooks] failed to set core.hooksPath=${hooksPath}`);
  process.exit(0);
}
