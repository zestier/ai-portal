import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("permission grant command-path migration", () => {
  it("rewrites legacy shell scopes and splits subcommand alternatives into grants", () => {
    const db = new Database(":memory:");
    db.exec(`
			CREATE TABLE permission_grants (
				user_id TEXT NOT NULL,
				conversation_id TEXT,
				tool TEXT NOT NULL,
				permission_kind TEXT,
				scope_pattern TEXT,
				scope_json TEXT,
				decision TEXT NOT NULL,
				expires_at INTEGER,
				granted_at INTEGER NOT NULL,
				deny_reason TEXT,
				args_hash TEXT,
				source TEXT NOT NULL DEFAULT 'legacy'
			);
		`);
    const insert = db.prepare(
      `INSERT INTO permission_grants(
				user_id, conversation_id, tool, permission_kind, scope_pattern, scope_json,
				decision, expires_at, granted_at, deny_reason, args_hash, source
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "u1",
      null,
      "shell",
      "shell",
      null,
      JSON.stringify({
        kind: "shell",
        rule: {
          argv0: "git",
          subcommands: ["status", "log"],
          preSubcommandOptions: {
            allow: [{ name: "--no-pager", kind: "flag" }],
          },
          options: { allow: [{ name: "--oneline", kind: "flag" }] },
          positionals: { kind: "any" },
          pipeline: "forbid",
        },
      }),
      "deny",
      123,
      1000,
      "use structured git",
      "hash",
      "seed",
    );
    insert.run(
      "u1",
      "conv",
      "shell",
      "shell",
      null,
      JSON.stringify({
        kind: "shell",
        rule: {
          argv0: "rg",
          options: { deny: ["--pre"] },
        },
      }),
      "allow",
      null,
      1001,
      null,
      null,
      "prompt",
    );
    insert.run(
      "u1",
      null,
      "shell",
      "shell",
      null,
      JSON.stringify({
        kind: "shell",
        rule: { command: [{ token: "node" }] },
      }),
      "allow",
      null,
      1002,
      null,
      null,
      "settings",
    );
    insert.run(
      "u1",
      null,
      "shell",
      "shell",
      null,
      JSON.stringify({
        kind: "shell",
        rule: {
          argv0: "bad-subcommands",
          subcommands: { not: "an array" },
        },
      }),
      "allow",
      null,
      1003,
      null,
      null,
      "legacy",
    );
    insert.run(
      "u1",
      null,
      "shell",
      "shell",
      null,
      JSON.stringify({
        kind: "shell",
        rule: {
          argv0: "bad-options",
          options: "not an object",
        },
      }),
      "allow",
      null,
      1004,
      null,
      null,
      "legacy",
    );
    insert.run(
      "u1",
      null,
      "shell",
      "shell",
      null,
      JSON.stringify({
        kind: "shell",
        rule: {
          argv0: "tool",
          preSubcommandOptions: {
            allow: [{ name: "--global", kind: "flag" }],
            deny: ["--deny-global"],
          },
          options: {
            allow: [{ name: "--local", kind: "flag" }],
            deny: ["--deny-local"],
          },
        },
      }),
      "allow",
      null,
      1005,
      null,
      null,
      "legacy",
    );

    db.exec(
      readFileSync(
        resolve(
          process.cwd(),
          "tests/fixtures/migrations/023_shell_command_path_scopes.sql",
        ),
        "utf8",
      ),
    );

    const rows = db
      .prepare(
        `SELECT conversation_id, scope_json, decision, expires_at, granted_at, deny_reason, args_hash, source
				 FROM permission_grants
				 ORDER BY granted_at, json_extract(scope_json, '$.rule.command[1].token')`,
      )
      .all() as Array<{
      conversation_id: string | null;
      scope_json: string;
      decision: string;
      expires_at: number | null;
      granted_at: number;
      deny_reason: string | null;
      args_hash: string | null;
      source: string;
    }>;

    expect(rows).toHaveLength(7);
    expect(rows.slice(0, 2).map((r) => JSON.parse(r.scope_json))).toEqual([
      {
        kind: "shell",
        rule: {
          command: [
            {
              token: "git",
              options: { allow: [{ name: "--no-pager", kind: "flag" }] },
            },
            {
              token: "log",
              options: { allow: [{ name: "--oneline", kind: "flag" }] },
            },
          ],
          positionals: { kind: "any" },
          pipeline: "forbid",
        },
      },
      {
        kind: "shell",
        rule: {
          command: [
            {
              token: "git",
              options: { allow: [{ name: "--no-pager", kind: "flag" }] },
            },
            {
              token: "status",
              options: { allow: [{ name: "--oneline", kind: "flag" }] },
            },
          ],
          positionals: { kind: "any" },
          pipeline: "forbid",
        },
      },
    ]);
    expect(rows[0]).toMatchObject({
      decision: "deny",
      expires_at: 123,
      granted_at: 1000,
      deny_reason: "use structured git",
      args_hash: "hash",
      source: "seed",
    });
    expect(JSON.parse(rows[2].scope_json)).toEqual({
      kind: "shell",
      rule: { command: [{ token: "rg", options: { deny: ["--pre"] } }] },
    });
    expect(JSON.parse(rows[3].scope_json)).toEqual({
      kind: "shell",
      rule: { command: [{ token: "node" }] },
    });
    expect(JSON.parse(rows[4].scope_json)).toEqual({
      kind: "shell",
      rule: { argv0: "bad-subcommands", subcommands: { not: "an array" } },
    });
    expect(JSON.parse(rows[5].scope_json)).toEqual({
      kind: "shell",
      rule: { argv0: "bad-options", options: "not an object" },
    });
    expect(JSON.parse(rows[6].scope_json)).toEqual({
      kind: "shell",
      rule: {
        command: [
          {
            token: "tool",
            options: {
              allow: [
                { name: "--global", kind: "flag" },
                { name: "--local", kind: "flag" },
              ],
              deny: ["--deny-global", "--deny-local"],
            },
          },
        ],
      },
    });
    db.close();
  });
});
