-- 073_restore_provider_layer.sql
--
-- Restore the provider-layer columns dropped by migration 072. This repairs
-- databases briefly opened by the pi branch while preserving a linear schema
-- history for fresh databases. Values removed by 072 cannot be recovered, so
-- use the original defaults and backfill provider session ids from conversation
-- ids, matching migrations 019 and 021.

ALTER TABLE conversations
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'copilot';
ALTER TABLE conversations ADD COLUMN provider_session_id TEXT;
ALTER TABLE conversations ADD COLUMN memory_extractor_backend TEXT;
ALTER TABLE conversations ADD COLUMN adversary_backend TEXT;

UPDATE conversations
   SET provider_session_id = id
 WHERE provider_session_id IS NULL;

ALTER TABLE user_settings
  ADD COLUMN default_provider TEXT NOT NULL DEFAULT 'copilot';
ALTER TABLE user_settings ADD COLUMN default_memory_extractor_model TEXT;
ALTER TABLE user_settings ADD COLUMN default_memory_extractor_backend TEXT;
ALTER TABLE user_settings ADD COLUMN default_adversary_model TEXT;
ALTER TABLE user_settings ADD COLUMN default_adversary_backend TEXT;
ALTER TABLE user_settings ADD COLUMN default_context_tier TEXT;

ALTER TABLE turn_inputs ADD COLUMN provider TEXT;

ALTER TABLE permission_shadow_decisions ADD COLUMN adversary_backend TEXT;