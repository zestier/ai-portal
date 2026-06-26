-- 048_ticket_plan.sql
--
-- A durable, free-form `plan` for a workspace ticket: the place to stash a
-- worked-out implementation plan, design notes, or a checklist that should
-- outlive a session more reliably than a scratch markdown file. Kept separate
-- from `body` (the short description) because plans are long; the agent ticket
-- tools leave `plan` out of the compact view and fetch it on demand via the
-- `fields` selector. Defaults to '' so every existing ticket is unaffected.

ALTER TABLE workspace_tickets ADD COLUMN plan TEXT NOT NULL DEFAULT '';
