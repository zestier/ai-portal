import type { PromptTemplateListItem, PromptTemplateSource } from '$lib/prompt-templates';

type TemplateFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * POST `/api/conversations` to create an empty conversation with the given
 * title. Returns the new conversation id, or a `{ ok: false }` carrying the
 * HTTP status so callers can surface a consistent failure. Shared by the draft
 * and refine launchers so the create + error handling stays in one place.
 */
async function createConversation(
	title: string,
	fetcher: TemplateFetch,
	signal?: AbortSignal
): Promise<{ ok: true; id: string } | { ok: false; status?: number }> {
	const convRes = await fetcher('/api/conversations', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title }),
		...(signal !== undefined ? { signal } : {})
	});
	if (!convRes.ok) return { ok: false, status: convRes.status };
	const body = await convRes.json();
	return { ok: true, id: body.conversation.id };
}

export function promptTemplateDraftUrl(
	conversationId: string,
	template: { id: string; source: PromptTemplateSource }
): string {
	const params = new URLSearchParams({
		promptTemplateSource: template.source,
		promptTemplateId: template.id
	});
	return `/conversations/${encodeURIComponent(conversationId)}?${params.toString()}`;
}

export async function createPromptTemplateDraftChat({
	template,
	fetcher = fetch,
	signal
}: {
	template: Pick<PromptTemplateListItem, 'id' | 'source' | 'title'>;
	fetcher?: TemplateFetch;
	signal?: AbortSignal;
}): Promise<{ ok: true; href: string } | { ok: false; status?: number }> {
	const conv = await createConversation(template.title, fetcher, signal);
	if (!conv.ok) return conv;
	return {
		ok: true,
		href: promptTemplateDraftUrl(conv.id, template)
	};
}

export function promptTemplateRefineUrl(conversationId: string, templateId: string): string {
	const params = new URLSearchParams({ refinePromptTemplateId: templateId });
	return `/conversations/${encodeURIComponent(conversationId)}?${params.toString()}`;
}

export async function createPromptTemplateRefineChat({
	template,
	fetcher = fetch,
	signal
}: {
	template: Pick<PromptTemplateListItem, 'id' | 'title'>;
	fetcher?: TemplateFetch;
	signal?: AbortSignal;
}): Promise<{ ok: true; href: string } | { ok: false; status?: number }> {
	const conv = await createConversation(`Refine: ${template.title}`, fetcher, signal);
	if (!conv.ok) return conv;
	return {
		ok: true,
		href: promptTemplateRefineUrl(conv.id, template.id)
	};
}
