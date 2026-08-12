-- 072_drop_provider_layer.sql
--
-- The pi branch removed the backend-provider layer and dropped its persisted
-- columns. Keep this migration on main so databases share one linear migration
-- history; migration 073 restores the columns still required by main.

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