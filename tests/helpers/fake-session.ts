import type { PortalEvent } from '../../src/lib/types';
import type { ConversationSession } from '../../src/lib/server/copilot/copilot-provider';

/**
 * Build a fake ConversationSession whose `send()` yields a fixed sequence
 * of PortalEvents. Used by turn-runner and usage tests in place of the
 * real bridge/SDK.
 */
export function makeFakeSession(
	events: PortalEvent[],
	conversationId = 'conv-x',
	workingDirectory = '/tmp'
): ConversationSession {
	return {
		conversationId,
		providerSessionId: conversationId,
		workingDirectory,
		model: 'test-model',
		async *send(): AsyncIterable<PortalEvent> {
			for (const e of events) yield e;
		},
		async abort() {},
		async dispose() {},
		async setMode() {},
		async setApproveAll() {},
		async resetSessionApprovals() {},
		lastUsed: Date.now()
	};
}
