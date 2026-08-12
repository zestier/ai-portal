-- 072_drop_provider_layer.sql
--
-- The backend-provider layer (Copilot SDK, claude-agent, LM Studio,
-- openai-compatible chat providers) is deleted in T2; the portal's sessions
-- are pi SDK sessions. This migration drops the columns that existed only to
-- persist provider identity and provider-layer settings.
--
-- What stays:
--   conversations.adversary_model / memory_extractor_model — per-conversation
--   overrides still used by the (portal-domain) adversary shadow and memory
--   extractor, re-wired onto pi-ai in T5.
--
-- There is no data migration: the provider ids stored here name deleted
-- runtimes, so carrying them forward would be misleading. Resolving code reads
-- the columns no longer, so dropping is safe once the app upgrade lands.

ALTER TABLE conversations DROP COLUMN provider;
ALTER TABLE conversations DROP COLUMN provider_session_id;
ALTER TABLE conversations DROP COLUMN memory_extractor_backend;
ALTER TABLE conversations DROP COLUMN adversary_backend;

ALTER TABLE user_settings DROP COLUMN default_provider;
ALTER TABLE user_settings DROP COLUMN default_memory_extractor_model;
ALTER TABLE user_settings DROP COLUMN default_memory_extractor_backend;
ALTER TABLE user_settings DROP COLUMN default_adversary_model;
ALTER TABLE user_settings DROP COLUMN default_adversary_backend;
ALTER TABLE user_settings DROP COLUMN default_context_tier;

ALTER TABLE turn_inputs DROP COLUMN provider;

ALTER TABLE permission_shadow_decisions DROP COLUMN adversary_backend;
