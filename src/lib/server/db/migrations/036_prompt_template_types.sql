-- Typed prompt templates. `type` distinguishes plain chat templates (the
-- original launcher behavior, injected verbatim) from `ticket-action`
-- templates that render as workspace-ticket buttons and may inject
-- `{{ticket.*}}` placeholders. Existing rows default to `chat`.
ALTER TABLE prompt_templates
  ADD COLUMN type TEXT NOT NULL DEFAULT 'chat';

-- Ticket-action launch metadata. NULL for chat templates.
-- `launch_behavior`: 'send' posts a turn immediately, 'draft' pre-fills the composer.
ALTER TABLE prompt_templates
  ADD COLUMN launch_behavior TEXT;

-- Optional conversation-mode override applied at conversation creation.
ALTER TABLE prompt_templates
  ADD COLUMN conversation_mode TEXT;

CREATE INDEX idx_prompt_templates_user_type_status
  ON prompt_templates(user_id, type, status, pinned DESC, order_index ASC, updated_at DESC);
