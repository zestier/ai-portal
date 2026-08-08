-- Checked-in workspace permissions (`.zap/permissions.toml`).
--
-- File grants are materialized as ordinary `permission_grants` rows tagged
-- `source='workspace-file'` plus a `workspace_root`, so the existing matcher
-- applies them with NO precedence changes: `deny` already outranks `allow`
-- regardless of source, and `force-allow` (which would outrank a deny) is only
-- ever minted by the manual tool-rerun route, a deliberate human gesture.
-- Non-file rows keep `workspace_root = NULL`.
--
-- `workspace_permission_state` records the last human-approved snapshot and
-- its SHA-256 hash per (user, workspace root). The permission gate recomputes
-- the hash of the file on disk and compares it against this row; a mismatch
-- keeps the old state active and raises a review, so a drifted (or deleted)
-- file can never silently widen or erase the checked-in policy.
ALTER TABLE permission_grants ADD COLUMN workspace_root TEXT;

CREATE TABLE workspace_permission_state (
  user_id        TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  snapshot_text  TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_root)
);
