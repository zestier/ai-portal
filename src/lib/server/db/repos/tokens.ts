import { getDb } from "../index";
import { encrypt, decryptString } from "../../crypto";

interface TokenRow {
  user_id: string;
  github_token_ct: Buffer | null;
  byok_keys_ct: Buffer | null;
  updated_at: number;
}

export function getGithubToken(userId: string): string | null {
  const r = getDb()
    .prepare("SELECT * FROM user_tokens WHERE user_id = ?")
    .get(userId) as TokenRow | undefined;
  if (!r || !r.github_token_ct) return null;
  try {
    return decryptString(r.github_token_ct);
  } catch {
    return null;
  }
}

export function setGithubToken(userId: string, token: string) {
  const ct = encrypt(token);
  getDb()
    .prepare(
      `INSERT INTO user_tokens(user_id, github_token_ct, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET github_token_ct = excluded.github_token_ct, updated_at = excluded.updated_at`,
    )
    .run(userId, ct, Date.now());
}

export function getByokKeys(userId: string): Record<string, string> {
  const r = getDb()
    .prepare("SELECT * FROM user_tokens WHERE user_id = ?")
    .get(userId) as TokenRow | undefined;
  if (!r || !r.byok_keys_ct) return {};
  try {
    return JSON.parse(decryptString(r.byok_keys_ct));
  } catch {
    return {};
  }
}

export function setByokKeys(userId: string, keys: Record<string, string>) {
  const ct = encrypt(JSON.stringify(keys));
  getDb()
    .prepare(
      `INSERT INTO user_tokens(user_id, byok_keys_ct, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(user_id) DO UPDATE SET byok_keys_ct = excluded.byok_keys_ct, updated_at = excluded.updated_at`,
    )
    .run(userId, ct, Date.now());
}
