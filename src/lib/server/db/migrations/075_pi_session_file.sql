-- 075_pi_session_file.sql
--
-- Track the durable pi session file per conversation. Each conversation owns
-- one append-only JSONL session tree (DATA_DIR/sessions/) that survives pool
-- reaping and process restarts; `session_file` is the index entry pointing at
-- it, so a later `pool.acquire` can resume the same tree instead of starting
-- fresh. NULL until the conversation's first pi turn creates a file.

ALTER TABLE conversations ADD COLUMN session_file TEXT;
