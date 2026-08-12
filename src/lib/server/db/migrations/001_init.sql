-- 001_init.sql (re-baselined)
-- Note: schema_migrations table is bootstrapped by the migration runner.
-- Single live migration: cumulative schema of the former 001-075 chain (deleted).
--
-- Entity tables use SQLite-global INTEGER PRIMARY KEY AUTOINCREMENT ids. The pi
-- agent echoes these ids through portal tool args/results every turn; int ids are
-- cheaper to emit, robust to echo (no truncated-id retries), and order naturally.
-- Opaque/external handles (agent_id, turn_id, session_file, workspace_key,
-- entity_key, loop_key, hashes) and the memory_event_log's event-store handles
-- (id/parent_id, its own seq counter) stay TEXT.

CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  github_login    TEXT UNIQUE NOT NULL,
  github_id       INTEGER UNIQUE,
  display_name    TEXT,
  avatar_url      TEXT,
  created_at      INTEGER NOT NULL,
  last_login_at   INTEGER
);

CREATE TABLE user_tokens (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_token_ct BLOB,
  byok_keys_ct    BLOB,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE user_settings (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_model      TEXT,
  default_workdir    TEXT,
  default_policy     TEXT NOT NULL DEFAULT 'prompt',
  theme              TEXT NOT NULL DEFAULT 'dark',
  updated_at         INTEGER NOT NULL
, default_mode TEXT NOT NULL DEFAULT 'interactive', accent TEXT NOT NULL DEFAULT 'default', default_approval_mode TEXT NOT NULL DEFAULT 'ask');

CREATE TABLE conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  workdir         TEXT NOT NULL,
  model           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  archived_at     INTEGER
, forked_from_conversation_id INTEGER, forked_from_message_id INTEGER, mode TEXT NOT NULL DEFAULT 'interactive', memory_mode TEXT NOT NULL DEFAULT 'off', memory_extractor_model TEXT, global_memory_enabled INTEGER NOT NULL DEFAULT 0, draft_prompt TEXT, disabled_tool_groups TEXT NOT NULL DEFAULT '[]', workspace_kind TEXT NOT NULL DEFAULT 'shared'
  CHECK (workspace_kind IN ('shared', 'managed-worktree')), workspace_key TEXT, last_read_at INTEGER, approval_mode TEXT NOT NULL DEFAULT 'ask', adversary_model TEXT, session_file TEXT);

CREATE INDEX idx_conversations_user_updated
  ON conversations(user_id, updated_at DESC);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'complete',
  error_code      TEXT,
  created_at      INTEGER NOT NULL
, reasoning TEXT, reasoning_duration_ms INTEGER);

CREATE INDEX idx_messages_conv_created
  ON messages(conversation_id, created_at);

CREATE TABLE tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  result_json     TEXT,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
, text_offset INTEGER, parent_tool_call_id INTEGER);

CREATE INDEX idx_tool_calls_message ON tool_calls(message_id);

CREATE TABLE file_edits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  diff            TEXT NOT NULL,
  created_at      INTEGER NOT NULL
, text_offset INTEGER, parent_tool_call_id INTEGER);

CREATE INDEX idx_file_edits_message ON file_edits(message_id);

CREATE TABLE permission_decisions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool            TEXT NOT NULL,
  args_summary    TEXT,
  decision        TEXT NOT NULL,
  decided_at      INTEGER NOT NULL
);

CREATE INDEX idx_permission_decisions_conv ON permission_decisions(conversation_id, decided_at DESC);

CREATE TABLE conversation_usage (
  conversation_id          INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  current_tokens           INTEGER NOT NULL,
  token_limit              INTEGER NOT NULL,
  messages_length          INTEGER NOT NULL,
  system_tokens            INTEGER,
  conversation_tokens      INTEGER,
  tool_definitions_tokens  INTEGER,
  updated_at               INTEGER NOT NULL
);

CREATE TABLE turn_snapshots (
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('pre', 'post')),
  git_ref      TEXT NOT NULL,
  commit_sha   TEXT NOT NULL,
  tree_sha     TEXT NOT NULL,
  created_at   INTEGER NOT NULL, base_commit_sha TEXT,
  PRIMARY KEY (message_id, kind)
);

CREATE INDEX idx_turn_snapshots_tree ON turn_snapshots(tree_sha);

CREATE TABLE reasoning_blocks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  segment_index   INTEGER NOT NULL,
  text            TEXT NOT NULL,
  text_offset     INTEGER,
  started_at      INTEGER NOT NULL,
  duration_ms     INTEGER
, parent_tool_call_id INTEGER, kind TEXT NOT NULL DEFAULT 'reasoning');

CREATE INDEX idx_reasoning_blocks_message
  ON reasoning_blocks(message_id, segment_index);

CREATE INDEX idx_tool_calls_parent       ON tool_calls(parent_tool_call_id);

CREATE INDEX idx_reasoning_blocks_parent ON reasoning_blocks(parent_tool_call_id);

CREATE INDEX idx_file_edits_parent       ON file_edits(parent_tool_call_id);

CREATE TABLE "permission_grants" (
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER          REFERENCES conversations(id) ON DELETE CASCADE,
  tool            TEXT    NOT NULL,
  permission_kind TEXT,
  scope_pattern   TEXT,
  decision        TEXT    NOT NULL DEFAULT 'allow',
  expires_at      INTEGER,
  granted_at      INTEGER NOT NULL
, scope_json TEXT, deny_reason TEXT, args_hash TEXT, source TEXT NOT NULL DEFAULT 'legacy', workspace_root TEXT);

CREATE INDEX idx_permission_grants_lookup
  ON permission_grants(user_id, conversation_id, tool);

CREATE TABLE workspace_tickets (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_key          TEXT NOT NULL,
  title                  TEXT NOT NULL,
  body                   TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'archived')),
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  closed_at              INTEGER
, plan TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'P2'
  CHECK (priority IN ('P0', 'P1', 'P2', 'P3')));

CREATE INDEX idx_workspace_tickets_user_workspace_status_updated
  ON workspace_tickets(user_id, workspace_key, status, updated_at DESC);

CREATE TABLE prompt_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prompt      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'archived')),
  pinned      INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER
, type TEXT NOT NULL DEFAULT 'chat', launch_behavior TEXT, conversation_mode TEXT, model TEXT, disabled_tool_groups TEXT NOT NULL DEFAULT '[]', workspace_mode TEXT, approval_mode TEXT);

CREATE INDEX idx_prompt_templates_user_status_order
  ON prompt_templates(user_id, status, pinned DESC, order_index ASC, updated_at DESC);

CREATE TABLE memory_entities (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
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
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id            TEXT,
  event_type         TEXT NOT NULL,
  occurred_at        INTEGER NOT NULL,
  actor_entity_id    INTEGER REFERENCES memory_entities(id) ON DELETE SET NULL,
  target_entity_id   INTEGER REFERENCES memory_entities(id) ON DELETE SET NULL,
  summary            TEXT NOT NULL,
  payload_json       TEXT NOT NULL DEFAULT '{}',
  visibility         TEXT NOT NULL DEFAULT 'session',
  confidence         REAL NOT NULL DEFAULT 1,
  source_message_id  INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  source_tool_call_id INTEGER REFERENCES tool_calls(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_memory_events_conv_created
  ON memory_events(conversation_id, created_at DESC);

CREATE INDEX idx_memory_events_conv_target
  ON memory_events(conversation_id, target_entity_id, created_at DESC);

CREATE TABLE memory_facts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id     INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  entity_id           INTEGER REFERENCES memory_entities(id) ON DELETE SET NULL,
  predicate           TEXT NOT NULL,
  value_json          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  visibility          TEXT NOT NULL DEFAULT 'session',
  confidence          REAL NOT NULL DEFAULT 1,
  source_event_id     INTEGER REFERENCES memory_events(id) ON DELETE SET NULL,
  source_message_id   INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  supersedes_fact_id  INTEGER REFERENCES memory_facts(id) ON DELETE SET NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
, pinned INTEGER NOT NULL DEFAULT 0);

CREATE INDEX idx_memory_facts_conv_entity
  ON memory_facts(conversation_id, entity_id, status);

CREATE INDEX idx_memory_facts_conv_predicate
  ON memory_facts(conversation_id, predicate, status);

CREATE TABLE memory_open_loops (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id        INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  loop_type              TEXT NOT NULL,
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL DEFAULT '',
  status                 TEXT NOT NULL DEFAULT 'open',
  priority               INTEGER NOT NULL DEFAULT 0,
  related_entity_ids_json TEXT NOT NULL DEFAULT '[]',
  source_event_id        INTEGER REFERENCES memory_events(id) ON DELETE SET NULL,
  source_message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
, idle_turns INTEGER NOT NULL DEFAULT 0, loop_key TEXT NOT NULL DEFAULT '');

CREATE INDEX idx_memory_open_loops_conv_status
  ON memory_open_loops(conversation_id, status, priority DESC, updated_at DESC);

CREATE TABLE memory_patches (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id         INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id                 TEXT,
  status                  TEXT NOT NULL,
  summary                 TEXT NOT NULL DEFAULT '',
  raw_patch_json          TEXT NOT NULL DEFAULT '{}',
  validation_result_json  TEXT NOT NULL DEFAULT '{}',
  created_at              INTEGER NOT NULL,
  committed_at            INTEGER
, extractor_kind TEXT, extractor_model TEXT, extractor_confidence REAL, extractor_diagnostics_json TEXT NOT NULL DEFAULT '[]');

CREATE INDEX idx_memory_patches_conv_created
  ON memory_patches(conversation_id, created_at DESC);

CREATE TABLE memory_validation_issues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  patch_id        INTEGER REFERENCES memory_patches(id) ON DELETE CASCADE,
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
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
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

CREATE TABLE memory_patch_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  patch_id        INTEGER NOT NULL REFERENCES memory_patches(id) ON DELETE CASCADE,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  item_type       TEXT NOT NULL,
  item_id         INTEGER NOT NULL,
  action          TEXT NOT NULL,
  created_at      INTEGER NOT NULL
, review_status TEXT NOT NULL DEFAULT 'applied', reviewed_at INTEGER);

CREATE INDEX idx_memory_patch_items_patch
  ON memory_patch_items(patch_id);

CREATE INDEX idx_memory_patch_items_conv_item
  ON memory_patch_items(conversation_id, item_type, item_id);

CREATE TABLE global_memories (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                   TEXT NOT NULL,
  memory_key             TEXT NOT NULL,
  value_json             TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active',
  source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id      INTEGER REFERENCES messages(id) ON DELETE SET NULL,
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

CREATE TABLE memory_embeddings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  item_type       TEXT NOT NULL,
  item_id         INTEGER NOT NULL,
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

CREATE TABLE memory_custom_profiles (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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

CREATE TABLE memory_event_log (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  parent_id          TEXT,
  conversation_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_kind         TEXT NOT NULL,
  item_type          TEXT NOT NULL,
  item_id            INTEGER NOT NULL,
  source_message_id  INTEGER,
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
  conversation_id     INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  projection_event_id TEXT,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE memory_message_heads (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER NOT NULL,
  head_event_id   TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY(conversation_id, message_id)
);

CREATE INDEX idx_memory_message_heads_head
  ON memory_message_heads(head_event_id);

CREATE TABLE memory_refs (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ref_kind        TEXT NOT NULL,
  source_key      TEXT NOT NULL,
  target_event_id TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY(ref_kind, source_key)
);

CREATE INDEX idx_memory_refs_target ON memory_refs(target_event_id);

CREATE INDEX idx_memory_refs_conv ON memory_refs(conversation_id);

CREATE TABLE turn_inputs (
  message_id       INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id          TEXT,
  -- Exact string sent to the provider (prelude + body).
  full_input       TEXT NOT NULL,
  -- The body without the auto-injected portal prelude (memory / prior-message
  -- augmented prompt, or the raw user content when neither applies).
  prompt_body      TEXT NOT NULL,
  -- The portal prelude actually prepended (empty string when none, e.g. stub).
  prelude          TEXT NOT NULL DEFAULT '',
  model            TEXT,
  mode             TEXT,
  memory_mode      TEXT,
  -- JSON array of prior messages embedded for providers that can't resume a
  -- session, or NULL when none were embedded.
  initial_messages TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX idx_turn_inputs_conversation ON turn_inputs(conversation_id);

CREATE INDEX idx_memory_facts_conv_salience
  ON memory_facts(conversation_id, status, pinned DESC, updated_at DESC);

CREATE INDEX idx_prompt_templates_user_type_status
  ON prompt_templates(user_id, type, status, pinned DESC, order_index ASC, updated_at DESC);

CREATE TABLE "background_agent_lifecycles" (
  tool_call_id INTEGER PRIMARY KEY REFERENCES tool_calls(id) ON DELETE CASCADE,
  agent_id     TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER
);

CREATE INDEX idx_background_agent_lifecycles_agent
  ON background_agent_lifecycles(agent_id);

CREATE TABLE memory_extraction_locks (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  holder          TEXT NOT NULL,
  acquired_at     INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE TABLE ticket_deps (
  ticket_id  INTEGER NOT NULL REFERENCES workspace_tickets(id) ON DELETE CASCADE,
  depends_on INTEGER NOT NULL REFERENCES workspace_tickets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, depends_on),
  CHECK (ticket_id <> depends_on)
);

CREATE INDEX idx_ticket_deps_depends_on ON ticket_deps(depends_on);

CREATE TABLE tool_attachments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_call_id  INTEGER NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'image',
  mime_type     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  source_path   TEXT,
  data          BLOB NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_tool_attachments_tool_call ON tool_attachments(tool_call_id);

CREATE TABLE ticket_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id    INTEGER NOT NULL REFERENCES workspace_tickets(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  source_path  TEXT,
  data         BLOB NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_ticket_attachments_ticket ON ticket_attachments(ticket_id);

CREATE TABLE turn_idempotency (
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL,
  message_id       INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  turn_id          TEXT NOT NULL,
  title            TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, idempotency_key)
);

CREATE INDEX idx_turn_idempotency_message ON turn_idempotency(message_id);

CREATE INDEX idx_permission_grants_conversation
  ON permission_grants(conversation_id);

CREATE UNIQUE INDEX idx_memory_open_loops_conv_key
  ON memory_open_loops(conversation_id, loop_key)
  WHERE loop_key != '';

CREATE VIRTUAL TABLE messages_fts USING fts5(
  conversation_id UNINDEXED,
  message_id UNINDEXED,
  content,
  tokenize = 'trigram'
);

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(conversation_id, message_id, content)
    VALUES (new.conversation_id, new.id, new.content);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE message_id = old.id;
  INSERT INTO messages_fts(conversation_id, message_id, content)
    VALUES (new.conversation_id, new.id, new.content);
END;

CREATE TABLE managed_worktrees (
  conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  source_workdir   TEXT NOT NULL,
  path             TEXT NOT NULL UNIQUE,
  git_common_dir   TEXT NOT NULL,
  branch           TEXT NOT NULL,
  base_sha         TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  UNIQUE(git_common_dir, branch)
);

CREATE TABLE workspace_leases (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  held_by_conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  label                   TEXT NOT NULL DEFAULT '',
  source_workdir          TEXT NOT NULL,
  git_common_dir          TEXT NOT NULL,
  path                    TEXT NOT NULL UNIQUE,
  branch                  TEXT NOT NULL,
  base_sha                TEXT NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'active'
                            CHECK (state IN ('active', 'releasing')),
  created_at              INTEGER NOT NULL,
  last_used_at            INTEGER NOT NULL,
  UNIQUE(git_common_dir, branch)
);

CREATE INDEX idx_workspace_leases_holder
  ON workspace_leases(held_by_conversation_id);

CREATE INDEX idx_workspace_leases_user_state
  ON workspace_leases(user_id, state);

CREATE TABLE permission_shadow_decisions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tool             TEXT NOT NULL,
  permission_kind  TEXT NOT NULL,
  scope_key        TEXT,
  args_hash        TEXT,
  adversary_model  TEXT NOT NULL,
  -- Identity of the experiment this row belongs to: a hash over the system
  -- prompt, renderer version, truncation budget and model name. Measurements
  -- taken under different setups are different experiments; pooling them
  -- produces a meaningless average, so the readout stratifies on this rather
  -- than trusting anyone to have remembered to bump a version number.
  experiment_key   TEXT NOT NULL,
  -- Human-readable companion to experiment_key. Hand-maintained, so it is a
  -- label, not the thing analysis groups by.
  prompt_version   INTEGER NOT NULL DEFAULT 1,
  -- Stable hash of the exact fact set shown to the model. Also the memo key,
  -- so repeat askings of the same question can be clustered (they are not
  -- independent samples) without storing the facts twice.
  facts_key        TEXT,
  -- The exact user prompt that was sent, verbatim. This is what makes a
  -- disagreement adjudicable and a prompt change re-runnable against old
  -- cases; without it the row records a verdict on inputs nobody can
  -- reconstruct. It is the same bytes that went over the network — already
  -- truncated to ADVERSARY_SHADOW_MAX_ARG_CHARS — rather than the untruncated
  -- facts, so the copy at rest is never larger than what the operator already
  -- accepted sending to the provider.
  prompt_sent      TEXT,
  -- Why this request needed a decision:
  --   'prompt-grant'  — a stored grant demanded a prompt
  --   'prompt-policy' — no grant matched and policy said prompt
  --   'auto-approve'  — nobody was asked; the conversation is in auto-approve
  -- The first two are the labelled `ask` population. The third is the
  -- population an eventual veto product would gate: unlabelled by
  -- construction, excluded from scoring, and collected anyway because the
  -- request cannot be recovered after the fact.
  resolution_source TEXT,
  -- 'pending' until the adversary call settles; then 'verdict' or 'error'.
  -- A row stuck at 'pending' means the process died (or the call never
  -- returned) — visible, and excluded from scoring like any non-verdict row.
  status           TEXT NOT NULL,
  -- 'allow' | 'deny'. NULL unless status = 'verdict'.
  verdict          TEXT,
  -- Model's estimated probability that a careful operator would REJECT the
  -- request, or NULL when it gave none. Deliberately a deny probability rather
  -- than "confidence in the verdict", which flips meaning with the verdict and
  -- is incoherent below 0.5. Unused by Phase 0 scoring; captured so a later
  -- analysis can sweep a threshold and produce a precision/recall CURVE
  -- instead of the single arbitrary operating point a bare binary verdict pins
  -- you to. Adding it later would mean re-collecting every row.
  deny_probability REAL,
  rationale        TEXT,
  error            TEXT,
  latency_ms       INTEGER,
  -- 1 when this row reused a memoized verdict from an identical earlier
  -- request in the same session instead of paying for its own provider call.
  -- Memoized rows are perfectly correlated with their source row, so the
  -- headline metrics are computed over non-memoized rows only; an agent retry
  -- loop must not get to vote N times on whether this mode ships.
  memoized         INTEGER NOT NULL DEFAULT 0,
  -- The human's actual click, using the same vocabulary as
  -- `permission_decisions.decision`. NULL = no human label; see above.
  human_decision   TEXT,
  human_decided_at INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE INDEX idx_permission_shadow_decisions_conv
  ON permission_shadow_decisions(conversation_id, created_at DESC);

CREATE TABLE workspace_permission_state (
  user_id        INTEGER NOT NULL,
  workspace_root TEXT NOT NULL,
  snapshot_text  TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, workspace_root)
);
