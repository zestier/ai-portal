-- Stable, human-legible open-loop handle.
--
-- `loop_key` is a slug derived from the loop's title at creation (e.g.
-- `loop.find_attic_key`), unique within a conversation. It is the handle the
-- post-turn extractor sees and uses to keep/close loops, replacing the opaque
-- ULID primary key in the model-facing packet. The key is generated once at
-- creation and persisted in the `open_loop.create` event payload, so projection
-- replay restores it verbatim (it is never regenerated) and fork/rewind stay
-- faithful. Existing rows keep the empty default and fall back to rendering
-- their ULID; resolution accepts either a key or an id.
ALTER TABLE memory_open_loops ADD COLUMN loop_key TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_memory_open_loops_conv_key ON memory_open_loops(conversation_id, loop_key);
