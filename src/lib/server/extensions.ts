// Operator-managed pi extensions loaded at runtime into every pi session
// (Settings → Extensions, /api/admin/extensions).
//
// Three kinds, all validated here:
//   'file'    — path to a .ts file/dir (index.ts), resolved against PROJECT_ROOT
//   'inline'  — TS source stored in the DB, materialized to
//               DATA_DIR/extensions/portal-ext-<id>.ts (filename from the
//               numeric id — no traversal)
//   'package' — pi spec `npm:<name>@<version>` / `git:<repo>@<ref>`, passed
//               through `additionalExtensionPaths` unchanged; the SDK installs
//              /clones it into <agentDir>/tmp/extensions/ on demand. Pinning is
//               mandatory (unpinned git sources re-pull on every session open).
//
// Runtime effect: `fingerprint` drives the session-pool re-match — a change
// disposes+recreates the cached session on the next acquire (next turn). Load
// failures are non-fatal (the SDK's `LoadExtensionsResult.errors`); sessions
// always open.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config";
import { extensionId } from "$lib/ids";
import type { PortalExtension, PortalExtensionKind } from "$lib/types";
import * as extensionsRepo from "./db/repos/extensions";

/** Where materialized inline extensions live, under the portal DATA_DIR. */
export function EXTENSION_DIR(cfg: { DATA_DIR: string }): string {
  return resolve(cfg.DATA_DIR, "extensions");
}

export function list(
  userId: number,
  opts: extensionsRepo.ListOptions = {},
): PortalExtension[] {
  return extensionsRepo.list(userId, opts);
}

/** Enabled, open extension rows for a user, in load order. */
export function enabledEntries(userId: number): PortalExtension[] {
  return extensionsRepo
    .list(userId, { status: "open" })
    .filter((e) => e.enabled);
}

/**
 * Pure validation for a (kind, value) pair. Returns a human-readable error
 * message, or `null` when the value is acceptable.
 */
export function validateExtensionValue(
  kind: PortalExtensionKind,
  value: string,
): string | null {
  const v = value.trim();
  if (!v) return "Extension value cannot be empty.";
  if (kind === "file") {
    if (v.length > 4096)
      return "File extension paths must be 4096 characters or fewer.";
    return null;
  }
  if (kind === "inline") {
    if (v.length > 200_000)
      return "Inline extension source must be 200,000 characters or fewer.";
    return null;
  }
  if (kind === "package") {
    if (v.length > 500) return "Package specs must be 500 characters or fewer.";
    const pinned =
      /^npm:[^\s]+@[^\s]+$/.test(v) || /^git:[^\s]+@[^\s]+$/.test(v);
    if (!pinned) {
      return "Package specs require an explicit version/ref, e.g. npm:scope/pkg@1.2.3 or git:github.com/user/repo@v1";
    }
    return null;
  }
  return `Unknown extension kind: ${kind}`;
}

const INLINE_FILE_RE = /^portal-ext-(\d+)\.ts$/;

/**
 * Idempotently materialize inline extension sources to
 * `DATA_DIR/extensions/portal-ext-<id>.ts`, writing only when the content
 * changed, and best-effort removing files whose rows are disabled/archived/
 * deleted (a stale file is harmless — the loader simply never sees it).
 */
export async function materializeInlineFiles(userId: number): Promise<void> {
  const dir = EXTENSION_DIR(loadConfig());
  mkdirSync(dir, { recursive: true });
  const enabled = new Set<number>();
  for (const e of enabledEntries(userId)) {
    if (e.kind !== "inline") continue;
    const numId = extensionId.parse(e.id);
    const file = join(dir, `portal-ext-${numId}.ts`);
    let current: string | null;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      current = null;
    }
    if (current !== e.value) writeFileSync(file, e.value, "utf8");
    enabled.add(numId);
  }
  // Best-effort cleanup of stale inline files (disabled/archived/deleted rows).
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    const m = INLINE_FILE_RE.exec(f);
    if (!m) continue;
    if (!enabled.has(Number(m[1]))) {
      try {
        rmSync(join(dir, f), { force: true });
      } catch {
        // Best effort — a stale file is harmless.
      }
    }
  }
}

/**
 * The extension paths/specs fed to every pi session's `DefaultResourceLoader`
 * via `additionalExtensionPaths`. Local entries are absolute; package specs are
 * passed through unchanged (the SDK's package manager resolves them).
 */
export async function enabledExtensionPaths(userId: number): Promise<string[]> {
  await materializeInlineFiles(userId);
  const cfg = loadConfig();
  const dir = EXTENSION_DIR(cfg);
  const out: string[] = [];
  for (const e of enabledEntries(userId)) {
    if (e.kind === "file") {
      out.push(
        isAbsolute(e.value) ? e.value : resolve(cfg.PROJECT_ROOT, e.value),
      );
    } else if (e.kind === "inline") {
      out.push(join(dir, `portal-ext-${extensionId.parse(e.id)}.ts`));
    } else {
      // package: pass the raw spec string through unchanged.
      out.push(e.value);
    }
  }
  return out;
}

/**
 * A stable sha1 over the user's enabled extension set (including specs and
 * updated_at). Changes iff the enabled set changes — driving the session pool's
 * dispose+recreate on the next acquire. Deterministic across calls.
 */
export async function fingerprint(userId: number): Promise<string> {
  const entries = enabledEntries(userId);
  const body =
    "portal-extensions-v1:" +
    entries
      .map((e) => `${e.id}\u0000${e.kind}\u0000${e.value}\u0000${e.updatedAt}`)
      .join("\n");
  return createHash("sha1").update(body).digest("hex");
}

export interface VerifyResult {
  loaded: string[];
  errors: { path: string; error: string }[];
}

function pathForEntry(e: PortalExtension): string {
  const cfg = loadConfig();
  if (e.kind === "file") {
    return isAbsolute(e.value) ? e.value : resolve(cfg.PROJECT_ROOT, e.value);
  }
  if (e.kind === "inline") {
    return join(EXTENSION_DIR(cfg), `portal-ext-${extensionId.parse(e.id)}.ts`);
  }
  return e.value;
}

/**
 * Run a throwaway resource loader over the user's enabled extensions (or a
 * single entry) and report what loaded and what failed. Load failures are
 * never fatal — `errors` carries them. For `package` entries this performs the
 * resolve/install (network + subprocess) — expected. Never throws.
 */
export async function verify(
  userId: number,
  id?: string,
): Promise<VerifyResult> {
  try {
    let paths: string[];
    if (id !== undefined) {
      const e = extensionsRepo.get(userId, id);
      if (!e)
        return {
          loaded: [],
          errors: [{ path: id, error: `Extension not found: ${id}` }],
        };
      await materializeInlineFiles(userId);
      paths = [pathForEntry(e)];
    } else {
      paths = await enabledExtensionPaths(userId);
    }
    const cfg = loadConfig();
    const loader = new DefaultResourceLoader({
      cwd: cfg.PROJECT_ROOT,
      agentDir: getAgentDir(),
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: paths,
      extensionFactories: [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    return { loaded: extensions.map((e) => e.path), errors };
  } catch (err) {
    return { loaded: [], errors: [{ path: "<loader>", error: String(err) }] };
  }
}
