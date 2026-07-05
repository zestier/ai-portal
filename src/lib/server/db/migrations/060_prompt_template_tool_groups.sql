-- 060_prompt_template_tool_groups.sql
--
-- Chat prompt templates can seed a per-conversation tool-group preset. Stores
-- the set of portal-injected tool *groups* to disable on the conversation the
-- template launches, as a JSON array of group ids (e.g. '["git","tickets"]').
-- Recognized ids are defined by PORTAL_TOOL_GROUPS in src/lib/tools/groups.ts:
--   git, filesystem, tickets, permissions, memory, prompt-templates.
--
-- Only meaningful for `type = 'chat'` templates; ticket-action templates keep
-- it empty (the repo gates it by type, mirroring conversation_mode/model). The
-- default '[]' means "seed nothing" = launched conversations keep all groups
-- enabled, so this migration is a no-op for existing templates.

ALTER TABLE prompt_templates
  ADD COLUMN disabled_tool_groups TEXT NOT NULL DEFAULT '[]';
