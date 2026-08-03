import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { authorizeConversation } from '$lib/server/conversation-auth';
import * as convs from '$lib/server/db/repos/conversations';
import * as memoryRepo from '$lib/server/db/repos/memory';
import * as messages from '$lib/server/db/repos/messages';
import * as settings from '$lib/server/db/repos/settings';
import * as usage from '$lib/server/db/repos/usage';
import { loadConfig } from '$lib/server/config';
import { effectiveWorkdir } from '$lib/server/workdir';
import { getTurn, startTurn } from '$lib/server/runtime/turn-runner';
import { providerAuthToken } from '$lib/server/providers/auth';
import { parseBody } from '$lib/server/validate';
import { argsHash } from '$lib/server/tool-invocation';
import { isEnabled } from '$lib/server/memory/engine';

const Body = z
	.object({
		confirmed: z.boolean().optional().default(false)
	})
	.optional()
	.default({});

const APPROVAL_TTL_MS = 2 * 60_000;

export const POST: RequestHandler = async ({ params, locals, request }) => {
	const conv = authorizeConversation(params.id, locals.userId);
	const body = await parseBody(request, Body, { allowEmpty: true });
	const toolCallId = params.toolCallId;
	if (!toolCallId) throw error(400, 'missing tool call id');

	const current = getTurn(conv.id);
	if (current && current.status === 'running') {
		throw error(409, 'A turn is already in progress for this conversation.');
	}

	const original = messages.getToolCallForConversation(conv.id, toolCallId);
	if (!original || original.conversationUserId !== conv.userId) throw error(404);

	const eligibility = getRerunEligibility(original);
	if (!eligibility.eligible) throw error(400, eligibility.reason);
	if (eligibility.requiresConfirmation && !body.confirmed) {
		throw error(400, 'This tool can have side effects; confirm the exact arguments before rerun.');
	}

	let parsedArgs: unknown;
	try {
		parsedArgs = JSON.parse(original.argsJson);
	} catch {
		throw error(400, 'Original tool arguments are not valid JSON.');
	}
	const hash = argsHash(parsedArgs);

	const expiresAt = Date.now() + APPROVAL_TTL_MS;
	settings.pruneExpiredGrants();
	settings.addGrant({
		userId: conv.userId,
		conversationId: conv.id,
		tool: approvalToolFor(original.tool),
		permissionKind: null,
		scopePattern: null,
		scope: null,
		argsHash: hash,
		decision: 'force-allow',
		expiresAt
	});
	settings.recordDecision(
		conv.id,
		original.tool,
		`Manual rerun approval for ${original.id}`,
		'allow-once'
	);

	const allMessages = messages.listByConversation(conv.id);
	const originalMessageIdx = allMessages.findIndex((message) => message.id === original.messageId);
	if (originalMessageIdx < 0) throw error(404);
	memoryRepo.rewindSessionMemoryLogToMessagePrefix(conv.id, {
		messageIds: new Set(allMessages.slice(0, originalMessageIdx + 1).map((message) => message.id)),
		createdBefore: allMessages[originalMessageIdx + 1]?.createdAt
	});
	messages.truncateAfterMessage(conv.id, original.messageId);
	usage.remove(conv.id);
	const providerSessionId =
		convs.rotateProviderSession(conv.id, conv.userId) ?? conv.providerSessionId;

	const cfg = loadConfig();
	const userSettings = settings.get(conv.userId) ?? settings.defaults();
	const prompt = buildRerunPrompt(original.tool, original.argsJson);
	const userMessage = messages.append(conv.id, {
		role: 'user',
		content: `Manual tool rerun: rerun failed tool call ${original.id} (${original.tool}) with its exact stored arguments.`,
		status: 'complete'
	});
	const providerToken = providerAuthToken(conv.provider, conv.userId);
	const turn = await startTurn({
		conversationId: conv.id,
		prompt,
		bridge: {
			conversationId: conv.id,
			providerSessionId,
			userId: conv.userId,
			workingDirectory: effectiveWorkdir(conv.workdir),
			provider: conv.provider,
			model: conv.model ?? cfg.DEFAULT_MODEL,
			policy: userSettings.defaultPolicy,
			mode: conv.mode,
			approvalMode: conv.approvalMode,
			adversaryModel: conv.adversaryModel,
			adversaryBackend: conv.adversaryBackend,
			disabledToolGroups: conv.disabledToolGroups,
			memoryMode: conv.memoryMode,
			globalMemoryEnabled: conv.globalMemoryEnabled,
			...(providerToken !== undefined ? { providerAuthToken: providerToken } : {})
		},
		memory: isEnabled(conv.memoryMode)
			? {
					mode: conv.memoryMode,
					userMessageId: userMessage.id,
					userContent: userMessage.content,
					extractorModel: conv.memoryExtractorModel,
					extractorBackend: conv.memoryExtractorBackend
				}
			: undefined
	});

	return json({ turnId: turn.id, grantExpiresAt: expiresAt });
};

function getRerunEligibility(
	t: messages.ToolCallWithConversation
): { eligible: true; requiresConfirmation: boolean } | { eligible: false; reason: string } {
	if (t.messageRole !== 'assistant')
		return { eligible: false, reason: 'Only assistant tool calls can be rerun.' };
	if (t.parentToolCallId) {
		return { eligible: false, reason: 'Nested sub-agent tool calls cannot be rerun yet.' };
	}
	if (t.endedAt === null || t.status === 'pending') {
		return { eligible: false, reason: 'Only completed tool calls can be rerun.' };
	}
	if (t.status !== 'denied' && t.status !== 'error') {
		return { eligible: false, reason: 'Only failed tool calls can be rerun.' };
	}
	try {
		JSON.parse(t.argsJson);
	} catch {
		return { eligible: false, reason: 'Original tool arguments are not valid JSON.' };
	}
	return { eligible: true, requiresConfirmation: requiresSideEffectConfirmation(t) };
}

function requiresSideEffectConfirmation(t: messages.ToolCallWithConversation): boolean {
	if (t.tool === 'view' || t.tool === 'git_show_file') return false;
	return true;
}

function approvalToolFor(tool: string): string {
	return tool === 'bash' || tool === 'shell' || tool === 'run' ? 'shell' : tool;
}

function buildRerunPrompt(tool: string, argsJson: string): string {
	return [
		'Manual tool rerun request.',
		'The user reviewed and approved rerunning one historical failed tool invocation.',
		'Invoke exactly the tool below with exactly the JSON arguments below. Do not call any other tool, do not change the arguments, and do not summarize or restate sensitive arguments in prose.',
		`Tool: ${tool}`,
		'Arguments JSON:',
		argsJson
	].join('\n\n');
}
