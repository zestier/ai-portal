import type { PromptTemplateListItem, PromptTemplateSource } from '$lib/prompt-templates';

type TemplateFetch = (url: string, init: RequestInit) => Promise<Response>;

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
	const convRes = await fetcher('/api/conversations', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ title: template.title }),
		...(signal !== undefined ? { signal } : {})
	});
	if (!convRes.ok) return { ok: false, status: convRes.status };
	const body = await convRes.json();
	return {
		ok: true,
		href: promptTemplateDraftUrl(body.conversation.id, template)
	};
}
