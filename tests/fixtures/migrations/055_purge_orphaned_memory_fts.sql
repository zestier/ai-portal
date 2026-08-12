-- 055_purge_orphaned_memory_fts.sql
--
-- Bug fix: the `memory_search_index` and `global_memory_search_index` tables are
-- FTS5 virtual tables. SQLite forbids an FTS5 virtual table from being the
-- target of a foreign key, so the `ON DELETE CASCADE` chains that clean the
-- relational memory tables when a conversation (or user) is deleted never reach
-- these indexes. As a result every historical conversation deletion permanently
-- leaked its session FTS rows (and a user deletion would leak its global FTS
-- rows), which on a churny instance accretes into hundreds of MB of dead index.
--
-- The ongoing leak is fixed in code (`conversations.remove` now purges the
-- session index in the same transaction as the delete). This migration is the
-- one-off backfill that sweeps rows already orphaned before that fix landed:
-- any index row whose `conversation_id` / `user_id` no longer points at a live
-- parent row. Both `conversations.id` and `users.id` are NOT NULL primary keys,
-- so the `NOT IN` subqueries can't be poisoned by NULLs.
--
-- The migration runner wraps this file in a transaction with
-- `PRAGMA foreign_keys = ON`; deleting from a plain (non-external-content) FTS5
-- table by an UNINDEXED column is a normal row delete and keeps the index
-- internally consistent.

DELETE FROM memory_search_index
 WHERE conversation_id NOT IN (SELECT id FROM conversations);

DELETE FROM global_memory_search_index
 WHERE user_id NOT IN (SELECT id FROM users);
