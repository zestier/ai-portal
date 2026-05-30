CREATE TABLE global_memories (
  id                     TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                   TEXT NOT NULL,
  memory_key             TEXT NOT NULL,
  value_json             TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active',
  source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  UNIQUE(user_id, kind, memory_key)
);
CREATE INDEX idx_global_memories_user_kind
  ON global_memories(user_id, kind, status, updated_at DESC);

CREATE VIRTUAL TABLE global_memory_search_index USING fts5(
  user_id UNINDEXED,
  item_id UNINDEXED,
  text
);
