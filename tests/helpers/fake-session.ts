import type { PortalEvent } from '../../src/lib/types';
import type { ProviderSession } from '../../src/lib/server/pi/session-contract';

/**
 * Build a fake ProviderSession whose `send()` yields a fixed sequence
 * of PortalEvents. Used by turn-runner and usage tests in place of the
 * real bridge/SDK.
 */
export function makeFakeSession(
	events: PortalEvent[],
	conversationId = 'conv-x',
	workingDirectory = '/tmp'
): ProviderSession {
	return {
		provider: 'pi',
		conversationId,
		providerSessionId: conversationId,
		workingDirectory,
		model: 'test-model',
		lastUsed: Date.now(),
		async *send(): AsyncIterable<PortalEvent> {
			for (const e of events) yield e;
		},
		async abort() {},
		async dispose() {}
	};
}
