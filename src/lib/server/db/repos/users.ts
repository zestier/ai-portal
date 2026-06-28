import { ulid } from '../ids';
import { getDb } from '../index';
import type { User } from '$lib/types';
import { ensureSeedGrantsForUser } from '../../permissions/seed-grants';

interface UserRow {
	id: string;
	github_login: string;
	github_id: number | null;
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
		avatarUrl: r.avatar_url
	};
}

export function getById(id: string): User | null {
	const r = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
	return r ? rowToUser(r) : null;
}

export function getByGithubLogin(login: string): User | null {
	const r = getDb().prepare('SELECT * FROM users WHERE github_login = ?').get(login) as
		| UserRow
		| undefined;
	return r ? rowToUser(r) : null;
}

export interface UpsertGithubInput {
	githubLogin: string;
	githubId: number;
	displayName: string | null;
	avatarUrl: string | null;
}

export function upsertGithub(input: UpsertGithubInput): User {
	const db = getDb();
	return db.transaction((): User => {
		// Match on github_id alone: it is stable and never recycled, whereas a
		// github_login can be vacated and reclaimed by a different account. Using
		// the login in the lookup would let a new user be merged onto the row of an
		// unrelated user who once held that username (account takeover).
		const existing = db.prepare('SELECT * FROM users WHERE github_id = ?').get(input.githubId) as
			| UserRow
			| undefined;
		const now = Date.now();
		if (existing) {
			db.prepare(
				`UPDATE users SET github_login = ?, github_id = ?, display_name = ?, avatar_url = ?, last_login_at = ? WHERE id = ?`
			).run(
				input.githubLogin,
				input.githubId,
				input.displayName,
				input.avatarUrl,
				now,
				existing.id
			);
			return rowToUser({
				...existing,
				github_login: input.githubLogin,
				github_id: input.githubId,
				display_name: input.displayName,
				avatar_url: input.avatarUrl,
				last_login_at: now
			});
		}
		const id = ulid();
		db.prepare(
			`INSERT INTO users(id, github_login, github_id, display_name, avatar_url, created_at, last_login_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		).run(id, input.githubLogin, input.githubId, input.displayName, input.avatarUrl, now, now);
		ensureSeedGrantsForUser(id);
		return {
			id,
			githubLogin: input.githubLogin,
			displayName: input.displayName,
			avatarUrl: input.avatarUrl
		};
	})();
}

/**
 * Idempotently get-or-create the single local user used in AUTH_MODE=none.
 */
export function ensureLocalUser(): User {
	const db = getDb();
	// Keep the SELECT and the cold-start INSERT in the SAME transaction so the
	// get-or-create is atomic. With the synchronous single-process
	// better-sqlite3 connection each transaction runs to completion before the
	// next, so two callers can't both observe existing=undefined and race to
	// INSERT the 'local' user (violating UNIQUE(github_login)).
	return db.transaction((): User => {
		const existing = db.prepare('SELECT * FROM users WHERE github_login = ?').get('local') as
			| UserRow
			| undefined;
		if (existing) return rowToUser(existing);
		const id = ulid();
		const now = Date.now();
		db.prepare(
			`INSERT INTO users(id, github_login, display_name, created_at, last_login_at)
		 VALUES (?, ?, ?, ?, ?)`
		).run(id, 'local', 'Local user', now, now);
		ensureSeedGrantsForUser(id);
		return { id, githubLogin: 'local', displayName: 'Local user', avatarUrl: null };
	})();
}
