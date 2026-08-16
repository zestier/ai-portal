import { z } from 'zod';
import type { InteractiveResponse, PortalEvent } from '$lib/types';
import { ASK_USER_TOOL_NAME } from './self-interactive';
import {
	isInteractivePromptCancelledError,
	newRequestId,
	register as registerInteractive
} from '../runtime/interactive-requests';
import { err, ok, type PortalTool } from './types';

export const AskUserArgs = z.object({
	question: z
		.string()
		.trim()
		.min(1, 'question must not be empty')
		.max(2000, 'question must be at most 2000 characters'),
	choices: z.array(z.string().trim().min(1)).max(20).optional()
});

export interface AskUserToolOpts {
	userId: number;
	conversationId: number;
	emit: (ev: PortalEvent) => void;
}

// Build the `ask_user` tool. It is `never-prompt` (asking carries no side
// effect, nothing to gate at the call site). Its handler ALWAYS raises a
// `user_input` dialog and waits for the human's answer regardless of approval
// mode — the whole point is human input, and auto-answering is impossible.
// Like the grant tools this behaves as a forced prompt under any mode.
export function buildAskUserTool(opts: AskUserToolOpts): PortalTool {
	return {
		name: ASK_USER_TOOL_NAME,
		description:
			'Pause the turn and ask the human a question; returns their answer. Use when the task blocks on information only the human can provide.',
		promptGuidelines: [
			'Ask ONE clear, self-contained question; the human waits on it.',
			'Add `choices` only when a fixed set fits; free-form typing always works.'
		],
		argsSchema: AskUserArgs,
		permissionBehavior: 'never-prompt',
		parameters: {
			type: 'object',
			properties: {
				question: { type: 'string', description: 'The question.' },
				choices: {
					type: 'array',
					items: { type: 'string' },
					description: 'Preset answers.'
				}
			},
			required: ['question'],
			additionalProperties: false
		},
		async handler(args) {
			const parsed = AskUserArgs.parse(args);
			const requestId = newRequestId();
			const view = {
				requestId,
				kind: 'user_input',
				question: parsed.question,
				choices: parsed.choices,
				allowFreeform: true
			} as const;

			let response: InteractiveResponse;
			try {
				response = await new Promise<InteractiveResponse>((resolve, reject) => {
					registerInteractive({
						requestId,
						conversationId: opts.conversationId,
						userId: opts.userId,
						kind: 'user_input',
						view,
						resolve,
						reject,
						emit: opts.emit
					});
					opts.emit({ type: 'interactive.request', request: view });
				});
			} catch (e) {
				if (isInteractivePromptCancelledError(e)) {
					return err(
						'The question was dismissed before the human answered (turn aborted, timed out, or disconnected). This is not a decline — re-ask if the answer is still needed.',
						{ code: 'question_cancelled' }
					);
				}
				throw e;
			}

			if (response.kind !== 'user_input') {
				return err('Unexpected response.');
			}

			return ok(
				{
					question: parsed.question,
					answer: response.answer,
					wasFreeform: response.wasFreeform ?? false
				},
				`The human answered: ${response.answer}`
			);
		}
	};
}
