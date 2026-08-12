import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('permission grant source migration', () => {
	it('marks identifiable default seeds without rewriting decisions or user grants', () => {
		const db = new Database(':memory:');
		db.exec(`
			CREATE TABLE permission_grants (
				id INTEGER PRIMARY KEY,
				conversation_id TEXT,
				tool TEXT NOT NULL,
				permission_kind TEXT,
				scope_json TEXT,
				decision TEXT NOT NULL,
				args_hash TEXT
			);
		`);
		const insert = db.prepare(
			`INSERT INTO permission_grants(
				id, conversation_id, tool, permission_kind, scope_json, decision, args_hash
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)`
		);
		insert.run(
			1,
			null,
			'shell',
			'shell',
			'{"kind":"shell","rule":{"argv0":"cat","pipeline":"forbid"}}',
			'deny',
			null
		);
		insert.run(
			2,
			null,
			'shell',
			'shell',
			'{"kind":"shell","rule":{"argv0":"cat","pipeline":"forbid"}}',
			'prompt',
			null
		);
		insert.run(
			3,
			null,
			'shell',
			'shell',
			'{"kind":"shell","rule":{"argv0":"node"}}',
			'allow',
			null
		);
		insert.run(4, null, 'git_status', 'custom-tool', '{"kind":"any"}', 'allow', null);
		insert.run(
			5,
			'conv-1',
			'shell',
			'shell',
			'{"kind":"shell","rule":{"argv0":"cat","pipeline":"forbid"}}',
			'deny',
			null
		);

		db.exec(
			readFileSync(
				resolve(process.cwd(), 'tests/fixtures/migrations/022_permission_grant_source.sql'),
				'utf8'
			)
		);

		expect(
			db.prepare('SELECT id, decision, source FROM permission_grants ORDER BY id').all()
		).toEqual([
			{ id: 1, decision: 'deny', source: 'seed' },
			{ id: 2, decision: 'prompt', source: 'seed' },
			{ id: 3, decision: 'allow', source: 'legacy' },
			{ id: 4, decision: 'allow', source: 'seed' },
			{ id: 5, decision: 'deny', source: 'legacy' }
		]);
		db.close();
	});
});
