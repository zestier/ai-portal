import * as messages from "$lib/server/db/repos/messages";

function recentTranscript(
  conversationId: number,
  userMessageId: string,
  limit: number,
): string {
  const transcript = messages.listByConversation(conversationId);
  const targetIdx = transcript.findIndex(
    (message) => message.id === userMessageId,
  );
  const prior = transcript
    .slice(Math.max(0, targetIdx - limit), targetIdx)
    .filter(
      (message) => message.status === "complete" && message.content.trim(),
    )
    .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
    .join("\n\n");
  return prior;
}

export { recentTranscript };
