-- 065_prompt_template_workspace_mode.sql
--
-- Prompt templates (chat *and* ticket-action) can pin the Git workspace style of
-- the conversation they launch:
--   'shared'   launch into the shared checkout (today's behavior),
--   'worktree' create a fresh managed Git worktree for the chat.
--
-- Choosing per launch is not a value here: that is `launch_behavior = 'review'`,
-- which opens a pre-launch dialog where the workspace (and the other options)
-- can be changed before sending.
--
-- NULL means "no preference" and behaves like 'shared', so this migration is a
-- no-op for existing templates.

ALTER TABLE prompt_templates
  ADD COLUMN workspace_mode TEXT;
