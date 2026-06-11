-- Persisted composer draft for a conversation. Currently set when an
-- edit-fork is created while the source conversation has a running turn:
-- the fork's turn is NOT auto-started, so the edited prompt is stashed here
-- and seeded into the composer on load (survives reloads/navigation) until
-- the user sends it. NULL for conversations with no pending draft.
ALTER TABLE conversations
  ADD COLUMN draft_prompt TEXT;
