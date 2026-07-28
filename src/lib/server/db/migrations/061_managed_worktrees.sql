ALTER TABLE conversations
  ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'shared'
  CHECK (workspace_kind IN ('shared', 'managed-worktree'));

ALTER TABLE conversations ADD COLUMN workspace_key TEXT;

CREATE TABLE managed_worktrees (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  source_workdir   TEXT NOT NULL,
  path             TEXT NOT NULL UNIQUE,
  git_common_dir   TEXT NOT NULL,
  branch           TEXT NOT NULL,
  base_sha         TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE(git_common_dir, branch)
);