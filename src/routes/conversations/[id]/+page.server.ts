import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import * as tickets from '$lib/server/db/repos/tickets';
import * as usage from '$lib/server/db/repos/usage';
import * as memory from '$lib/server/db/repos/memory';
import { getBuiltInPromptTemplate, buildRefinePromptSeed } from '$lib/prompt-templates';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { listForConversation as listPendingInteractive } from '$lib/server/runtime/interactive-requests';
import { fetchModels, getProvider } from '$lib/server/providers';
import { providerAuthToken } from '$lib/server/providers/auth';
import { loadConfig } from '$lib/server/config';
import { log } from '$lib/server/log';
import { ticketWorkspaceFromConversation } from '$lib/server/ticket-workspace';
import { interpolateTicketPrompt } from '$lib/tickets/chat';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!locals.userId) throw error(401);
	const conv = convs.get(params.id, locals.userId);
	if (!conv) throw error(404);
	const msgs = messages.listByConversation(conv.id);
	// Opening a conversation counts as seeing it: clears the sidebar's unseen
	// indicator. Output that streams in *after* this load is covered by the
	// client's post-turn POST to `/read`.
	convs.markRead(conv.id, locals.userId);
	const contextUsage = usage.get(conv.id);
	const memorySnapshot = memory.listSnapshot(conv.id, { userId: conv.userId });
	let initialComposer = '';
	const draftTicketId = url.searchParams.get('draftTicketId');
	if (draftTicketId && msgs.length === 0) {
		const ticket = tickets.get(draftTicketId, locals.userId);
		if (!ticket || ticket.workspaceKey !== ticketWorkspaceFromConversation(conv)) {
			throw error(404);
		}
		const actionId = url.searchParams.get('ticketActionId');
		const action = actionId ? promptTemplates.get(actionId, locals.userId) : null;
		if (!action || action.type !== 'ticket-action' || action.status !== 'open') {
			throw error(404);
		}
		initialComposer = interpolateTicketPrompt(action, ticket);
	}
	const promptTemplateId = url.searchParams.get('promptTemplateId');
	if (!initialComposer && promptTemplateId && msgs.length === 0) {
		const source = url.searchParams.get('promptTemplateSource');
		const template =
			source === 'builtin'
				? getBuiltInPromptTemplate(promptTemplateId)
				: source === 'custom'
					? promptTemplates.get(promptTemplateId, locals.userId)
					: null;
		if (!template || template.status !== 'open') throw error(404);
		initialComposer = template.prompt;
	}
	const refinePromptTemplateId = url.searchParams.get('refinePromptTemplateId');
	if (!initialComposer && refinePromptTemplateId && msgs.length === 0) {
		const template = promptTemplates.get(refinePromptTemplateId, locals.userId);
		if (!template || template.status !== 'open') throw error(404);
		initialComposer = buildRefinePromptSeed(template);
	}
	// A fork created while its source was busy stashes the edited prompt as a
	// persisted draft (no turn auto-started). Seed it into the composer until
	// the user sends it; survives reloads since it lives on the conversation row.
	// We can't gate on `msgs.length === 0` here — a deferred edit-fork clones the
	// prefix before the edited message, so the fork usually already has messages.
	// The draft is cleared when the first turn starts, so a non-null value always
	// means "not yet sent".
	if (!initialComposer && conv.draftPrompt) {
		initialComposer = conv.draftPrompt;
	}

	// Surface any in-flight turn so the client can reattach its
	// EventSource on page load. Only running turns count — finished but
	// still-cached turns would just replay then immediately yield `done`.
	const turn = getTurn(conv.id);
	const activeTurnId = turn && turn.status === 'running' ? turn.id : null;

	// Snapshot any prompts currently waiting on a user response so a fresh
	// page load shows them immediately, without waiting for the SSE stream
	// to (re-)emit the `interactive.request` event.
	const pendingInteractive = listPendingInteractive(conv.id);
	const provider = getProvider(conv.provider);
	const cfg = loadConfig();
	let providerModels: { id: string; name: string; maxContextWindowTokens?: number }[] = [];
	let providerModelsError: string | null = null;
	try {
		const models = await fetchModels(
			conv.userId,
			providerAuthToken(conv.provider, conv.userId),
			conv.provider
		);
		providerModels = models.map((m) => ({
			id: m.id,
			name: m.name,
			...(m.capabilities?.limits?.max_context_window_tokens !== undefined
				? { maxContextWindowTokens: m.capabilities.limits.max_context_window_tokens }
				: {})
		}));
	} catch (e) {
		providerModelsError = String(e);
		log.warn('conversation.models.failed', {
			conversationId: conv.id,
			provider: conv.provider,
			err: providerModelsError
		});
	}

	// If this conversation was forked, surface parent info for a
	// breadcrumb. Resolves silently to null if the parent was deleted or
	// belongs to a different user.
	let parent: {
		id: string;
		title: string;
		messageId: string | null;
		messageIndex: number | null;
	} | null = null;
	if (conv.forkedFromConversationId) {
		const p = convs.get(conv.forkedFromConversationId, locals.userId);
		if (p) {
			let idx: number | null = null;
			if (conv.forkedFromMessageId) {
				const parentMsgs = messages.listByConversation(p.id);
				const i = parentMsgs.findIndex((m) => m.id === conv.forkedFromMessageId);
				idx = i >= 0 ? i : null;
			}
			parent = {
				id: p.id,
				title: p.title,
				messageId: conv.forkedFromMessageId,
				messageIndex: idx
			};
		}
	}

	return {
		conversation: conv,
		providerCapabilities: provider.capabilities,
		providerDisplayName: provider.displayName,
		providerModels,
		providerModelsError,
		defaultModelPlaceholder: provider.ui.defaultModelPlaceholder,
		effectiveModel: conv.model ?? cfg.DEFAULT_MODEL,
		chatPlaceholder: provider.ui.chatPlaceholder,
		messages: msgs,
		contextUsage,
		memorySnapshot,
		parent,
		activeTurnId,
		pendingInteractive,
		initialComposer
	};
};
