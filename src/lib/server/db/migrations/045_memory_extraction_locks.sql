-- Per-conversation memory-extraction semaphore.
--
-- Two simultaneous extractions for the same conversation (rapid sends, or a
-- retry firing while the background extractor is still running) each snapshot
-- durable state via buildInitialPacket before either commits, then both
-- commitPatch. Facts dedupe via consolidation, but events and open loops are
-- append-only, so both patches wrote identical rows -> permanent duplicates.
--
-- This table is a lightweight advisory lock: a holder INSERTs its row to claim
-- the conversation for the snapshot->commit window and DELETEs it on release.
-- `expires_at` bounds a crashed/aborted holder so the lock can never deadlock a
-- conversation forever; an expired row is reaped on the next acquire attempt.
CREATE TABLE memory_extraction_locks (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  holder          TEXT NOT NULL,
  acquired_at     INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);
