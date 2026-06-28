-- Optional model override applied at conversation creation for ticket-action
-- prompt templates. NULL means "use the user's default model" (the existing
-- behavior). Existing rows default to NULL.
ALTER TABLE prompt_templates
  ADD COLUMN model TEXT;
