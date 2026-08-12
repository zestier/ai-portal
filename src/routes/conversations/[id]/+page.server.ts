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
import { loadConfig } from '$lib/server/config';
import { ticketWorkspaceFromConversation } from '$lib/server/ticket-workspace';
import { interpolateTicketPrompt } from '$lib/tickets/chat';
import {
	INLINE_ARGS_MAX_BYTES,
	INLINE_DIFF_MAX_BYTES,
	INLINE_REASONING_MAX_BYTES,
	INLINE_RESULT_MAX_BYTES
} from '$lib/payload-limits';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!locals.userId) throw error(401);
	const conversationId = Number(params.id);
	if (!Number.isInteger(conversationId) || conversationId <= 0) throw error(404);
	const conv = convs.get(conversationId, locals.userId);
	if (!conv) throw error(404);
	const msgs = messages.listByConversation(conv.id, {
		// Oversized tool args/results, file diffs and reasoning text are collapsed
		// by default in the UI, so shipping them in the page payload costs
		// megabytes for content the reader rarely opens. Trim them to markers;
		// ToolCall / DiffView / ReasoningBlock fetch the full text on demand.
		inlineMaxBytes: {
			args: INLINE_ARGS_MAX_BYTES,
			result: INLINE_RESULT_MAX_BYTES,
			diff: INLINE_DIFF_MAX_BYTES,
			reasoning: INLINE_REASONING_MAX_BYTES
		}
	});
	// Opening a conversation counts as seeing it: clears the sidebar's unseen
	// indicator. Output that streams in *after* this load is covered by the
	// client's post-turn POST to `/read`.
	convs.markRead(conv.id, locals.userId);
	const contextUsage = usage.get(conv.id);
	const memorySnapshot = memory.listSnapshot(conv.id, { userId: conv.userId });
	let initialComposer = '';
	const draftTicketId = url.searchParams.get('draftTicketId');
	if (draftTicketId && msgs.length === 0) {
		const ticket = tickets.get(Number(draftTicketId), locals.userId);
		if (!ticket || ticket.workspaceKey !== ticketWorkspaceFromConversation(conv)) {
			throw error(404);
		}
		const actionId = url.searchParams.get('ticketActionId');
		const action = actionId ? promptTemplates.get(Number(actionId), locals.userId) : null;
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
				? getBuiltInPromptTemplate(Number(promptTemplateId))
				: source === 'custom'
					? promptTemplates.get(Number(promptTemplateId), locals.userId)
					: null;
		if (!template || template.status !== 'open') throw error(404);
		initialComposer = template.prompt;
	}
	const refinePromptTemplateId = url.searchParams.get('refinePromptTemplateId');
	if (!initialComposer && refinePromptTemplateId && msgs.length === 0) {
		const template = promptTemplates.get(Number(refinePromptTemplateId), locals.userId);
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
	const cfg = loadConfig();

	// If this conversation was forked, surface parent info for a
	// breadcrumb. Resolves silently to null if the parent was deleted or
	// belongs to a different user.
	let parent: {
		id: number;
		title: string;
		messageId: number | null;
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
		effectiveModel: conv.model ?? cfg.DEFAULT_MODEL,
		defaultModelPlaceholder: cfg.PI_MODEL ?? 'provider/model',
		chatPlaceholder: 'Message…',
		messages: msgs,
		contextUsage,
		memorySnapshot,
		parent,
		activeTurnId,
		pendingInteractive,
		initialComposer
	};
};
