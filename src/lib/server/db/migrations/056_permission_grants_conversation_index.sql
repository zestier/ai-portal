-- 056_permission_grants_conversation_index.sql
--
-- Perf fix: permission_grants has two foreign keys with ON DELETE CASCADE,
-- user_id -> users(id) and conversation_id -> conversations(id). SQLite can
-- satisfy a cascading delete with an index only when the referencing column is
-- the LEFTMOST column of that index. The only index on the table
-- (idx_permission_grants_lookup, migration 009) leads with user_id, so deleting
-- a user is indexed but deleting a *conversation* forces a full table scan of
-- permission_grants to find the rows to cascade. On instances with many stored
-- grants that makes every conversation delete O(n).
--
-- Add a dedicated index keyed on conversation_id so the conversation-delete
-- cascade is an index lookup. The lookup index (user_id, conversation_id, tool)
-- still serves the app's grant-matching queries, which always bind user_id.

CREATE INDEX idx_permission_grants_conversation
  ON permission_grants(conversation_id);
