ALTER TABLE memory_patches ADD COLUMN extractor_kind TEXT;
ALTER TABLE memory_patches ADD COLUMN extractor_model TEXT;
ALTER TABLE memory_patches ADD COLUMN extractor_confidence REAL;
ALTER TABLE memory_patches ADD COLUMN extractor_diagnostics_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE memory_embeddings (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         TEXT REFERENCES users(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  item_type       TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  dimensions      INTEGER NOT NULL,
  text_hash       TEXT NOT NULL,
  text            TEXT NOT NULL,
  vector_json     TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(scope, item_type, item_id, embedding_model)
);
CREATE INDEX idx_memory_embeddings_session
  ON memory_embeddings(conversation_id, item_type);
CREATE INDEX idx_memory_embeddings_global
  ON memory_embeddings(user_id, item_type);
