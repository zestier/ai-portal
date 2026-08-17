import { expect, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

interface TranscriptTailMessage {
  id: string;
  role: string;
  content: string;
}

interface ConversationPayload {
  activeTurnId: string | null;
  transcript: {
    tail: TranscriptTailMessage[];
    index: unknown[];
    hasMoreOlder: boolean;
  };
  pendingInteractive: unknown[];
  /**
   * Backward-compat alias for `transcript.tail`, so specs written against the
   * pre-projection `GET /api/conversations/[id]` shape (`messages`) keep
   * working. The backend-projected transcript's hydrated tail IS the full
   * message list for the small conversations e2e drives.
   */
  messages?: TranscriptTailMessage[];
}

export function uniqueTitle(prefix: string) {
  return `${prefix} ${randomUUID().slice(0, 8)}`;
}

export async function createConversation(
  request: APIRequestContext,
  title: string,
  options: {
    workdir?: string;
    approvalMode?: "ask" | "auto-approve" | "auto-deny";
  } = {},
) {
  const res = await request.post("/api/conversations", {
    data: { title, approvalMode: "ask", ...options },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.conversation.id as string;
}

export async function getConversation(
  request: APIRequestContext,
  conversationId: string,
) {
  const body = (await request
    .get(`/api/conversations/${conversationId}`)
    .then((r) => r.json())) as ConversationPayload;
  // `messages` is a compat alias for `transcript.tail` (see the type above).
  return { ...body, messages: body.transcript?.tail ?? [] };
}

/**
 * The rendered message list for a conversation payload: the backend-projected
 * transcript's hydrated tail. Conversations in e2e are small (well under the
 * tail size), so the tail is the complete list.
 */
export function messagesOf(body: ConversationPayload) {
  return body.transcript.tail as Array<{
    id?: string;
    role: string;
    content: string;
  }>;
}

export async function waitForAssistantMessage(
  request: APIRequestContext,
  conversationId: string,
  content: string | RegExp,
) {
  await expect
    .poll(async () => {
      const body = await getConversation(request, conversationId);
      return (
        body.activeTurnId === null &&
        body.transcript.tail.some((message) => {
          if (message.role !== "assistant") return false;
          return typeof content === "string"
            ? message.content === content
            : content.test(message.content);
        })
      );
    })
    .toBe(true);
  return getConversation(request, conversationId);
}

export async function waitForPendingInteractive(
  request: APIRequestContext,
  conversationId: string,
) {
  await expect
    .poll(async () => {
      const body = await getConversation(request, conversationId);
      return body.pendingInteractive.length;
    })
    .toBeGreaterThan(0);
  return getConversation(request, conversationId);
}
