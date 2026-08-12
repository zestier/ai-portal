-- 066_approval_mode.sql
--
-- Split the approval axis out of the conversation-mode axis.
--
-- Before this migration the portal had two overlapping controls:
--   * `conversations.approve_all_tools` — a boolean that auto-approved every
--     prompt-worthy permission request, and
--   * `conversations.mode = 'best-effort'` — a portal-only "mode" whose entire
--     behavioural surface was auto-*rejecting* those same requests. It was
--     forwarded to the runtime as `autopilot`, so on the runtime axis it always
--     already was autopilot.
--
-- They were mutually exclusive in practice (approve-all silently won by
-- evaluation order) but nothing in the schema said so. Both now collapse into
-- one 3-way `approval_mode` column: 'ask' | 'auto-approve' | 'auto-deny'.
--
-- Backfill rules (order matters — approve-all kept its accidental precedence,
-- so it also wins here, and the result is now explicit rather than emergent):
--   approve_all_tools = 1   -> 'auto-approve'
--   mode = 'best-effort'    -> 'auto-deny'  (and mode rewritten to 'autopilot')
--   otherwise               -> 'ask'
--
-- The same split applies to the two places a mode is *seeded* from:
-- `user_settings.default_mode` and `prompt_templates.conversation_mode`, so a
-- stored "launch my favourite setup" preset keeps behaving identically.

ALTER TABLE conversations
  ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'ask';

UPDATE conversations
   SET approval_mode = CASE
         WHEN approve_all_tools = 1 THEN 'auto-approve'
         WHEN mode = 'best-effort' THEN 'auto-deny'
         ELSE 'ask'
       END;

UPDATE conversations
   SET mode = 'autopilot'
 WHERE mode = 'best-effort';

-- `approve_all_tools` is fully represented by `approval_mode` now; leaving it
-- behind would give the same setting two writable homes that can disagree.
ALTER TABLE conversations
  DROP COLUMN approve_all_tools;

ALTER TABLE user_settings
  ADD COLUMN default_approval_mode TEXT NOT NULL DEFAULT 'ask';

UPDATE user_settings
   SET default_approval_mode = 'auto-deny',
       default_mode = 'autopilot'
 WHERE default_mode = 'best-effort';

-- NULL = "no override; use the user's default", matching `conversation_mode`.
ALTER TABLE prompt_templates
  ADD COLUMN approval_mode TEXT;

UPDATE prompt_templates
   SET approval_mode = 'auto-deny',
       conversation_mode = 'autopilot'
 WHERE conversation_mode = 'best-effort';
