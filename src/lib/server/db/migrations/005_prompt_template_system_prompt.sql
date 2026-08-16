-- 005_prompt_template_system_prompt.sql
-- Per-template system-prompt overrides (ticket #41). Both template types
-- (chat + ticket-action) carry two optional Markdown fields mirroring the pi
-- SDK ResourceLoader options 1:1: `system_prompt` REPLACES the default
-- "You are an expert coding assistant..." system block, `append_system_prompt`
-- is APPENDED under whatever system prompt is active. NULL = unset (today's
-- behavior). Launch copies them onto the conversation row so the session's
-- resource loader applies them when the first turn builds the pi session.
ALTER TABLE prompt_templates ADD COLUMN system_prompt TEXT;
ALTER TABLE prompt_templates ADD COLUMN append_system_prompt TEXT;
ALTER TABLE conversations ADD COLUMN system_prompt TEXT;
ALTER TABLE conversations ADD COLUMN append_system_prompt TEXT;
