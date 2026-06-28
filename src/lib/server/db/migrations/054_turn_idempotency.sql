-- 054_turn_idempotency.sql
--
-- Idempotency for `POST /api/conversations/[id]/turns`. The route appends a
-- user message and starts a turn; if the request times out client-side (e.g. a
-- slow cold-start `pool.acquire`) and the client retries, the original message
-- and turn may already exist, but the retry previously had no way to learn the
-- original `turnId` — and could append a second orphaned user message.
--
-- A client-supplied key (the `Idempotency-Key` header, or `requestId` in the
-- body) is recorded here once a turn is successfully started, keyed uniquely per
-- conversation. A retry that presents the same key gets the original
-- `{ turnId, userMessageId, title }` back instead of creating a duplicate.
--
-- The row is removed automatically when its message (and therefore its
-- conversation) is deleted, so this never outlives the turn it points at.
CREATE TABLE turn_idempotency (
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  idempotency_key  TEXT NOT NULL,
  message_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  turn_id          TEXT NOT NULL,
  title            TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, idempotency_key)
);

CREATE INDEX idx_turn_idempotency_message ON turn_idempotency(message_id);
