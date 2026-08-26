CREATE TABLE proc_transactions (
  id                  TEXT PRIMARY KEY,
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  parent_tool_call_id INTEGER NOT NULL,
  worker_model        TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cannot_execute', 'failed')),
  summary             TEXT NOT NULL,
  goal                TEXT NOT NULL,
  procedure_text      TEXT NOT NULL,
  output_json         TEXT NOT NULL,
  messages_json       TEXT NOT NULL,
  result_id           TEXT,
  error               TEXT,
  usage_json          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX proc_transactions_conversation
  ON proc_transactions(conversation_id, created_at);

CREATE TABLE proc_results (
  id              TEXT PRIMARY KEY,
  transaction_id  TEXT NOT NULL REFERENCES proc_transactions(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  value_json      TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX proc_results_transaction
  ON proc_results(transaction_id, created_at);