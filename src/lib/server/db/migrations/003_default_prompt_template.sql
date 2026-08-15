-- 003_default_prompt_template.sql
-- Per-user default chat prompt-template id (ticket #30). When set, the New
-- chat buttons launch the referenced template via the full prompt-template
-- machinery instead of a blank chat. NULL (the default) keeps the blank-chat
-- behavior. Built-in templates use their handle ids (`-1`..`-4`); custom
-- templates store the `PT<number>` handle. Stale / archived / other-user ids
-- resolve to nothing and fall back to a blank chat.
ALTER TABLE user_settings ADD COLUMN default_prompt_template_id TEXT;
