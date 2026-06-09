-- Open-loop liveness ("touch-to-keep").
--
-- `idle_turns` counts consecutive model-backed extraction passes in which the
-- loop was presented to the extractor but neither kept alive nor closed. It is
-- a derived projection column: it is reconstructed by replaying the
-- `open_loop.liveness` events in the memory event log (see
-- applyOpenLoopLivenessProjection), exactly like fact supersession. The
-- terminal auto-drop is likewise derived during replay, so fork/rewind
-- reconstruct idle counts and auto-drops faithfully rather than losing them.
ALTER TABLE memory_open_loops ADD COLUMN idle_turns INTEGER NOT NULL DEFAULT 0;
