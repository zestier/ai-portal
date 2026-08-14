import type { PortalEvent } from '../../src/lib/types';
import type { ProviderSession } from '../../src/lib/server/pi/session-contract';
import { conversationId as convCodec } from '../../src/lib/ids';

/**
 * Build a fake ProviderSession whose `send()` yields a fixed sequence
 * of PortalEvents. Used by turn-runner and usage tests in place of the
 * real bridge/SDK. `conversationId` accepts either an int (storage-layer
 * convention) or a `C…` handle (wire convention) and is normalized to the
 * int the runtime expects on the session object.
 */
export function makeFakeSession(
	events: PortalEvent[],
	conversationId: string | number = 1,
	workingDirectory = '/tmp'
): ProviderSession {
	return {
		provider: 'pi',
		conversationId:
			typeof conversationId === 'number' ? conversationId : convCodec.parse(conversationId),
		providerSessionId: String(conversationId),
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
