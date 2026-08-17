import type { Message, ToolCallRecord } from "$lib/types";

/**
 * Find a tool-call record by id, scanning newest message first. Used by the chat
 * stream handler to attach incoming `tool.result` / progress / lifecycle events
 * to the record they update.
 */
export function findToolCallRecord(
  messages: Pick<Message, "toolCalls">[],
  toolCallId: string,
): ToolCallRecord | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const toolCall = messages[i].toolCalls?.find((t) => t.id === toolCallId);
    if (toolCall) return toolCall;
  }
}
