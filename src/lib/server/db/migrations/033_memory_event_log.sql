CREATE TABLE memory_event_log (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  parent_id          TEXT,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_kind         TEXT NOT NULL,
  item_type          TEXT NOT NULL,
  item_id            TEXT NOT NULL,
  source_message_id  TEXT,
  turn_id            TEXT,
  payload_json       TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_memory_event_log_conv_seq
  ON memory_event_log(conversation_id, seq);
CREATE INDEX idx_memory_event_log_conv_item
  ON memory_event_log(conversation_id, item_type, item_id, seq);
CREATE INDEX idx_memory_event_log_parent
  ON memory_event_log(parent_id);

CREATE TABLE memory_heads (
  conversation_id     TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  projection_event_id TEXT,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE memory_message_heads (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL,
  head_event_id   TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY(conversation_id, message_id)
);
CREATE INDEX idx_memory_message_heads_head
  ON memory_message_heads(head_event_id);

-- Generic incoming-reference table: one row for every thing that points at a
-- memory event. `ref_kind` distinguishes the source domain:
--   'memory_parent' -> another memory event (source_key = the child event id)
--   'message_head'  -> a conversation message (source_key = the message id)
-- and is intentionally open-ended (future: shared fork heads, audit roots).
-- `(ref_kind, source_key)` is unique because each source references exactly one
-- target (an event has one parent; a message has one head). The reverse index
-- on `target_event_id` lets GC ask "is this event still referenced?" in O(1),
-- which is the sole stop condition for backward-delete garbage collection.
-- memory_message_heads is kept alongside this table for ordered "what did
-- memory know at this transcript point?" lookups; memory_refs mirrors those
-- heads purely for reachability/GC.
CREATE TABLE memory_refs (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ref_kind        TEXT NOT NULL,
  source_key      TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY(ref_kind, source_key)
);
CREATE INDEX idx_memory_refs_target ON memory_refs(target_event_id);
CREATE INDEX idx_memory_refs_conv ON memory_refs(conversation_id);
