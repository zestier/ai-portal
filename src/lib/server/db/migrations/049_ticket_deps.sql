-- 049_ticket_deps.sql
--
-- Dependency edges between workspace tickets: a row (ticket_id, depends_on)
-- means `ticket_id` is BLOCKED BY `depends_on` (the prerequisite must reach a
-- terminal status before the dependent is ready to start). Lets the agent model
-- ordering — "what can I work on now" is the set of open tickets with no open
-- blocker. Both endpoints cascade-delete with their ticket so edges never
-- dangle. Same-user / same-workspace scoping and cycle prevention are enforced
-- in the repository layer (they can't be expressed as table constraints here).

CREATE TABLE ticket_deps (
  ticket_id  TEXT NOT NULL REFERENCES workspace_tickets(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES workspace_tickets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, depends_on),
  CHECK (ticket_id <> depends_on)
);

-- Reverse lookups ("what depends on X") for the dependents query.
CREATE INDEX idx_ticket_deps_depends_on ON ticket_deps(depends_on);
