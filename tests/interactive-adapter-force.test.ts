import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import type {
	ApprovalMode,
	InteractivePermissionDecision,
	PermissionPolicy,
	PortalEvent
} from '../src/lib/types';

// A present, valid `forcePermissionPrompt` is the strongest signal: it must
// always reach a human permission dialog, overriding every auto-allow and
// auto-deny path (behaviors, the arg-schema and shell-misuse guards, grants,
// and policy) under every approval mode. These tests drive the
// adapter's `onPermissionRequest` directly so each short-circuit can be
// configured precisely.

const FORCE_REASON =
	'No structured alternative exists for this exact operation, so a human prompt is required.';

interface HarnessOverrides {
	policy?: PermissionPolicy;
	approvalMode?: ApprovalMode;
	behavior?: 'normal' | 'always-prompt' | 'never-prompt';
	validateCustomToolArgs?: (toolName: string, args: unknown) => { feedback: string } | null;
}

let convCounter = 0;

async function makeHarness(overrides: HarnessOverrides = {}) {
	const interactive = await import('../src/lib/server/runtime/interactive-requests');
	const { createInteractiveCallbacks } =
		await import('../src/lib/server/copilot/interactive-adapter');
	const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
	const settings = await import('../src/lib/server/db/repos/settings');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const user = ensureLocalUser();
	const conversationId = `conv-force-${convCounter++}`;
	convs.create(user.id, {
		id: conversationId,
		title: 'force test',
		workdir: '/tmp',
		model: 'gpt-4'
	});
	const events: PortalEvent[] = [];

	const { onPermissionRequest } = createInteractiveCallbacks({
		conversationId,
		userId: user.id,
		workingDirectory: '/tmp',
		getWorkspaceRoots: () => ['/tmp'],
		policy: overrides.policy ?? 'prompt',
		emit: (ev) => events.push(ev),
		getApprovalMode: () => overrides.approvalMode ?? 'ask',
		getSessionWorkspacePath: () => null,
		getPermissionBehavior: () => overrides.behavior ?? 'normal',
		validateCustomToolArgs: overrides.validateCustomToolArgs
	});

	return { interactive, settings, user, conversationId, events, onPermissionRequest };
}

/**
 * Drive a permission request through the adapter, wait for it to raise a human
 * prompt, then resolve that prompt with `decision`. Returns the adapter's final
 * SDK-facing result plus the prompt view that was surfaced.
 */
async function driveAndResolve(
	harness: Awaited<ReturnType<typeof makeHarness>>,
	req: Record<string, unknown>,
	decision: InteractivePermissionDecision,
	feedback?: string
) {
	const resultPromise = harness.onPermissionRequest(req);

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
		...(feedback !== undefined ? { feedback } : {})
	});
	expect(ok).toBe(true);

	const result = await resultPromise;
	return { result, view };
}

const SHELL_FORCE_ARGS = (command: string) => ({
	kind: 'shell',
	toolName: 'shell',
	fullCommandText: command,
	args: { command, forcePermissionPrompt: FORCE_REASON }
});

describe('forcePermissionPrompt is the strongest signal', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-force-test-');
	});

	for (const approvalMode of ['ask', 'auto-deny'] as const) {
		describe(`${approvalMode} approval mode`, () => {
			it('escalates a never-prompt behavior to a human prompt', async () => {
				const harness = await makeHarness({ approvalMode, behavior: 'never-prompt' });
				const { result, view } = await driveAndResolve(
					harness,
					{
						kind: 'url',
						toolName: 'web_fetch',
						url: 'https://example.com/docs',
						args: { url: 'https://example.com/docs', forcePermissionPrompt: FORCE_REASON }
					},
					'allow-once'
				);
				expect(view).toMatchObject({
					kind: 'permission',
					canPersistDecision: false,
					escalationReason: FORCE_REASON
				});
				expect(result).toEqual({ kind: 'approve-once' });
				const decisions = harness.settings
					.listRecentDecisionsForUser(harness.user.id)
					.filter((d) => d.conversationId === harness.conversationId);
				expect(decisions.some((d) => d.decision === 'auto-allow')).toBe(true);
			});

			it('escalates auto-approve to a human prompt', async () => {
				const harness = await makeHarness({ approvalMode: 'auto-approve' });
				const { result, view } = await driveAndResolve(
					harness,
					{
						kind: 'url',
						toolName: 'web_fetch',
						url: 'https://example.com/docs',
						args: { url: 'https://example.com/docs', forcePermissionPrompt: FORCE_REASON }
					},
					'allow-once'
				);
				expect(view).toMatchObject({ escalationReason: FORCE_REASON, canPersistDecision: false });
				expect(result).toEqual({ kind: 'approve-once' });
			});

			it('escalates an allow-all policy to a human prompt', async () => {
				const harness = await makeHarness({ approvalMode, policy: 'allow-all' });
				const { result } = await driveAndResolve(
					harness,
					{
						kind: 'url',
						toolName: 'web_fetch',
						url: 'https://example.com/docs',
						args: { url: 'https://example.com/docs', forcePermissionPrompt: FORCE_REASON }
					},
					'allow-once'
				);
				expect(result).toEqual({ kind: 'approve-once' });
			});

			it('escalates a deny-all policy to a human prompt', async () => {
				const harness = await makeHarness({ approvalMode, policy: 'deny-all' });
				const { result, view } = await driveAndResolve(
					harness,
					{
						kind: 'url',
						toolName: 'web_fetch',
						url: 'https://example.com/docs',
						args: { url: 'https://example.com/docs', forcePermissionPrompt: FORCE_REASON }
					},
					'deny',
					'Human declined the forced prompt.'
				);
				expect(view).toMatchObject({ escalationReason: FORCE_REASON });
				expect(result).toEqual({
					kind: 'reject',
					feedback: 'Human declined the forced prompt.'
				});
				const decisions = harness.settings
					.listRecentDecisionsForUser(harness.user.id)
					.filter((d) => d.conversationId === harness.conversationId);
				expect(decisions.some((d) => d.decision === 'auto-deny')).toBe(true);
			});

			it('escalates a matching allow grant to a human prompt', async () => {
				const harness = await makeHarness({ approvalMode });
				harness.settings.addGrant({
					userId: harness.user.id,
					conversationId: null,
					tool: 'shell',
					permissionKind: 'shell',
					scope: { kind: 'shell', rule: { command: [{ token: 'node' }] } },
					decision: 'allow'
				});
				const { result } = await driveAndResolve(
					harness,
					SHELL_FORCE_ARGS('node --version'),
					'allow-once'
				);
				expect(result).toEqual({ kind: 'approve-once' });
			});

			it('escalates a matching hard-deny grant to a human prompt', async () => {
				const harness = await makeHarness({ approvalMode });
				harness.settings.addGrant({
					userId: harness.user.id,
					conversationId: null,
					tool: 'shell',
					permissionKind: 'shell',
					scope: { kind: 'shell', rule: { command: [{ token: 'rm' }] } },
					decision: 'deny',
					denyReason: 'Hard deny: rm is forbidden in shell.'
				});
				const { result, view } = await driveAndResolve(
					harness,
					SHELL_FORCE_ARGS('rm -rf build'),
					'allow-once'
				);
				expect(view).toMatchObject({ escalationReason: FORCE_REASON, canPersistDecision: false });
				expect((view as { defaultDenyFeedback?: string }).defaultDenyFeedback).toContain(
					'rm is forbidden'
				);
				expect(result).toEqual({ kind: 'approve-once' });
			});

			it('escalates schema-invalid custom tool args to a human prompt', async () => {
				const harness = await makeHarness({
					approvalMode,
					validateCustomToolArgs: () => ({ feedback: 'args do not match schema' })
				});
				const { result, view } = await driveAndResolve(
					harness,
					{
						kind: 'shell',
						toolName: 'git_commit',
						fullCommandText: 'git commit',
						args: { forcePermissionPrompt: FORCE_REASON }
					},
					'allow-once'
				);
				expect((view as { defaultDenyFeedback?: string }).defaultDenyFeedback).toContain(
					'do not match schema'
				);
				expect(result).toEqual({ kind: 'approve-once' });
			});

			it('escalates a shell-misuse command to a human prompt and surfaces shellAnalysis', async () => {
				const harness = await makeHarness({ approvalMode });
				const { result, view } = await driveAndResolve(
					harness,
					SHELL_FORCE_ARGS('cat > out.txt'),
					'allow-once'
				);
				expect(view).toMatchObject({
					escalationReason: FORCE_REASON,
					permissionKind: 'shell'
				});
				expect((view as { shellAnalysis?: unknown }).shellAnalysis).toBeDefined();
				expect((view as { defaultDenyFeedback?: string }).defaultDenyFeedback).toContain('create');
				expect(result).toEqual({ kind: 'approve-once' });
			});
		});
	}

	it('still hard-rejects a malformed forcePermissionPrompt without prompting', async () => {
		const harness = await makeHarness({ approvalMode: 'ask' });
		const result = await harness.onPermissionRequest({
			kind: 'url',
			toolName: 'web_fetch',
			url: 'https://example.com/docs',
			args: { url: 'https://example.com/docs', forcePermissionPrompt: 'too short' }
		});
		expect(result).toMatchObject({ kind: 'reject' });
		expect(harness.interactive.listForConversation(harness.conversationId)).toHaveLength(0);
	});

	it('does not prompt when no force is present (never-prompt still auto-allows)', async () => {
		const harness = await makeHarness({ approvalMode: 'ask', behavior: 'never-prompt' });
		const result = await harness.onPermissionRequest({
			kind: 'url',
			toolName: 'web_fetch',
			url: 'https://example.com/docs',
			args: { url: 'https://example.com/docs' }
		});
		expect(result).toEqual({ kind: 'approve-once' });
		expect(harness.interactive.listForConversation(harness.conversationId)).toHaveLength(0);
	});
});
