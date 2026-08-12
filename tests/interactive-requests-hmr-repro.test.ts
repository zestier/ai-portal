// Regression test for ticket 01KTYKK0Z2CCH0Y2G7RNTYNJDH (secondary strand;
// follow-up to investigation 01KTNR3HRJQFW3CGPK6K5V5XKV).
//
// The interactive `pending` map used to be a plain module-level
// `const pending = new Map()`, so a fresh module instance (what Vite SSR HMR
// produces when interactive-requests.ts or one of its importers is edited
// mid-turn) got an EMPTY map. The deferred captured by the live SDK session
// (whose pool/turn state survives on globalThis) was orphaned:
//   - the resolve POST route, bound to the new module, couldn't see it
//     (get() -> undefined -> 404)
//   - listForConversation (new module) returned [] -> dialog vanished
//   - the original promise never settled -> turn hung forever
//
// The fix stashes `pending` on globalThis (mirroring pool.sessions and the
// turn registry). We simulate the HMR module swap with vi.resetModules() +
// a fresh dynamic import, which mirrors Vite creating a new module record.

import { describe, it, expect, vi } from 'vitest';

type IR = typeof import('../src/lib/server/runtime/interactive-requests');

const CONV = 1;

function makeView(requestId: string) {
	return {
		requestId,
		kind: 'permission' as const,
		tool: 'git_commit',
		permissionKind: 'shell',
		summary: 'commit changes',
		args: null,
		userPolicy: 'prompt' as const,
		canPersistDecision: false
	};
}

// Ticket 01KTYKK0Z2CCH0Y2G7RNTYNJDH: the deferred must SURVIVE a module
// reload now that `pending` is globalThis-backed.
describe('interactive pending map survives module reload (HMR)', () => {
	it('keeps the deferred reachable + resolvable across a module re-instantiation', async () => {
		vi.resetModules();
		const modA: IR = await import('../src/lib/server/runtime/interactive-requests');

		const requestId = 'REQ_HMR_1';
		let settled = false;
		const promise = new Promise<void>((resolve, reject) => {
			modA.register({
				requestId,
				conversationId: CONV,
				kind: 'permission',
				view: makeView(requestId),
				resolve: () => {
					settled = true;
					resolve();
				},
				reject
			});
		});

		// Pre-reload: the same module instance can see it.
		expect(modA.get(requestId)).toBeDefined();
		expect(modA.listForConversation(CONV).map((v) => v.requestId)).toEqual([requestId]);

		// --- Simulate Vite SSR HMR: a brand-new module record. The resolve
		// route / conversation GET re-import and bind to THIS one. ---
		vi.resetModules();
		const modB: IR = await import('../src/lib/server/runtime/interactive-requests');
		expect(modB).not.toBe(modA);

		// The new module instance still sees the deferred (globalThis-backed)...
		expect(modB.get(requestId)).toBeDefined();
		expect(modB.listForConversation(CONV).map((v) => v.requestId)).toEqual([requestId]);

		// ...and resolving through the new module settles the ORIGINAL deferred,
		// so the parked turn unblocks instead of hanging forever.
		const ok = modB.resolve(requestId, 1, { kind: 'permission', decision: 'allow-once' });
		expect(ok).toBe(true);
		await promise;
		expect(settled).toBe(true);

		// Resolved request is gone from both views.
		expect(modB.get(requestId)).toBeUndefined();
		expect(modB.listForConversation(CONV)).toEqual([]);
	});

	it('a globalThis-backed map (the pool/turns pattern) survives the same reload', async () => {
		// Control: this is exactly why turns/sessions DON'T leak across HMR.
		const KEY = Symbol.for('zap.repro.control-map');
		type Slot = Record<symbol, unknown>;
		const g = globalThis as unknown as Slot;

		vi.resetModules();
		// "module A" creates-or-reuses the singleton
		(g[KEY] as Map<string, number>) ??= new Map<string, number>();
		(g[KEY] as Map<string, number>).set('x', 1);

		vi.resetModules();
		// "module B" after reload reuses the SAME map
		const reused = ((g[KEY] as Map<string, number>) ??= new Map());
		expect(reused.get('x')).toBe(1);

		delete g[KEY];
	});
});
