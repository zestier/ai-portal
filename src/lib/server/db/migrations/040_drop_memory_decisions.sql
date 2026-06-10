-- Retire the legacy memory `decision` primitive.
--
-- The `decision` write kind was removed long ago; no extractor or heuristic
-- emits decisions and the code that read/replayed historical rows is now gone.
-- Settled choices live on as facts/attributes (`predicate: "decision"`) or
-- directives, so the dedicated table is dead weight. Drop it and its index.
--
-- Raw event-log / patch_item history is intentionally left intact: legacy
-- `decision` log rows simply stop projecting (the replay switch no-ops unknown
-- item types). There is no data migration — existing decision rows are dropped.
DROP INDEX IF EXISTS idx_memory_decisions_conv_status;
DROP TABLE IF EXISTS memory_decisions;

-- Drop orphaned full-text rows: `memory_search` returns text straight from the
-- index without re-fetching the source row, so stale `decision` entries would
-- otherwise keep surfacing as un-actionable hits on pre-existing conversations.
DELETE FROM memory_search_index WHERE item_type = 'decision';
