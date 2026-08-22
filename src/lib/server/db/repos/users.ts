import { getDb } from "../index";
import type { User } from "$lib/types";
import { ensureSeedGrantsForUser } from "../../permissions/seed-grants";
import { ensureCavemanExtensionSeeded } from "./extensions";

interface UserRow {
  id: number;
  github_login: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: number;
  last_login_at: number | null;
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    githubLogin: r.github_login,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
  };
}

export function getById(id: number): User | null {
  const r = getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as
    UserRow | undefined;
  return r ? rowToUser(r) : null;
}

/**
 * Idempotently get-or-create the single shared local user.
 *
 * The optional key is reserved for isolated e2e users; normal local mode
 * continues to use the single `local` user.
 */
export function ensureLocalUser(key = "local"): User {
  const db = getDb();
  // Keep the SELECT and the cold-start INSERT in the SAME transaction so the
  // get-or-create is atomic. With the synchronous single-process
  // better-sqlite3 connection each transaction runs to completion before the
  // next, so two callers can't both observe existing=undefined and race to
  // INSERT the 'local' user (violating UNIQUE(github_login)).
  return db.transaction((): User => {
    const githubLogin = key === "local" ? "local" : `local:${key}`;
    const existing = db
      .prepare("SELECT * FROM users WHERE github_login = ?")
      .get(githubLogin) as UserRow | undefined;
    if (existing) return rowToUser(existing);
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO users(github_login, display_name, created_at, last_login_at)
			 VALUES (?, ?, ?, ?)`,
      )
      .run(
        githubLogin,
        key === "local" ? "Local user" : `Local user (${key})`,
        now,
        now,
      );
    const id = Number(info.lastInsertRowid);
    ensureSeedGrantsForUser(id);
    ensureCavemanExtensionSeeded(id);
    return {
      id,
      githubLogin,
      displayName: key === "local" ? "Local user" : `Local user (${key})`,
      avatarUrl: null,
    };
  })();
}
