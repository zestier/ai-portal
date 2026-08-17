import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("permission grant path-rule migration", () => {
  it("rewrites legacy fs rule variants to composable path rules", () => {
    const db = new Database(":memory:");
    db.exec(`
			CREATE TABLE permission_grants (
				id INTEGER PRIMARY KEY,
				scope_json TEXT
			);
		`);
    const insert = db.prepare(
      "INSERT INTO permission_grants(id, scope_json) VALUES (?, ?)",
    );
    insert.run(
      1,
      '{"kind":"fs","perms":["read"],"rule":{"kind":"exact","path":"/tmp/a"}}',
    );
    insert.run(2, '{"kind":"fs","rule":{"kind":"workspace"}}');
    insert.run(
      3,
      '{"kind":"fs","perms":["write"],"rule":{"kind":"session-workspace"}}',
    );
    insert.run(
      4,
      '{"kind":"fs","rule":{"kind":"workspace-glob","glob":"src/**"}}',
    );
    insert.run(
      5,
      '{"kind":"fs","perms":["read"],"rule":{"kind":"prefix","path":"/tmp/dir"}}',
    );
    insert.run(6, "not json");
    insert.run(7, '{"kind":"fs","rule":{"kind":"exact","path":null}}');
    insert.run(8, '{"kind":"fs","rule":{"kind":"workspace-glob","glob":""}}');

    db.exec(
      readFileSync(
        resolve(
          process.cwd(),
          "tests/fixtures/migrations/017_permission_grants_path_rules.sql",
        ),
        "utf8",
      ),
    );

    const rows = db
      .prepare(
        "SELECT id, scope_json FROM permission_grants WHERE id <= 5 ORDER BY id",
      )
      .all() as {
      id: number;
      scope_json: string;
    }[];
    expect(rows.map((r) => [r.id, JSON.parse(r.scope_json)])).toEqual([
      [
        1,
        {
          kind: "fs",
          perms: ["read"],
          rule: {
            kind: "path",
            root: "absolute",
            behavior: "exact",
            value: "/tmp/a",
          },
        },
      ],
      [
        2,
        {
          kind: "fs",
          rule: { kind: "path", root: "workspace", behavior: "any" },
        },
      ],
      [
        3,
        {
          kind: "fs",
          perms: ["write"],
          rule: { kind: "path", root: "session-workspace", behavior: "any" },
        },
      ],
      [
        4,
        {
          kind: "fs",
          rule: {
            kind: "path",
            root: "workspace",
            behavior: "glob",
            value: "src/**",
          },
        },
      ],
      [
        5,
        {
          kind: "fs",
          perms: ["read"],
          rule: {
            kind: "path",
            root: "absolute",
            behavior: "prefix",
            value: "/tmp/dir",
          },
        },
      ],
    ]);
    expect(
      db
        .prepare(
          "SELECT id, scope_json FROM permission_grants WHERE id > 5 ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: 6, scope_json: "not json" },
      {
        id: 7,
        scope_json: '{"kind":"fs","rule":{"kind":"exact","path":null}}',
      },
      {
        id: 8,
        scope_json: '{"kind":"fs","rule":{"kind":"workspace-glob","glob":""}}',
      },
    ]);
    db.close();
  });
});
