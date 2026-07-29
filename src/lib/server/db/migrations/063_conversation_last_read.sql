-- Track when the user last looked at a conversation, so the sidebar can flag
-- conversations carrying assistant output the user hasn't seen yet.
--
-- Backfilled to `updated_at` so upgrading doesn't light up every existing
-- conversation as unseen.
ALTER TABLE conversations ADD COLUMN last_read_at INTEGER;
UPDATE conversations SET last_read_at = updated_at;
