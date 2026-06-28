-- 052_ticket_attachments.sql
--
-- Stores binary file attachments (screenshots, logs, etc.) against workspace
-- tickets. Blobs are stored in-DB mirroring the tool_attachments precedent.
-- Cascade-deletes with the parent ticket via FK ON DELETE CASCADE.

CREATE TABLE ticket_attachments (
  id           TEXT PRIMARY KEY,
  ticket_id    TEXT NOT NULL REFERENCES workspace_tickets(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  source_path  TEXT,
  data         BLOB NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_ticket_attachments_ticket ON ticket_attachments(ticket_id);
