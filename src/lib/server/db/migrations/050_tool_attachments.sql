-- 050_tool_attachments.sql
--
-- Side-store for binary artifacts captured for a tool call — currently images
-- the agent read via the native `view` tool. The native SDK `view` completion
-- carries no image bytes, so the portal captures them itself at permission
-- (read) time, buffers them in memory, and flushes a row here once the owning
-- `tool_calls` row exists (created on `tool.execution_start`). Storing the bytes
-- here rather than on `tool_calls.result_json` keeps the hot message/tool-call
-- read paths and the SSE replay log free of base64 bloat, and lets the image
-- survive the source file being deleted or moved.
--
-- The FK cascades from `tool_calls`, which itself cascades from `messages` →
-- `conversations`, so deleting a conversation (or truncating a message) removes
-- the attachment bytes with no orphans. `PRAGMA foreign_keys = ON` is set
-- globally in db/index.ts.

CREATE TABLE tool_attachments (
  id            TEXT PRIMARY KEY,
  tool_call_id  TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'image',
  mime_type     TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  source_path   TEXT,
  data          BLOB NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_tool_attachments_tool_call ON tool_attachments(tool_call_id);
