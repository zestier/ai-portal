-- Per-turn record of the *full input* handed to the provider for a turn.
-- Keyed by the user message that triggered the turn (1:1). Lets the UI show
-- "the guts" of a turn: the portal prelude, any memory / prior-message context
-- injected by the portal, and the raw user content — exactly as the SDK saw it.
--
-- This is purely an observability artifact; nothing reads it back into a turn.
-- Inline-edit re-runs reuse the same user message id, so the row is upserted to
-- reflect the latest turn for that message.
CREATE TABLE turn_inputs (
  message_id       TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  turn_id          TEXT,
  -- Exact string sent to the provider (prelude + body).
  full_input       TEXT NOT NULL,
  -- The body without the auto-injected portal prelude (memory / prior-message
  -- augmented prompt, or the raw user content when neither applies).
  prompt_body      TEXT NOT NULL,
  -- The portal prelude actually prepended (empty string when none, e.g. stub).
  prelude          TEXT NOT NULL DEFAULT '',
  provider         TEXT,
  model            TEXT,
  mode             TEXT,
  memory_mode      TEXT,
  -- JSON array of prior messages embedded for providers that can't resume a
  -- session, or NULL when none were embedded.
  initial_messages TEXT,
  created_at       INTEGER NOT NULL
);

CREATE INDEX idx_turn_inputs_conversation ON turn_inputs(conversation_id);
