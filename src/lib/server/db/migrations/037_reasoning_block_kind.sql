-- 037_reasoning_block_kind.sql
-- Distinguish a sub-agent's spoken output from its "thinking" within the
-- reasoning_blocks table. 'reasoning' (the default) renders as a Thinking
-- segment; 'content' is a sub-agent's response prose, threaded into its
-- SubagentCall card so a nested agent renders its content interleaved with its
-- tools and reasoning, like a top-level agent.
--
-- Only sub-agent content uses kind = 'content' (always with a non-null
-- parent_tool_call_id); top-level content stays in the assistant message body.

ALTER TABLE reasoning_blocks ADD COLUMN kind TEXT NOT NULL DEFAULT 'reasoning';
