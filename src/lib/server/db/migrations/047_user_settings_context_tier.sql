-- 047_user_settings_context_tier.sql
--
-- Per-user context window tier for Copilot sessions. `long_context` requests
-- the large (e.g. 1M-token) window; `default` is the standard (~200k) window.
-- Nullable: NULL means "use the server default" (env `COPILOT_CONTEXT_TIER`),
-- so behaviour is unchanged for every existing user whose column is NULL.
-- Unlike the seed-only defaults (default_model, default_mode, …), this is read
-- live at session open/resume rather than copied onto the conversation row.

ALTER TABLE user_settings ADD COLUMN default_context_tier TEXT;
