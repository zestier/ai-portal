import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';

/**
 * `copilotProvider.complete()` — the tool-less side-call path that lets the
 * adversary shadow reviewer run on the conversation's own backend instead of
 * requiring a separate OpenAI-compatible endpoint.
 *
 * Exercised against the stub Copilot client, so these cover the contract
 * (returns the assistant's TEXT, tool-less, scratch cwd) rather than real SDK
 * latency — which is measured separately.
 */
describe('copilotProvider.complete', () => {
	beforeEach(async () => {
		process.env.COPILOT_STUB = '1';
		await setupLocalEnv('portal-copilot-sidecall-');
	});

	it('advertises the side-completion capability', async () => {
		const { copilotProvider } = await import('../src/lib/server/copilot/copilot-provider');
		expect(copilotProvider.capabilities.sideCompletion).toBe(true);
		expect(typeof copilotProvider.complete).toBe('function');
	});

	it('resolves with the assistant text, not the message id', async () => {
		// The bug this pins: the SDK's `send()` resolves with a MESSAGE ID and
		// delivers the text over the event stream, so a side call built on it
		// returns an opaque id that every verdict parser rejects — turning each
		// Copilot-backed shadow row into an error row for a reason nothing
		// surfaces. `sendAndWait` is the request/response call.
		const { copilotProvider } = await import('../src/lib/server/copilot/copilot-provider');
		const text = await copilotProvider.complete!({
			model: 'reviewer-model',
			system: 'you are a reviewer',
			user: 'review this request',
			timeoutMs: 5000,
			userId: 'user-1'
		});
		expect(text).toBe('Stubbed reply to: review this request');
	});

	it('requires a userId, because Copilot auth is per-user', async () => {
		// Unlike the OpenAI-compatible providers there is no operator-level
		// credential to fall back on, so a missing userId must fail loudly rather
		// than silently billing or authenticating as the wrong identity.
		const { copilotProvider } = await import('../src/lib/server/copilot/copilot-provider');
		await expect(
			copilotProvider.complete!({
				model: 'reviewer-model',
				system: 's',
				user: 'u',
				timeoutMs: 5000
			})
		).rejects.toThrow('userId');
	});

	it('opens the session tool-less, outside any user repository', async () => {
		// The reviewer must not be able to act, and must not inherit a repo's
		// AGENTS.md / copilot-instructions.md — those are loaded from the working
		// directory regardless of `enableConfigDiscovery`.
		const { getClient } = await import('../src/lib/server/copilot/copilot-provider');
		const { copilotProvider } = await import('../src/lib/server/copilot/copilot-provider');
		const client = (await getClient('user-1')) as unknown as {
			createSession: (opts: Record<string, unknown>) => Promise<unknown>;
		};
		const seen: Array<Record<string, unknown>> = [];
		const original = client.createSession.bind(client);
		client.createSession = async (opts) => {
			seen.push(opts);
			return original(opts);
		};

		await copilotProvider.complete!({
			model: 'reviewer-model',
			system: 'you are a reviewer',
			user: 'review this',
			timeoutMs: 5000,
			userId: 'user-1'
		});

		expect(seen).toHaveLength(1);
		const cfg = seen[0]!;
		expect(cfg.tools).toEqual([]);
		expect(cfg.streaming).toBe(false);
		// `append`, never `replace`: replace would drop the SDK's own guardrails.
		expect(cfg.systemMessage).toMatchObject({ mode: 'append', content: 'you are a reviewer' });
		// A scratch temp dir, not the portal's or a conversation's workspace.
		expect(String(cfg.workingDirectory)).toContain('portal-sidecall-');
		expect(String(cfg.workingDirectory)).not.toBe(process.cwd());
		// `tools: []` covers only SDK-consumer tools; the runtime's built-ins are
		// stopped by the permission callback, which must never raise a dialog.
		const onPermissionRequest = cfg.onPermissionRequest as () => Promise<{ kind: string }>;
		expect(await onPermissionRequest()).toEqual({ kind: 'user-not-available' });
	});
});
