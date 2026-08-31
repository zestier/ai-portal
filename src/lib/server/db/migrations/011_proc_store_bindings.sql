CREATE TABLE proc_store_bindings (
  transaction_id  TEXT NOT NULL REFERENCES proc_transactions(id) ON DELETE CASCADE,
  tool_call_id    INTEGER NOT NULL,
  name            TEXT NOT NULL,
  result_id       TEXT NOT NULL REFERENCES proc_results(id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (transaction_id, tool_call_id, name)
);

CREATE INDEX proc_store_bindings_latest
  ON proc_store_bindings(transaction_id, name, tool_call_id DESC);
