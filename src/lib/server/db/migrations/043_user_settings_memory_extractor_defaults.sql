-- 043_user_settings_memory_extractor_defaults.sql
--
-- User-level seed-only defaults for the memory extractor, copied onto each
-- newly created conversation (like default_model / default_provider /
-- default_mode). Both nullable: NULL means "use the server default" (env), so
-- behaviour is unchanged for users who never set these.

ALTER TABLE user_settings ADD COLUMN default_memory_extractor_model TEXT;
ALTER TABLE user_settings ADD COLUMN default_memory_extractor_backend TEXT;
