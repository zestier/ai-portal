#!/usr/bin/env node
// Resolve every SHA-pinned GitHub Action in .github/workflows/ to the
// current tip of the major version indicated by its `# v<N>` trailing
// comment, and rewrite the SHA in place.
//
// Lines must look like:
//   uses: owner/repo@<40-hex> # v<major>
//
// Run with `pnpm run release:bump-actions`. Review the diff before
// committing.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(REPO_ROOT, ".github/workflows");
const LINE =
  /^(?<indent>\s*-?\s*uses:\s*)(?<repo>[^@\s]+)@(?<sha>[0-9a-f]{40})(?<rest>\s*#\s*v(?<major>\d+))\s*$/;

const token = process.env.GITHUB_TOKEN ?? "";
const headers = token ? { Authorization: `Bearer ${token}` } : {};

// Same repo@vN often appears on many lines (e.g. actions/cache pinned in
// every job). Memoize so we make one request per unique (repo, major).
const shaCache = new Map();

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function ghFetch(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", ...headers },
    });
    if (res.ok) return res;

    // Primary rate limit: 403/429 with X-RateLimit-Remaining: 0.
    // Secondary/abuse limit: 403/429 with Retry-After.
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = res.headers.get("retry-after");
    const reset = res.headers.get("x-ratelimit-reset");
    const rateLimited =
      (res.status === 403 || res.status === 429) &&
      (remaining === "0" || retryAfter);

    if (rateLimited && attempt < 5) {
      let waitMs;
      if (retryAfter) {
        waitMs = Number(retryAfter) * 1000;
      } else if (reset) {
        waitMs = Math.max(0, Number(reset) * 1000 - Date.now()) + 1000;
      } else {
        waitMs = 2 ** attempt * 1000;
      }
      const waitS = Math.ceil(waitMs / 1000);
      const hint = token ? "" : " (set GITHUB_TOKEN to raise the limit)";
      console.error(`rate limited on ${url}, waiting ${waitS}s${hint}`);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
}

async function fetchSha(repo, major) {
  const key = `${repo}@v${major}`;
  const cached = shaCache.get(key);
  if (cached) return cached;
  const promise = (async () => {
    const url = `https://api.github.com/repos/${repo}/commits/v${major}`;
    const res = await ghFetch(url);
    const body = await res.json();
    if (typeof body?.sha !== "string" || !/^[0-9a-f]{40}$/.test(body.sha)) {
      throw new Error(`unexpected response shape for ${key}`);
    }
    return body.sha;
  })();
  shaCache.set(key, promise);
  return promise;
}

let changed = 0;
for (const name of readdirSync(WORKFLOWS)) {
  if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
  const path = join(WORKFLOWS, name);
  const lines = readFileSync(path, "utf8").split("\n");
  let fileChanged = false;
  for (let i = 0; i < lines.length; i++) {
    const m = LINE.exec(lines[i]);
    if (!m) continue;
    const { indent, repo, sha, rest, major } = m.groups;
    const fresh = await fetchSha(repo, major);
    if (fresh === sha) continue;
    lines[i] = `${indent}${repo}@${fresh}${rest}`;
    console.log(
      `${path}: ${repo} ${sha.slice(0, 8)} -> ${fresh.slice(0, 8)} (v${major})`,
    );
    fileChanged = true;
    changed++;
  }
  if (fileChanged) writeFileSync(path, lines.join("\n"));
}

if (changed === 0)
  console.log("All pinned actions already at latest major-tip.");
