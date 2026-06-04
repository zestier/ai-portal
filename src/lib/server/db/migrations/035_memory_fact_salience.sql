-- Salience support for memory facts.
--
-- `pinned` marks facts that must always survive injection ranking. Supersession
-- and dedupe are NOT stored here: they are derived from the event stream when
-- the projection is (re)built (see consolidateFactGroup), so a rebuild from the
-- surviving observations always yields the correct active set — which is what
-- makes revert "just work" without any reference counting.
ALTER TABLE memory_facts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_memory_facts_conv_salience
  ON memory_facts(conversation_id, status, pinned DESC, updated_at DESC);
