-- 057_memory_open_loop_key_unique.sql
--
-- Correctness fix: memory_open_loops.loop_key (migration 039) is the stable,
-- human-legible handle the post-turn extractor uses to keep/close loops, and
-- resolveOpenLoopId resolves a model-supplied key to exactly one loop. It must
-- therefore be unique within a conversation, but 039 only added a plain index.
-- allocateLoopKey (repos/memory.ts) reads-then-inserts, so two concurrent
-- addOpenLoop calls for the same title (separate connections, each from the
-- same pre-commit snapshot) could both observe the key as free and both INSERT
-- it, after which key-based addressing silently targets whichever row sorts
-- first.
--
-- Enforce uniqueness in the schema with a PARTIAL unique index. Legacy rows
-- created before 039 carry the empty-string default loop_key and intentionally
-- share it (they fall back to rendering their ULID), so the index must exclude
-- loop_key = '' or it would reject every DB with more than one pre-039 loop in
-- a conversation. resolveOpenLoopId never resolves the empty key, so excluding
-- it costs nothing.
--
-- First repair any non-empty duplicates that the pre-fix race already wrote, or
-- the unique index could not be created. Keep the earliest row in each
-- (conversation_id, loop_key) group (smallest rowid) and disambiguate the rest
-- by suffixing the row's own ULID primary key (`id`). Using `id` (not rowid) is
-- deliberate: allocateLoopKey only ever emits lowercased `loop.<slug>` /
-- `loop.<slug>_<n>` keys, whereas a ULID is uppercase Crockford base32, so a
-- rewritten key can never equal a legitimately allocated one — a plain `_<rowid>`
-- suffix could (e.g. rewriting `loop.x` -> `loop.x_2` would clash with an
-- already-allocated `loop.x_2`). `id` is unique per row, so the rewrites are
-- also unique among themselves. Only already-corrupted rows are touched.
UPDATE memory_open_loops
   SET loop_key = loop_key || '_' || id
 WHERE loop_key != ''
   AND rowid NOT IN (
     SELECT MIN(rowid)
       FROM memory_open_loops
      WHERE loop_key != ''
      GROUP BY conversation_id, loop_key
   );

-- The plain index from 039 is now redundant with the unique index for the
-- (conversation_id, loop_key) lookups allocateLoopKey/resolveOpenLoopId issue,
-- and the conversation-prefix / FK-cascade scans are already served by
-- idx_memory_open_loops_conv_status (migration 025).
DROP INDEX IF EXISTS idx_memory_open_loops_conv_key;

CREATE UNIQUE INDEX idx_memory_open_loops_conv_key
  ON memory_open_loops(conversation_id, loop_key)
  WHERE loop_key != '';
