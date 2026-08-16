import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { conversationId as convCodec, promptTemplateId, ticketId } from '$lib/ids';
import * as convs from '$lib/server/db/repos/conversations';
import * as messages from '$lib/server/db/repos/messages';
import { projectTranscript } from '$lib/server/present/transcript';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import * as tickets from '$lib/server/db/repos/tickets';
import * as usage from '$lib/server/db/repos/usage';
import * as memory from '$lib/server/db/repos/memory';
import { getBuiltInPromptTemplate, buildRefinePromptSeed } from '$lib/prompt-templates';
import { getTurn } from '$lib/server/runtime/turn-runner';
import { listForConversation as listPendingInteractive } from '$lib/server/runtime/interactive-requests';
import { loadConfig } from '$lib/server/config';
import { listEnabledModelOptions } from '$lib/server/models/catalog-service';
import { ticketWorkspaceFromConversation } from '$lib/server/ticket-workspace';
import { interpolateTicketPrompt } from '$lib/tickets/chat';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!locals.userId) throw error(401);
	const conversationId = convCodec.tryParse(params.id);
	if (conversationId === null) throw error(404);
	const conv = convs.get(conversationId, locals.userId);
	if (!conv) throw error(404);
	// Backend-projected transcript: a bounded hydrated tail (records trimmed to
	// tight markers) + an index of older messages as previews/descriptors. The
	// client hydrates older bodies on demand; nothing ships the whole thread.
	const transcript = projectTranscript(conversationId);
	const hasMessages = transcript.tail.length > 0;

	// Opening a conversation counts as seeing it: clears the sidebar's unseen
	// indicator. Output that streams in *after* this load is covered by the
	// client's post-turn POST to `/read`.
	convs.markRead(conversationId, locals.userId);
	const contextUsage = usage.get(conversationId);
	const memorySnapshot = memory.listSnapshot(conversationId, { userId: conv.userId });
	let initialComposer = '';
	const draftTicketId = url.searchParams.get('draftTicketId');
	if (draftTicketId && !hasMessages) {
		const draftTicketInt = ticketId.tryParse(draftTicketId);
		const ticket = draftTicketInt === null ? null : tickets.get(draftTicketInt, locals.userId);
		if (!ticket || ticket.workspaceKey !== ticketWorkspaceFromConversation(conv)) {
			throw error(404);
		}
		const actionId = url.searchParams.get('ticketActionId');
		const actionInt = actionId ? promptTemplateId.tryParse(actionId) : null;
		const action = actionInt === null ? null : promptTemplates.get(actionInt, locals.userId);
		if (!action || action.type !== 'ticket-action' || action.status !== 'open') {
			throw error(404);
		}
		initialComposer = interpolateTicketPrompt(action, ticket);
	}
	const promptTemplateIdParam = url.searchParams.get('promptTemplateId');
	if (!initialComposer && promptTemplateIdParam && !hasMessages) {
		const source = url.searchParams.get('promptTemplateSource');
		const template =
			source === 'builtin'
				? getBuiltInPromptTemplate(promptTemplateIdParam)
				: source === 'custom'
					? promptTemplates.get(
							promptTemplateId.tryParse(promptTemplateIdParam) ?? -1,
							locals.userId
						)
					: null;
		if (!template || template.status !== 'open') throw error(404);
		initialComposer = template.prompt;
	}
	const refinePromptTemplateId = url.searchParams.get('refinePromptTemplateId');
	if (!initialComposer && refinePromptTemplateId && !hasMessages) {
		const template = promptTemplates.get(
			promptTemplateId.tryParse(refinePromptTemplateId) ?? -1,
			locals.userId
		);
		if (!template || template.status !== 'open') throw error(404);
		initialComposer = buildRefinePromptSeed(template);
	}
	// A fork created while its source was busy stashes the edited prompt as a
	// persisted draft (no turn auto-started). Seed it into the composer until
	// the user sends it; survives reloads since it lives on the conversation row.
	// We can't gate on `hasMessages` here — a deferred edit-fork clones the
	// prefix before the edited message, so the fork usually already has messages.
	// The draft is cleared when the first turn starts, so a non-null value always
	// means "not yet sent".
	if (!initialComposer && conv.draftPrompt) {
		initialComposer = conv.draftPrompt;
	}

	// Surface any in-flight turn so the client can reattach its
	// EventSource on page load. Only running turns count — finished but
	// still-cached turns would just replay then immediately yield `done`.
	const turn = getTurn(conversationId);
	const activeTurnId = turn && turn.status === 'running' ? turn.id : null;

	// Snapshot any prompts currently waiting on a user response so a fresh
	// page load shows them immediately, without waiting for the SSE stream
	// to (re-)emit the `interactive.request` event.
	const pendingInteractive = listPendingInteractive(conversationId);
	const cfg = loadConfig();

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
		const p = convs.get(convCodec.parse(conv.forkedFromConversationId), locals.userId);
		if (p) {
			let idx: number | null = null;
			if (conv.forkedFromMessageId) {
				const parentMsgs = messages.listByConversation(convCodec.parse(p.id));
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
		effectiveModel: conv.model ?? cfg.DEFAULT_MODEL,
		modelOptions: listEnabledModelOptions(),
		chatPlaceholder: 'Message…',
		// Backend-projected transcript: bounded hydrated tail + older index.
		transcript,
		contextUsage,
		memorySnapshot,
		parent,
		activeTurnId,
		pendingInteractive,
		initialComposer
	};
};
