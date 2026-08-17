import type {
  LaunchWorkspaceKind,
  PromptTemplateListItem,
  PromptTemplateSource,
  TemplateLaunchOptions,
} from "$lib/prompt-templates";
import type { PromptLaunchBehavior } from "$lib/types";

type TemplateFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Conversation-create `workspace` payload for a resolved launch workspace.
 * `shared` is the API default, so it stays absent to keep the request minimal
 * (and to leave the user's default workdir precedence untouched).
 */
export function workspacePayload(
  workspace?: LaunchWorkspaceKind | null,
): { workspace: { kind: "worktree" } } | Record<string, never> {
  return workspace === "worktree" ? { workspace: { kind: "worktree" } } : {};
}

/**
 * POST `/api/conversations` to create an empty conversation with the given
 * title. Returns the new conversation id, or a `{ ok: false }` carrying the
 * HTTP status so callers can surface a consistent failure. Shared by the draft
 * and refine launchers so the create + error handling stays in one place.
 */
async function createConversation(
  title: string,
  fetcher: TemplateFetch,
  signal?: AbortSignal,
  promptTemplateId?: string,
  options?: Pick<
    TemplateLaunchOptions,
    | "workspace"
    | "conversationMode"
    | "approvalMode"
    | "model"
    | "disabledToolGroups"
  >,
): Promise<{ ok: true; id: string } | { ok: false; status?: number }> {
  const convRes = await fetcher("/api/conversations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      ...(promptTemplateId !== undefined ? { promptTemplateId } : {}),
      // Always send the resolved groups — an explicit `[]` clears a
      // template preset server-side instead of re-seeding it (D6).
      disabledToolGroups: options?.disabledToolGroups ?? [],
      ...workspacePayload(options?.workspace),
      ...(options?.conversationMode ? { mode: options.conversationMode } : {}),
      ...(options?.approvalMode ? { approvalMode: options.approvalMode } : {}),
      ...(options?.model ? { model: options.model } : {}),
    }),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!convRes.ok) return { ok: false, status: convRes.status };
  const body = await convRes.json();
  return { ok: true, id: body.conversation.id };
}

export function promptTemplateDraftUrl(
  conversationId: string,
  template: { id: string; source: PromptTemplateSource },
): string {
  const params = new URLSearchParams({
    promptTemplateSource: template.source,
    promptTemplateId: template.id,
  });
  return `/conversations/${conversationId}?${params.toString()}`;
}

export async function createPromptTemplateDraftChat({
  template,
  fetcher = fetch,
  signal,
  options,
}: {
  template: Pick<PromptTemplateListItem, "id" | "source" | "title">;
  fetcher?: TemplateFetch;
  signal?: AbortSignal;
  /** Resolved launch settings; omit to use the API/user defaults. */
  options?: TemplateLaunchOptions;
}): Promise<{ ok: true; href: string } | { ok: false; status?: number }> {
  const conv = await createConversation(
    template.title,
    fetcher,
    signal,
    template.id,
    options,
  );
  if (!conv.ok) return conv;
  return {
    ok: true,
    href: promptTemplateDraftUrl(conv.id, template),
  };
}

/**
 * Immediate-launch path for a chat template (`launchBehavior: 'send'`, and the
 * destination of a confirmed `review`): create the conversation with the
 * resolved settings, post the prompt as the first turn, and return the chat
 * href. A failed turn deletes the just-created conversation so a launch failure
 * never leaves an empty orphan chat behind — mirroring the ticket launcher.
 */
export async function createPromptTemplateLaunchChat({
  template,
  options,
  fetcher = fetch,
  signal,
}: {
  template: Pick<PromptTemplateListItem, "id" | "title">;
  options: TemplateLaunchOptions;
  fetcher?: TemplateFetch;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; href: string }
  | { ok: false; stage: "create" | "launch"; status?: number }
> {
  const conv = await createConversation(
    template.title,
    fetcher,
    signal,
    template.id,
    options,
  );
  if (!conv.ok)
    return {
      ok: false,
      stage: "create",
      ...(conv.status ? { status: conv.status } : {}),
    };
  const turnRes = await fetcher(`/api/conversations/${conv.id}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: options.prompt }),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!turnRes.ok) {
    await fetcher(`/api/conversations/${conv.id}`, { method: "DELETE" }).catch(
      () => undefined,
    );
    return { ok: false, stage: "launch", status: turnRes.status };
  }
  return { ok: true, href: `/conversations/${conv.id}` };
}

export function promptTemplateRefineUrl(
  conversationId: string,
  templateId: string,
): string {
  const params = new URLSearchParams({ refinePromptTemplateId: templateId });
  return `/conversations/${conversationId}?${params.toString()}`;
}

/**
 * "Refine this prompt" launch — a full prompt-template launch whose prompt is
 * the refine seed (R4). Respects the template's `launchBehavior` and stored
 * settings like any other launch:
 *   - `draft`: create the conversation (with the template's settings) and
 *     return the refine URL; the conversation load pre-fills the composer with
 *     the seed server-side (kept in `+page.server.ts`).
 *   - `send` (and any non-draft): create the conversation, then post the seed
 *     as the first turn. A failed turn deletes the conversation so a refine
 *     launch never leaves an orphan chat behind.
 * `review` is handled by the caller (it opens the review dialog and confirms
 * via this same function with `launchBehavior: 'send'`).
 */
export async function createPromptTemplateRefineChat({
  template,
  options,
  launchBehavior,
  fetcher = fetch,
  signal,
}: {
  template: Pick<PromptTemplateListItem, "id" | "title">;
  /** Resolved launch settings — the refine seed is `options.prompt`. */
  options: TemplateLaunchOptions;
  launchBehavior: PromptLaunchBehavior;
  fetcher?: TemplateFetch;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; href: string }
  | { ok: false; stage: "create" | "launch"; status?: number }
> {
  const conv = await createConversation(
    `Refine: ${template.title}`,
    fetcher,
    signal,
    template.id,
    options,
  );
  if (!conv.ok)
    return {
      ok: false,
      stage: "create",
      ...(conv.status ? { status: conv.status } : {}),
    };
  if (launchBehavior === "draft") {
    return { ok: true, href: promptTemplateRefineUrl(conv.id, template.id) };
  }
  const turnRes = await fetcher(`/api/conversations/${conv.id}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: options.prompt }),
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!turnRes.ok) {
    await fetcher(`/api/conversations/${conv.id}`, { method: "DELETE" }).catch(
      () => undefined,
    );
    return { ok: false, stage: "launch", status: turnRes.status };
  }
  return { ok: true, href: `/conversations/${conv.id}` };
}
