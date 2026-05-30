ALTER TABLE conversations ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'off';

CREATE TABLE memory_entities (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  entity_key      TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  summary         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active',
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE(conversation_id, entity_key)
);
CREATE INDEX idx_memory_entities_conv_type
  ON memory_entities(conversation_id, entity_type, status);

CREATE TABLE memory_events (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id            TEXT,
  event_type         TEXT NOT NULL,
  occurred_at        INTEGER NOT NULL,
  actor_entity_id    TEXT REFERENCES memory_entities(id) ON DELETE SET NULL,
  target_entity_id   TEXT REFERENCES memory_entities(id) ON DELETE SET NULL,
  summary            TEXT NOT NULL,
  payload_json       TEXT NOT NULL DEFAULT '{}',
  visibility         TEXT NOT NULL DEFAULT 'session',
  confidence         REAL NOT NULL DEFAULT 1,
  source_message_id  TEXT REFERENCES messages(id) ON DELETE SET NULL,
  source_tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_memory_events_conv_created
  ON memory_events(conversation_id, created_at DESC);
CREATE INDEX idx_memory_events_conv_target
  ON memory_events(conversation_id, target_entity_id, created_at DESC);

CREATE TABLE memory_facts (
  id                  TEXT PRIMARY KEY,
  conversation_id     TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  entity_id           TEXT REFERENCES memory_entities(id) ON DELETE SET NULL,
  predicate           TEXT NOT NULL,
  value_json          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  visibility          TEXT NOT NULL DEFAULT 'session',
  confidence          REAL NOT NULL DEFAULT 1,
  source_event_id     TEXT REFERENCES memory_events(id) ON DELETE SET NULL,
  source_message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
  supersedes_fact_id  TEXT REFERENCES memory_facts(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX idx_memory_facts_conv_entity
  ON memory_facts(conversation_id, entity_id, status);
CREATE INDEX idx_memory_facts_conv_predicate
  ON memory_facts(conversation_id, predicate, status);

CREATE TABLE memory_open_loops (
  id                     TEXT PRIMARY KEY,
  conversation_id        TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  loop_type              TEXT NOT NULL,
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'open',
  priority               INTEGER NOT NULL DEFAULT 0,
  related_entity_ids_json TEXT NOT NULL DEFAULT '[]',
  source_event_id        TEXT REFERENCES memory_events(id) ON DELETE SET NULL,
  source_message_id      TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX idx_memory_open_loops_conv_status
  ON memory_open_loops(conversation_id, status, priority DESC, updated_at DESC);

CREATE TABLE memory_decisions (
  id                TEXT PRIMARY KEY,
  conversation_id   TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  subject           TEXT NOT NULL,
  decision          TEXT NOT NULL,
  rationale         TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'active',
  source_event_id   TEXT REFERENCES memory_events(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_memory_decisions_conv_status
  ON memory_decisions(conversation_id, status, updated_at DESC);

CREATE TABLE memory_patches (
  id                    TEXT PRIMARY KEY,
  conversation_id         TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id                 TEXT,
  status                  TEXT NOT NULL,
  summary                 TEXT NOT NULL DEFAULT '',
  raw_patch_json          TEXT NOT NULL DEFAULT '{}',
  validation_result_json  TEXT NOT NULL DEFAULT '{}',
  created_at              INTEGER NOT NULL,
  committed_at            INTEGER
);
CREATE INDEX idx_memory_patches_conv_created
  ON memory_patches(conversation_id, created_at DESC);

CREATE TABLE memory_validation_issues (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  patch_id        TEXT REFERENCES memory_patches(id) ON DELETE CASCADE,
  severity        TEXT NOT NULL,
  code            TEXT NOT NULL,
  message         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      INTEGER NOT NULL,
  resolved_at     INTEGER
);
CREATE INDEX idx_memory_validation_issues_conv_status
  ON memory_validation_issues(conversation_id, status, created_at DESC);

CREATE TABLE memory_tool_calls (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id         TEXT,
  tool_name       TEXT NOT NULL,
  arguments_json  TEXT NOT NULL DEFAULT '{}',
  result_summary  TEXT NOT NULL DEFAULT '',
  result_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_memory_tool_calls_conv_created
  ON memory_tool_calls(conversation_id, created_at DESC);

CREATE VIRTUAL TABLE memory_search_index USING fts5(
  conversation_id UNINDEXED,
  item_type UNINDEXED,
  item_id UNINDEXED,
  text
);
