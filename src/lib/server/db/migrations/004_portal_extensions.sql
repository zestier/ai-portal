-- 004_portal_extensions.sql
-- Operator-managed pi extension sources (ticket #33), loaded into every pi
-- session via `additionalExtensionPaths` on the next turn after a change.
-- Per-user (like user_settings / prompt_templates): single-user deployments are
-- effectively global; multi-user rows are isolated by user_id.
--
-- `value` semantics by `kind`:
--   'file'    → path to a .ts file/dir (index.ts), resolved against PROJECT_ROOT
--   'inline'  → TS source, materialized to DATA_DIR/extensions/portal-ext-<id>.ts
--   'package' → pi package spec `npm:<name>@<version>` / `git:<repo>@<ref>`,
--               passed through `additionalExtensionPaths` unchanged (the SDK
--               installs/clones it into <agentDir>/tmp/extensions/ on demand).
CREATE TABLE portal_extensions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,              -- display name 1..120
  kind        TEXT NOT NULL,              -- 'file'|'inline'|'package' (app-validated)
  value       TEXT NOT NULL,              -- path | TS source | package spec
  enabled     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'open',  -- 'open'|'archived'; API only uses 'open'
  sort_order  INTEGER NOT NULL DEFAULT 0,     -- load order ASC then id ASC
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX idx_portal_extensions_user ON portal_extensions(user_id, status, sort_order);
