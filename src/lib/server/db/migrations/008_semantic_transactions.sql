CREATE TABLE semantic_transactions (
  id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_tool_call_id INTEGER NOT NULL,
  worker_model TEXT NOT NULL,
  status TEXT NOT NULL,
  intent TEXT NOT NULL,
  messages_json TEXT NOT NULL,
  pending_json TEXT,
  summary TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_semantic_transactions_conversation
  ON semantic_transactions(conversation_id, updated_at DESC);

CREATE TABLE semantic_artifacts (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES semantic_transactions(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_semantic_artifacts_transaction
  ON semantic_artifacts(transaction_id, kind, created_at);