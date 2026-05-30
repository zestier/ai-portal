CREATE TABLE memory_custom_profiles (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  instructions      TEXT NOT NULL,
  schema_json       TEXT NOT NULL DEFAULT '{}',
  status            TEXT NOT NULL DEFAULT 'open',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  archived_at       INTEGER,
  UNIQUE(user_id, name)
);
CREATE INDEX idx_memory_custom_profiles_user_status
  ON memory_custom_profiles(user_id, status, updated_at DESC);
