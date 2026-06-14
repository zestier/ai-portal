-- 044_background_agent_lifecycles_fk_cascade.sql
--
-- Bug fix: background_agent_lifecycles.tool_call_id was a bare PRIMARY KEY with
-- no foreign key to tool_calls(id). The delete cascade chain is
-- conversations -> messages -> tool_calls, so deleting a conversation (or any
-- message via inline-edit truncation) left orphaned lifecycle rows behind. The
-- manual cleanup in messages.ts:deleteMessagesAfter only covered the
-- inline-edit path, not conversations.remove() / direct message deletes.
--
-- SQLite can't ALTER a table to add a foreign key, so rebuild the table with
-- the standard create-new / copy / drop-old / rename pattern, preserving all
-- columns, data, and indexes, and adding REFERENCES tool_calls(id) ON DELETE
-- CASCADE. Nothing references background_agent_lifecycles, so no other table's
-- foreign keys are affected by the rename. The migration runner wraps each
-- migration in a transaction and runs with PRAGMA foreign_keys = ON. The copy
-- below is filtered to rows whose tool_call_id still points at a live
-- tool_calls row: any pre-existing orphans (the very symptom of this bug on
-- older DBs) would otherwise violate the new FK and abort the migration, so we
-- drop them here instead.

CREATE TABLE background_agent_lifecycles_new (
  tool_call_id TEXT PRIMARY KEY REFERENCES tool_calls(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

INSERT INTO background_agent_lifecycles_new
  (tool_call_id, agent_id, status, started_at, ended_at)
SELECT bal.tool_call_id, bal.agent_id, bal.status, bal.started_at, bal.ended_at
FROM background_agent_lifecycles bal
WHERE EXISTS (SELECT 1 FROM tool_calls tc WHERE tc.id = bal.tool_call_id);

DROP TABLE background_agent_lifecycles;
ALTER TABLE background_agent_lifecycles_new RENAME TO background_agent_lifecycles;

CREATE INDEX idx_background_agent_lifecycles_agent
  ON background_agent_lifecycles(agent_id);
