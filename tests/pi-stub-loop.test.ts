import { describe, expect, it } from 'vitest';
import type { ProviderOpenOptions } from '../src/lib/server/pi/session-contract';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

// End-to-end pi path: the shared ModelRuntime + registered stub model + a real
// pi `AgentSession` served through the `ProviderSession` adapter. Exercises the
// same code the turn-runner drives when PI_STUB=1, without needing a DB.
describe('pi stub loop', () => {
	it('streams a deterministic reply through the ProviderSession adapter', async () => {
		const wd = makeTmpDir('pi-wd-');
		await setupLocalEnv('pi-stub-test-');
		process.env.PI_STUB = '1';
		const { resetConfigForTests } = await import('../src/lib/server/config');
		resetConfigForTests();

		const { openPiSession } = await import('../src/lib/server/pi');
		const bridge: ProviderOpenOptions = {
			conversationId: 1,
			userId: 1,
			workingDirectory: wd,
			model: 'stub',
			policy: 'prompt'
		};
		const session = await openPiSession(bridge);
		const ac = new AbortController();
		const events: Array<{ type: string; text?: unknown; messageId?: unknown }> = [];
		for await (const ev of session.send('hello stub world', ac.signal)) {
			events.push(ev);
		}
		await session.dispose();

		const deltas = events
			.filter((e) => e.type === 'message.delta')
			.map((e) => String(e.text))
			.join('');
		expect(deltas).toContain('Stubbed reply to: hello stub world');
		expect(events.some((e) => e.type === 'message.start')).toBe(true);
		expect(events.some((e) => e.type === 'message.end')).toBe(true);
		// Per-turn context snapshot emitted at agent_end (stub window 200,000).
		const usage = events.find((e) => e.type === 'context.usage');
		expect(usage).toMatchObject({ tokenLimit: 200_000, currentTokens: expect.any(Number) });
		expect(events.some((e) => e.type === 'error')).toBe(false);
	}, 30_000);
});
