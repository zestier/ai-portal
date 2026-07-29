-- Worktree leases: portal-owned checkouts an agent can create for parallel
-- sub-agent work, independent of the conversation's own (primary) workspace.
--
-- Deliberately separate from `managed_worktrees` rather than a migration of it:
-- the conversation primary is load-bearing in the fail-closed workspace
-- resolution path, and unifying the two tables would risk that boundary for no
-- user-visible gain. Shared git mechanics live in `worktrees.ts` instead.
--
-- Rows are user-owned with a nullable conversation holder so a lease can later
-- be handed to a spawned child conversation without a schema change.
--
-- The ON DELETE CASCADE edges are a BACKSTOP, not the cleanup path: dropping
-- the row alone would strand the checkout on disk, so conversation deletion
-- removes leases from disk first and startup reconciliation sweeps the rest.
CREATE TABLE workspace_leases (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  held_by_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  label                   TEXT NOT NULL DEFAULT '',
  source_workdir          TEXT NOT NULL,
  git_common_dir          TEXT NOT NULL,
  path                    TEXT NOT NULL UNIQUE,
  branch                  TEXT NOT NULL,
  base_sha                TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'active'
                            CHECK (state IN ('active', 'releasing')),
  created_at              INTEGER NOT NULL,
  last_used_at            INTEGER NOT NULL,
  UNIQUE(git_common_dir, branch)
);

CREATE INDEX idx_workspace_leases_holder
  ON workspace_leases(held_by_conversation_id);

CREATE INDEX idx_workspace_leases_user_state
  ON workspace_leases(user_id, state);
