-- 059_conversation_tool_groups.sql
--
-- Per-conversation portal tool-group toggles. Stores the set of portal-injected
-- tool *groups* the user has disabled for this conversation as a JSON array of
-- group ids (e.g. '["git","tickets"]'). Recognized ids are defined by
-- PORTAL_TOOL_GROUPS in src/lib/tools/groups.ts:
--   git, filesystem, tickets, permissions, memory, prompt-templates.
--
-- The default '[]' means "no groups disabled" = all portal tools available,
-- which is exactly today's behaviour, so this migration is a no-op for existing
-- conversations. Providers read this on each open() and filter the assembled
-- portalTools accordingly; the /session PATCH endpoint treats a change as
-- recreate-required so the next turn reopens with the filtered set.

ALTER TABLE conversations
  ADD COLUMN disabled_tool_groups TEXT NOT NULL DEFAULT '[]';
