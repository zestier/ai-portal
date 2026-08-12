-- 074_drop_provider_layer_again.sql
--
-- Migration 073 restores the legacy provider columns for main. The pi runtime
-- no longer uses that provider layer, so remove the restored columns again
-- while preserving the shared append-only migration history.

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