-- Canonicalize Agent SDK subagent spawn tool name to `task`, matching the
-- Copilot backend, so existing rows render as subagent cards on reload.
UPDATE tool_calls SET tool = 'task' WHERE tool IN ('Agent', 'Task');
