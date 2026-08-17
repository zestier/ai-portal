// Portal-managed model providers: CRUD + at-rest-encrypted API keys.
//
// Keys are AES-256-GCM ciphertext in the `api_key_ct` column (ENCRYPTION_KEY),
// mirroring the user_tokens pattern. The decrypted key is served to the pi
// ModelRuntime through PortalCredentialStore (credential-store.ts) — it is
// never written to models.json or returned to the client.

import { getDb } from "../index";
import { encrypt, decryptString } from "../../crypto";
import type { ManagedProvider, ProviderApi } from "$lib/types";

interface ProviderRow {
  id: string;
  name: string;
  api: string;
  base_url: string | null;
  api_key_ct: Buffer | null;
  headers_json: string;
  auth_header: number;
  builtin: number;
  enabled: number;
  compat_json: string | null;
  created_at: number;
  updated_at: number;
}

const VALID_APIS: ProviderApi[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "google-generative-ai",
];

function rowToProvider(r: ProviderRow): ManagedProvider {
  return {
    id: r.id,
    name: r.name,
    api: VALID_APIS.includes(r.api as ProviderApi)
      ? (r.api as ProviderApi)
      : "openai-completions",
    baseUrl: r.base_url,
    hasKey: r.api_key_ct !== null,
    headers: parseJsonObject(r.headers_json),
    authHeader: r.auth_header === 1,
    builtin: r.builtin === 1,
    enabled: r.enabled === 1,
    compat: parseJsonRecord(r.compat_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseJsonObject(raw: string): Record<string, string> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function list(): ManagedProvider[] {
  const rows = getDb()
    .prepare("SELECT * FROM providers ORDER BY builtin DESC, name ASC")
    .all() as ProviderRow[];
  return rows.map(rowToProvider);
}

export function get(id: string): ManagedProvider | null {
  const r = getDb().prepare("SELECT * FROM providers WHERE id = ?").get(id) as
    ProviderRow | undefined;
  return r ? rowToProvider(r) : null;
}

export interface ProviderInput {
  id: string;
  name: string;
  api: ProviderApi;
  baseUrl?: string | null;
  headers?: Record<string, string>;
  authHeader?: boolean;
  builtin?: boolean;
  enabled?: boolean;
  /** Provider-level compat, merged into every model's compat by pi. */
  compat?: Record<string, unknown> | null;
}

export function upsert(input: ProviderInput): ManagedProvider {
  const now = Date.now();
  const existing = get(input.id);
  const compat =
    input.compat !== undefined ? input.compat : (existing?.compat ?? null);
  getDb()
    .prepare(
      `INSERT INTO providers(id, name, api, base_url, headers_json, auth_header, builtin, enabled, compat_json, created_at, updated_at)
			 VALUES (@id, @name, @api, @baseUrl, @headersJson, @authHeader, @builtin, @enabled, @compatJson, @createdAt, @updatedAt)
			 ON CONFLICT(id) DO UPDATE SET
			   name = excluded.name,
			   api = excluded.api,
			   base_url = excluded.base_url,
			   headers_json = excluded.headers_json,
			   auth_header = excluded.auth_header,
			   enabled = excluded.enabled,
			   compat_json = excluded.compat_json,
			   updated_at = excluded.updated_at`,
    )
    .run({
      id: input.id,
      name: input.name,
      api: input.api,
      baseUrl: input.baseUrl ?? null,
      headersJson: JSON.stringify(input.headers ?? {}),
      authHeader: input.authHeader ? 1 : 0,
      builtin: input.builtin ? 1 : 0,
      enabled: (input.enabled ?? true) ? 1 : 0,
      compatJson: compat ? JSON.stringify(compat) : null,
      createdAt: now,
      updatedAt: now,
    });
  const p = get(input.id);
  if (!p) throw new Error(`provider upsert failed: ${input.id}`);
  return p;
}

export function setEnabled(id: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, Date.now(), id);
}

export function remove(id: string): void {
  getDb().prepare("DELETE FROM providers WHERE id = ?").run(id);
}

// --- API keys ---

/** Store (or replace) a provider API key. Requires ENCRYPTION_KEY. */
export function setApiKey(id: string, key: string): void {
  const ct = encrypt(key);
  getDb()
    .prepare("UPDATE providers SET api_key_ct = ?, updated_at = ? WHERE id = ?")
    .run(ct, Date.now(), id);
}

/** Clear a stored API key. */
export function clearApiKey(id: string): void {
  getDb()
    .prepare(
      "UPDATE providers SET api_key_ct = NULL, updated_at = ? WHERE id = ?",
    )
    .run(Date.now(), id);
}

/** Decrypted key for a provider, or null when none is stored. */
export function getApiKey(id: string): string | null {
  const r = getDb()
    .prepare("SELECT api_key_ct FROM providers WHERE id = ?")
    .get(id) as { api_key_ct: Buffer | null } | undefined;
  if (!r || !r.api_key_ct) return null;
  try {
    return decryptString(r.api_key_ct);
  } catch {
    return null;
  }
}

/** Providers that have a stored key — used by the credential store's list(). */
export function listWithKeys(): { id: string }[] {
  return getDb()
    .prepare(
      "SELECT id FROM providers WHERE api_key_ct IS NOT NULL ORDER BY id",
    )
    .all() as { id: string }[];
}
