-- 053_ticket_priority.sql
--
-- A first-class `priority` for a workspace ticket so humans and agents can
-- express and act on relative urgency. The scale is `P0`..`P3` where P0 is the
-- highest urgency and P3 the lowest; new tickets default to `P2` (normal).
--
-- The column is NOT NULL DEFAULT 'P2', so every existing row backfills to P2
-- automatically — no data-migration loop needed. The CHECK constraint pins the
-- allowed set in the database, mirroring the Zod/API validation so a bad value
-- fails fast at every layer.

ALTER TABLE workspace_tickets
  ADD COLUMN priority TEXT NOT NULL DEFAULT 'P2'
  CHECK (priority IN ('P0', 'P1', 'P2', 'P3'));
