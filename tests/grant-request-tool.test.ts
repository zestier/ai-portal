import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import type { InteractivePermissionDecision, PortalEvent, SessionMode } from '../src/lib/types';
import type { GrantScope } from '../src/lib/permissions/scope-types';
import type { PortalTool, ToolResult } from '../src/lib/server/tools/types';

// A short, stable fragment of the forcePermissionPrompt nudge. Asserting on
// this substring (not the exact prose) keeps the tests robust to wording tweaks
// while still pinning the nudge BEHAVIOR per outcome.
const NUDGE_MARKER = 'forcePermissionPrompt';

// The `request_permission_grant` tool always raises a human permission dialog
// (it is `never-prompt`, so the call site never gates it) and only persists a
// grant when the human approves. These tests drive the tool handler directly,
// resolve the prompt it raises, and assert the grant is (or isn't) persisted.

let convCounter = 0;

async function makeHarness(mode: SessionMode = 'interactive') {
	const interactive = await import('../src/lib/server/runtime/interactive-requests');
	const { buildPermissionTools } = await import('../src/lib/server/tools/permissions');
	const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
	const settings = await import('../src/lib/server/db/repos/settings');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const user = ensureLocalUser();
	const conversationId = `conv-grant-${convCounter++}`;
	convs.create(user.id, {
		id: conversationId,
		title: 'grant test',
		workdir: '/tmp',
		model: 'gpt-4'
	});
	const events: PortalEvent[] = [];
	const tools = buildPermissionTools({
		userId: user.id,
		conversationId,
		policy: 'prompt',
		getMode: () => mode,
		emit: (ev) => events.push(ev)
	});
	const tool = tools.find((t) => t.name === 'request_permission_grant') as PortalTool;
	expect(tool).toBeTruthy();
	expect(tool.permissionBehavior).toBe('never-prompt');
	return { interactive, settings, user, conversationId, events, tool };
}

async function driveAndResolve(
	harness: Awaited<ReturnType<typeof makeHarness>>,
	args: Record<string, unknown>,
	decision: InteractivePermissionDecision,
	extra: Record<string, unknown> = {}
): Promise<{ result: ToolResult; view: Record<string, unknown> }> {
	const resultPromise = harness.tool.handler(args) as Promise<ToolResult>;

	let view: { requestId: string; [k: string]: unknown } | undefined;
	for (let i = 0; i < 200 && !view; i++) {
		const pending = harness.interactive.listForConversation(harness.conversationId);
		if (pending.length > 0) {
			view = pending[0] as { requestId: string };
			break;
		}
		await new Promise((r) => setTimeout(r, 1));
	}
	if (!view) throw new Error('no human prompt was raised');

	const ok = harness.interactive.resolve(view.requestId, harness.user.id, {
		kind: 'permission',
		decision,
		...extra
	});
	expect(ok).toBe(true);

	const result = await resultPromise;
	return { result, view: view as Record<string, unknown> };
}

const SHELL_SCOPE: GrantScope = {
	kind: 'shell',
	rule: { command: [{ token: 'pnpm' }], positionals: { kind: 'workspace-paths' } }
};

// Extract the model-facing text from either envelope variant so nudge
// assertions don't care whether the outcome was ok (summary) or err (message).
function envelopeText(result: ToolResult): string {
	return result.ok ? (result.summary ?? '') : result.error.message;
}

describe('request_permission_grant', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-grant-tool-');
	});

	it('raises a grant-request dialog carrying the proposed scope and reason', async () => {
		const harness = await makeHarness();
		const reason = 'Scaffolding needs to run pnpm to install dependencies.';
		const { result, view } = await driveAndResolve(
			harness,
			{ tool: 'shell', reason, scope: SHELL_SCOPE },
			'allow-always',
			{ scope: { permissionKind: 'shell', scope: SHELL_SCOPE }, applyToAllConversations: false }
		);

		expect(view).toMatchObject({
			kind: 'permission',
			tool: 'shell',
			permissionKind: 'shell',
			canPersistDecision: true,
			grantRequest: { reason, permissionKind: 'shell', scope: SHELL_SCOPE }
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toMatchObject({ saved: true, tool: 'shell' });
		}
		// A successful allow-always save is the correct outcome — no nudge.
		expect(envelopeText(result)).not.toContain(NUDGE_MARKER);

		// The grant is persisted (conversation-scoped) by the interactive registry.
		const grants = harness.settings
			.listGrantsForUser(harness.user.id)
			.filter((g) => g.tool === 'shell' && g.source === 'prompt');
		expect(grants.length).toBe(1);
		expect(grants[0].conversationId).toBe(harness.conversationId);
		expect(grants[0].scope).toEqual(SHELL_SCOPE);
	});

	it('reports the human-edited (narrowed) scope, not the agent proposal', async () => {
		const harness = await makeHarness();
		// Agent proposes a broad "any pnpm" scope; the human narrows it to
		// `pnpm install` before saving. The tool must report what was actually
		// persisted, not the original proposal.
		const narrowed: GrantScope = {
			kind: 'shell',
			rule: {
				command: [{ token: 'pnpm' }, { token: 'install' }],
				positionals: { kind: 'workspace-paths' }
			}
		};
		const { result } = await driveAndResolve(
			harness,
			{ tool: 'shell', reason: 'Scaffolding needs to run pnpm install.', scope: SHELL_SCOPE },
			'allow-always',
			{ scope: { permissionKind: 'shell', scope: narrowed }, applyToAllConversations: false }
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toMatchObject({ saved: true, scope: narrowed });
			expect(result.result).not.toMatchObject({ scope: SHELL_SCOPE });
		}

		const grants = harness.settings
			.listGrantsForUser(harness.user.id)
			.filter((g) => g.tool === 'shell' && g.source === 'prompt');
		expect(grants.length).toBe(1);
		expect(grants[0].scope).toEqual(narrowed);
	});

	it('persists a user-global grant when the human applies it to all conversations', async () => {
		const harness = await makeHarness();
		const { result } = await driveAndResolve(
			harness,
			{
				tool: 'shell',
				reason: 'Allow pnpm everywhere for project scaffolding.',
				scope: SHELL_SCOPE
			},
			'allow-always',
			{ scope: { permissionKind: 'shell', scope: SHELL_SCOPE }, applyToAllConversations: true }
		);
		expect(result.ok).toBe(true);
		const grants = harness.settings
			.listGrantsForUser(harness.user.id)
			.filter((g) => g.tool === 'shell' && g.source === 'prompt');
		expect(grants.length).toBe(1);
		expect(grants[0].conversationId).toBeNull();
	});

	it('returns an error and persists nothing when the human denies', async () => {
		const harness = await makeHarness();
		const { result } = await driveAndResolve(
			harness,
			{ tool: 'shell', reason: 'Request to run pnpm for scaffolding.', scope: SHELL_SCOPE },
			'deny',
			{ feedback: 'Use the structured tools instead.' }
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain('Use the structured tools instead.');
			expect(result.error.code).toBe('grant_request_denied');
		}
		// Denied is one of the three nudge outcomes.
		expect(envelopeText(result)).toContain(NUDGE_MARKER);
		const grants = harness.settings
			.listGrantsForUser(harness.user.id)
			.filter((g) => g.source === 'prompt');
		expect(grants.length).toBe(0);
	});

	it('raises a prompt even in best-effort mode (always-prompt, like forcePermissionPrompt)', async () => {
		const harness = await makeHarness('best-effort');
		const { result } = await driveAndResolve(
			harness,
			{ tool: 'shell', reason: 'Request to run pnpm for scaffolding.', scope: SHELL_SCOPE },
			'allow-always',
			{ scope: { permissionKind: 'shell', scope: SHELL_SCOPE }, applyToAllConversations: false }
		);
		expect(result.ok).toBe(true);
		const grants = harness.settings
			.listGrantsForUser(harness.user.id)
			.filter((g) => g.tool === 'shell' && g.source === 'prompt');
		expect(grants.length).toBe(1);
	});

	it('reports a cancellation (turn abort) as a non-denial', async () => {
		const harness = await makeHarness();
		const resultPromise = harness.tool.handler({
			tool: 'shell',
			reason: 'Request to run pnpm for scaffolding.',
			scope: SHELL_SCOPE
		}) as Promise<ToolResult>;
		// Wait for the prompt, then abort the conversation.
		for (let i = 0; i < 200; i++) {
			if (harness.interactive.listForConversation(harness.conversationId).length > 0) break;
			await new Promise((r) => setTimeout(r, 1));
		}
		harness.interactive.cancelConversation(harness.conversationId, 'turn_aborted');
		const result = await resultPromise;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('grant_request_cancelled');
		// Cancellation is one of the three nudge outcomes.
		expect(envelopeText(result)).toContain(NUDGE_MARKER);
	});

	it('nudges toward forcePermissionPrompt on an allow-once (approved-not-saved) outcome', async () => {
		const harness = await makeHarness();
		const { result } = await driveAndResolve(
			harness,
			{ tool: 'shell', reason: 'Request to run pnpm for scaffolding.', scope: SHELL_SCOPE },
			'allow-once'
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.result).toMatchObject({ saved: false, tool: 'shell' });
		}
		// Approved but not saved is a strong signal it should have been a one-off.
		expect(envelopeText(result)).toContain(NUDGE_MARKER);
		// Nothing is persisted on allow-once.
		const grants = harness.settings
			.listGrantsForUser(harness.user.id)
			.filter((g) => g.source === 'prompt');
		expect(grants.length).toBe(0);
	});

	it('rejects arguments whose scope shape does not match the tool', async () => {
		const harness = await makeHarness();
		const parsed = harness.tool.argsSchema!.safeParse({
			tool: 'shell',
			reason: 'A reason long enough to satisfy the minimum length rule.',
			scope: { kind: 'url', rule: { kind: 'host', host: 'example.com' } }
		});
		expect(parsed.success).toBe(false);
	});

	it('rejects a reason that is too short', async () => {
		const harness = await makeHarness();
		const parsed = harness.tool.argsSchema!.safeParse({
			tool: 'shell',
			reason: 'too short',
			scope: SHELL_SCOPE
		});
		expect(parsed.success).toBe(false);
	});
});
