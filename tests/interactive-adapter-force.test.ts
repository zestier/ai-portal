import { describe, it, expect, beforeEach } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import type {
	ApprovalMode,
	InteractivePermissionDecision,
	PermissionPolicy,
	PortalEvent,
	SessionMode
} from '../src/lib/types';
import { err, ok, type PortalTool, type ToolStreamContext } from '../src/lib/server/tools/types';

// A denial mints a one-shot token and embeds a `force_retry_tool` hint in the
// deny feedback. Calling `force_retry_tool` with that token raises a fresh,
// approve-once human dialog for the EXACT denied call (original tool + args).
// If the human approves, portal-owned tools (those the `resolvePortalTool`
// resolver finds) execute DIRECTLY with the originally captured args and return
// the underlying ToolResult; other tools mark the token approved so a matching
// retry is auto-allowed by `consumeForcedRetryMatch`. Either way it runs once —
// the token is one-shot, so a third identical request is denied again.
//
// These tests drive the adapter's `onPermissionRequest` directly so each
// short-circuit can be configured precisely, and the `force_retry_tool`
// handler from `buildPermissionTools` for the escalation half of the flow.

const REASON =
	'No structured alternative exists for this exact operation, so a human prompt is required.';

const FORCE_RETRY_HINT_RE = /force_retry_tool` with `token: "([0-9a-f]{24})"/;

function tokenFromFeedback(feedback: string | undefined): string {
	expect(feedback).toBeDefined();
	const m = FORCE_RETRY_HINT_RE.exec(feedback ?? '');
	if (!m) throw new Error('deny feedback did not carry a force_retry_tool token');
	return m[1];
}

function stream(): ToolStreamContext {
	return {
		signal: new AbortController().signal,
		partial() {},
		progress() {}
	};
}

interface HarnessOverrides {
	policy?: PermissionPolicy;
	approvalMode?: ApprovalMode;
	behavior?: 'normal' | 'always-prompt' | 'never-prompt';
	validateCustomToolArgs?: (toolName: string, args: unknown) => { feedback: string } | null;
	mode?: SessionMode;
	/** Resolves denied tool names to portal tools for direct-execution tests. */
	resolvePortalTool?: (name: string) => PortalTool | null;
}

let convCounter = 0;

async function makeHarness(overrides: HarnessOverrides = {}) {
	const interactive = await import('../src/lib/server/runtime/interactive-requests');
	const { createInteractiveCallbacks } =
		await import('../src/lib/server/copilot/interactive-adapter');
	const { buildPermissionTools } = await import('../src/lib/server/tools/permissions');
	const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
	const settings = await import('../src/lib/server/db/repos/settings');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const user = ensureLocalUser();
	const conversationId = `conv-force-${convCounter++}`;
	convs.create(user.id, {
		id: conversationId,
		title: 'force retry test',
		workdir: '/tmp',
		model: 'gpt-4'
	});
	const events: PortalEvent[] = [];

	const adapterOpts = {
		conversationId,
		userId: user.id,
		workingDirectory: '/tmp',
		getWorkspaceRoots: () => ['/tmp'],
		policy: overrides.policy ?? 'prompt',
		emit: (ev: PortalEvent) => events.push(ev),
		getApprovalMode: () => overrides.approvalMode ?? 'ask',
		getSessionWorkspacePath: () => null,
		getPermissionBehavior: () => overrides.behavior ?? 'normal',
		validateCustomToolArgs: overrides.validateCustomToolArgs
	};
	const { onPermissionRequest } = createInteractiveCallbacks(adapterOpts);

	const tools = buildPermissionTools({
		userId: user.id,
		conversationId,
		policy: adapterOpts.policy,
		getMode: () => overrides.mode ?? 'interactive',
		getApprovalMode: adapterOpts.getApprovalMode,
		emit: adapterOpts.emit,
		...(overrides.resolvePortalTool !== undefined
			? { resolvePortalTool: overrides.resolvePortalTool }
			: {})
	});
	const forceRetryTool = tools.find((t) => t.name === 'force_retry_tool');
	if (!forceRetryTool) throw new Error('force_retry_tool was not built');

	return {
		interactive,
		settings,
		user,
		conversationId,
		events,
		onPermissionRequest,
		forceRetryTool
	};
}

interface DialogView {
	requestId: string;
	[k: string]: unknown;
}

/** Wait for the next pending interactive request for the harness conversation. */
async function waitForDialog(
	harness: Awaited<ReturnType<typeof makeHarness>>
): Promise<DialogView> {
	for (let i = 0; i < 300; i++) {
		const pending = harness.interactive.listForConversation(harness.conversationId);
		if (pending.length > 0) return pending[0] as unknown as DialogView;
		await new Promise((r) => setTimeout(r, 1));
	}
	throw new Error('no human prompt was raised');
}

function resolveDialog(
	harness: Awaited<ReturnType<typeof makeHarness>>,
	view: { requestId: string },
	decision: InteractivePermissionDecision,
	feedback?: string
): void {
	const ok = harness.interactive.resolve(view.requestId, harness.user.id, {
		kind: 'permission',
		decision,
		...(feedback !== undefined ? { feedback } : {})
	});
	expect(ok).toBe(true);
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
	const view = await waitForDialog(harness);
	resolveDialog(harness, view, decision, feedback);
	return { result: await resultPromise, view };
}

/**
 * Deny `req`, extract the minted token from the deny feedback, then escalate it
 * through `force_retry_tool` and resolve the raised dialog with `decision`.
 * Returns everything a test needs to assert on both halves of the flow.
 */
async function denyThenForceRetry(
	harness: Awaited<ReturnType<typeof makeHarness>>,
	req: Record<string, unknown>,
	decision: InteractivePermissionDecision,
	feedback?: string
) {
	const first = await harness.onPermissionRequest(req);
	expect(first).toMatchObject({ kind: 'reject' });
	const token = tokenFromFeedback((first as { feedback?: string }).feedback);

	const retryPromise = harness.forceRetryTool.handler({ token, reason: REASON }, stream());
	const view = await waitForDialog(harness);
	resolveDialog(harness, view, decision, feedback);
	const retryResult = await retryPromise;

	return { first, token, view, retryResult };
}

const SHELL_REQ = (command: string): Record<string, unknown> => ({
	kind: 'shell',
	toolName: 'shell',
	fullCommandText: command,
	args: { command }
});

const URL_REQ: Record<string, unknown> = {
	kind: 'url',
	toolName: 'web_fetch',
	url: 'https://example.com/docs',
	args: { url: 'https://example.com/docs' }
};

describe('force_retry_tool is the universal escalation', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-force-test-');
	});

	describe('every deny path mints a token with a hint', () => {
		it('shell-misuse denies carry a token and hint', async () => {
			const harness = await makeHarness();
			const { first, token } = await denyThenForceRetry(
				harness,
				SHELL_REQ('cat > out.txt'),
				'deny'
			);
			expect((first as { feedback: string }).feedback).toContain('force_retry_tool');
			expect(token).toMatch(/^[0-9a-f]{24}$/);
		});

		it('schema-invalid custom tool args deny with a token', async () => {
			const harness = await makeHarness({
				validateCustomToolArgs: () => ({ feedback: 'args do not match schema' })
			});
			const req: Record<string, unknown> = {
				kind: 'shell',
				toolName: 'git_commit',
				fullCommandText: 'git commit',
				args: { message: 'x' }
			};
			const { first } = await denyThenForceRetry(harness, req, 'deny');
			expect((first as { feedback: string }).feedback).toContain('do not match schema');
			expect((first as { feedback: string }).feedback).toContain('force_retry_tool');
		});

		it('hard-deny grants deny with a token and surface the deny reason', async () => {
			const harness = await makeHarness();
			harness.settings.addGrant({
				userId: harness.user.id,
				conversationId: null,
				tool: 'shell',
				permissionKind: 'shell',
				scope: { kind: 'shell', rule: { command: [{ token: 'rm' }] } },
				decision: 'deny',
				denyReason: 'Hard deny: rm is forbidden in shell.'
			});
			const { first, view, token } = await denyThenForceRetry(
				harness,
				SHELL_REQ('rm -rf build'),
				'allow-once'
			);
			expect((first as { feedback: string }).feedback).toContain('rm is forbidden');
			// The escalation dialog pre-fills the original deny reason as its
			// default deny feedback and shows the original tool/args.
			expect((view as { defaultDenyFeedback?: string }).defaultDenyFeedback).toContain(
				'rm is forbidden'
			);
			expect(view).toMatchObject({ tool: 'shell', permissionKind: 'shell' });
			expect((view as { args?: unknown }).args).toEqual({ command: 'rm -rf build' });
			expect(token).toMatch(/^[0-9a-f]{24}$/);
		});

		it('auto-deny approval mode denies with a token', async () => {
			const harness = await makeHarness({ approvalMode: 'auto-deny' });
			const { first } = await denyThenForceRetry(harness, URL_REQ, 'deny');
			const feedback = (first as { feedback: string }).feedback;
			expect(feedback).toContain('auto-deny');
			expect(feedback).toContain('force_retry_tool');
		});

		it('deny-all policy denies with a token', async () => {
			const harness = await makeHarness({ policy: 'deny-all' });
			const { first } = await denyThenForceRetry(harness, URL_REQ, 'deny');
			expect((first as { feedback: string }).feedback).toContain('force_retry_tool');
		});
	});

	describe('approving a forced retry auto-allows the identical retry', () => {
		it('escalates a shell-misuse denial to a successful retry', async () => {
			const harness = await makeHarness();
			await denyThenForceRetry(harness, SHELL_REQ('cat > out.txt'), 'allow-once');
			const retried = await harness.onPermissionRequest(SHELL_REQ('cat > out.txt'));
			expect(retried).toEqual({ kind: 'approve-once' });
			expect(harness.interactive.listForConversation(harness.conversationId)).toHaveLength(0);
		});

		it('escalates a hard-deny grant to a successful retry', async () => {
			const harness = await makeHarness();
			harness.settings.addGrant({
				userId: harness.user.id,
				conversationId: null,
				tool: 'shell',
				permissionKind: 'shell',
				scope: { kind: 'shell', rule: { command: [{ token: 'rm' }] } },
				decision: 'deny',
				denyReason: 'rm is forbidden'
			});
			await denyThenForceRetry(harness, SHELL_REQ('rm -rf build'), 'allow-once');
			const retried = await harness.onPermissionRequest(SHELL_REQ('rm -rf build'));
			expect(retried).toEqual({ kind: 'approve-once' });
		});

		it('escalates an auto-deny approval mode denial to a successful retry', async () => {
			const harness = await makeHarness({ approvalMode: 'auto-deny' });
			await denyThenForceRetry(harness, URL_REQ, 'allow-once');
			const retried = await harness.onPermissionRequest(URL_REQ);
			expect(retried).toEqual({ kind: 'approve-once' });
		});

		it('escalates a deny-all policy denial to a successful retry', async () => {
			const harness = await makeHarness({ policy: 'deny-all' });
			await denyThenForceRetry(harness, URL_REQ, 'allow-once');
			const retried = await harness.onPermissionRequest(URL_REQ);
			expect(retried).toEqual({ kind: 'approve-once' });
		});

		it('escalates a schema-invalid custom-tool denial to a successful retry', async () => {
			const harness = await makeHarness({
				validateCustomToolArgs: () => ({ feedback: 'args do not match schema' })
			});
			const req: Record<string, unknown> = {
				kind: 'shell',
				toolName: 'git_commit',
				fullCommandText: 'git commit',
				args: { message: 'x' }
			};
			await denyThenForceRetry(harness, req, 'allow-once');
			const retried = await harness.onPermissionRequest(req);
			expect(retried).toEqual({ kind: 'approve-once' });
		});

		it('escalates a human-denied normal dialog to a successful retry', async () => {
			const harness = await makeHarness({ policy: 'prompt' });
			const first = await driveAndResolve(harness, URL_REQ, 'deny', 'Human declined the prompt.');
			expect(first.result).toEqual({
				kind: 'reject',
				feedback: expect.stringContaining('Human declined the prompt.') as unknown as string
			});
			const token = tokenFromFeedback((first.result as { feedback: string }).feedback);
			const retryPromise = harness.forceRetryTool.handler({ token, reason: REASON }, stream());
			const view = await waitForDialog(harness);
			expect(view).toMatchObject({
				kind: 'permission',
				tool: 'web_fetch',
				canPersistDecision: false,
				escalationReason: REASON
			});
			resolveDialog(harness, view, 'allow-once');
			await retryPromise;
			const retried = await harness.onPermissionRequest(URL_REQ);
			expect(retried).toEqual({ kind: 'approve-once' });
		});

		it('is one-shot: a third identical request is denied again', async () => {
			const harness = await makeHarness();
			await denyThenForceRetry(harness, SHELL_REQ('cat > out.txt'), 'allow-once');
			expect(await harness.onPermissionRequest(SHELL_REQ('cat > out.txt'))).toEqual({
				kind: 'approve-once'
			});
			const third = await harness.onPermissionRequest(SHELL_REQ('cat > out.txt'));
			expect(third).toMatchObject({ kind: 'reject' });
			expect((third as { feedback: string }).feedback).toContain('force_retry_tool');
		});
	});

	describe('approving a forced retry on a portal-owned tool executes it directly', () => {
		// A schema-invalid custom-tool request auto-denies (minting a token
		// without a dialog); the escalation then approves and the resolvable
		// tool must run with the captured args, returning its own ToolResult.
		const customReq = (args: Record<string, unknown>): Record<string, unknown> => ({
			kind: 'custom-tool',
			toolName: 'stub_tool',
			args
		});
		const harnessForStub = (stubTool: PortalTool) =>
			makeHarness({
				validateCustomToolArgs: () => ({ feedback: 'args do not match schema' }),
				resolvePortalTool: (name) => (name === 'stub_tool' ? stubTool : null)
			});

		it('returns the underlying ToolResult with the captured args, token consumed one-shot', async () => {
			const captured: unknown[] = [];
			const stubTool: PortalTool = {
				name: 'stub_tool',
				description: 'stub',
				parameters: {},
				async handler(args) {
					captured.push(args);
					return ok({ ran: true, args }, 'stub ran');
				}
			};
			const harness = await harnessForStub(stubTool);
			const { token, retryResult } = await denyThenForceRetry(
				harness,
				customReq({ pattern: 'x' }),
				'allow-once'
			);
			// The underlying ToolResult envelope, not an `{approved:true}` wrapper.
			expect(retryResult).toMatchObject({
				ok: true,
				result: { ran: true, args: { pattern: 'x' } }
			});
			expect(captured).toEqual([{ pattern: 'x' }]);
			// Token consumed one-shot: a re-issued identical request is denied
			// fresh (minting a new token), never re-executed.
			const retried = await harness.onPermissionRequest(customReq({ pattern: 'x' }));
			expect(retried).toMatchObject({ kind: 'reject' });
			expect(tokenFromFeedback((retried as { feedback: string }).feedback)).not.toBe(token);
		});

		it('returns the underlying error envelope when the tool errors', async () => {
			const stubTool: PortalTool = {
				name: 'stub_tool',
				description: 'stub',
				parameters: {},
				async handler() {
					return err('stub failed', { code: 'stub_error' });
				}
			};
			const harness = await harnessForStub(stubTool);
			const { retryResult } = await denyThenForceRetry(harness, customReq({}), 'allow-once');
			expect(retryResult).toMatchObject({ ok: false });
			expect((retryResult as { error: { code: string } }).error.code).toBe('stub_error');
		});

		it('passes the denied tool name to the resolver so the owning portal tool resolves', async () => {
			const resolved: string[] = [];
			const stubTool: PortalTool = {
				name: 'shell_exec',
				description: 'stub',
				parameters: {},
				async handler() {
					return ok({ ran: true });
				}
			};
			const harness = await makeHarness({
				validateCustomToolArgs: () => ({ feedback: 'args do not match schema' }),
				resolvePortalTool: (name) => {
					resolved.push(name);
					return name === 'shell_exec' ? stubTool : null;
				}
			});
			const req: Record<string, unknown> = {
				kind: 'shell',
				toolName: 'shell_exec',
				fullCommandText: 'echo hi',
				args: { command: 'echo hi' }
			};
			const { retryResult } = await denyThenForceRetry(harness, req, 'allow-once');
			expect(retryResult).toMatchObject({ ok: true, result: { ran: true } });
			expect(resolved).toContain('shell_exec');
		});

		it('runs exactly once when two escalations of one token are approved', async () => {
			let executions = 0;
			const stubTool: PortalTool = {
				name: 'stub_tool',
				description: 'stub',
				parameters: {},
				async handler() {
					executions += 1;
					return ok({ ran: true });
				}
			};
			const harness = await harnessForStub(stubTool);
			const first = await harness.onPermissionRequest(customReq({ a: 1 }));
			expect(first).toMatchObject({ kind: 'reject' });
			const token = tokenFromFeedback((first as { feedback: string }).feedback);

			const p1 = harness.forceRetryTool.handler({ token, reason: REASON }, stream());
			const v1 = await waitForDialog(harness);
			const p2 = harness.forceRetryTool.handler({ token, reason: REASON }, stream());
			let views: ReturnType<typeof harness.interactive.listForConversation> = [];
			for (let i = 0; i < 300 && views.length < 2; i++) {
				views = harness.interactive.listForConversation(harness.conversationId);
				if (views.length >= 2) break;
				await new Promise((r) => setTimeout(r, 1));
			}
			expect(views.length).toBe(2);

			resolveDialog(harness, v1, 'allow-once');
			resolveDialog(harness, views[1], 'allow-once');
			const [r1, r2] = await Promise.all([p1, p2]);
			expect(executions).toBe(1);
			expect(r1).toMatchObject({ ok: true, result: { ran: true } });
			expect(r2).toMatchObject({ ok: false });
			expect((r2 as { error: { code: string } }).error.code).toBe('force_retry_resolved');
		});

		it('errors force_retry_missing_args when the denied request carried no args', async () => {
			const stubTool: PortalTool = {
				name: 'stub_tool',
				description: 'stub',
				parameters: {},
				async handler() {
					return ok({ ran: true });
				}
			};
			const harness = await harnessForStub(stubTool);
			// No `args` field, so the minted entry carries args:null — nothing to
			// execute directly.
			const first = await harness.onPermissionRequest({
				kind: 'custom-tool',
				toolName: 'stub_tool'
			});
			expect(first).toMatchObject({ kind: 'reject' });
			const token = tokenFromFeedback((first as { feedback: string }).feedback);
			const retryPromise = harness.forceRetryTool.handler({ token, reason: REASON }, stream());
			const view = await waitForDialog(harness);
			resolveDialog(harness, view, 'allow-once');
			const retryResult = await retryPromise;
			expect(retryResult).toMatchObject({ ok: false });
			expect((retryResult as { error: { code: string } }).error.code).toBe(
				'force_retry_missing_args'
			);
		});
	});

	describe('a forced-retry approval covers incidental args drift (scope-keyed)', () => {
		it('approves a shell retry that adds an incidental args field', async () => {
			const harness = await makeHarness();
			await denyThenForceRetry(harness, SHELL_REQ('cat > out.txt'), 'allow-once');
			const retried = await harness.onPermissionRequest({
				kind: 'shell',
				toolName: 'shell',
				fullCommandText: 'cat > out.txt',
				args: { command: 'cat > out.txt', description: 'write output' }
			});
			expect(retried).toEqual({ kind: 'approve-once' });
		});

		it('approves a write retry to the same path with re-rendered content', async () => {
			const harness = await makeHarness();
			// Outside the workspace root (`/tmp`) so the `prompt` policy does not
			// auto-approve it before the dialog; the request then prompts (unlike
			// the shell cases, which auto-deny), so it is denied by resolving the
			// dialog with `deny` — mirroring the "human-denied normal dialog" test.
			const writeReq = (content: string): Record<string, unknown> => ({
				kind: 'write',
				toolName: 'create',
				path: '/var/tmp/out.txt',
				args: { file_path: '/var/tmp/out.txt', content }
			});
			const first = await driveAndResolve(harness, writeReq('first draft'), 'deny');
			expect(first.result).toMatchObject({ kind: 'reject' });
			const token = tokenFromFeedback((first.result as { feedback: string }).feedback);

			const retryPromise = harness.forceRetryTool.handler({ token, reason: REASON }, stream());
			const view = await waitForDialog(harness);
			resolveDialog(harness, view, 'allow-once');
			await retryPromise;

			const retried = await harness.onPermissionRequest(writeReq('re-rendered: first draft'));
			expect(retried).toEqual({ kind: 'approve-once' });
		});

		it('still denies a retry with a different scope key', async () => {
			const harness = await makeHarness();
			const { first } = await denyThenForceRetry(harness, SHELL_REQ('cat > out.txt'), 'allow-once');
			const retried = await harness.onPermissionRequest(SHELL_REQ('cat > other.txt'));
			expect(retried).toMatchObject({ kind: 'reject' });
			// Scope stays bound: the rejected retry mints a FRESH token, not the
			// consumed one.
			expect(tokenFromFeedback((retried as { feedback: string }).feedback)).not.toBe(
				tokenFromFeedback((first as { feedback: string }).feedback)
			);
		});

		it('still denies a drifted retry for a custom-tool (no scope key)', async () => {
			const harness = await makeHarness({
				validateCustomToolArgs: () => ({ feedback: 'args do not match schema' })
			});
			const toolReq = (subject: string): Record<string, unknown> => ({
				kind: 'custom-tool',
				toolName: 'git_commit',
				args: { subject }
			});
			await denyThenForceRetry(harness, toolReq('initial subject'), 'allow-once');
			// The harness wires no `resolvePortalTool`, so this custom-tool denial
			// stays on the approve-then-retry fall-back path: no scope key means
			// args are the only identity, so a drifted retry is still denied
			// (strictness preserved). A resolvable portal tool would have executed
			// directly with the captured args instead, eliminating the drift class.
			const retried = await harness.onPermissionRequest(toolReq('drifted subject'));
			expect(retried).toMatchObject({ kind: 'reject' });
		});

		it('does not report success when a concurrent escalation resolves the token first', async () => {
			const harness = await makeHarness();
			const first = await harness.onPermissionRequest(SHELL_REQ('cat > out.txt'));
			expect(first).toMatchObject({ kind: 'reject' });
			const token = tokenFromFeedback((first as { feedback: string }).feedback);

			// Two concurrent escalations of the same token both pass the pending
			// check and raise a dialog; only the first approved can record, and
			// the second must report a resolved-token error rather than a false
			// `{approved: true}`.
			const p1 = harness.forceRetryTool.handler({ token, reason: REASON }, stream());
			const v1 = await waitForDialog(harness);
			const p2 = harness.forceRetryTool.handler({ token, reason: REASON }, stream());
			let views: ReturnType<typeof harness.interactive.listForConversation> = [];
			for (let i = 0; i < 300 && views.length < 2; i++) {
				views = harness.interactive.listForConversation(harness.conversationId);
				if (views.length >= 2) break;
				await new Promise((r) => setTimeout(r, 1));
			}
			expect(views.length).toBe(2);

			resolveDialog(harness, v1, 'allow-once');
			resolveDialog(harness, views[1], 'allow-once');
			const [r1, r2] = await Promise.all([p1, p2]);
			expect(r1).toMatchObject({ ok: true, result: { approved: true } });
			expect(r2).toMatchObject({ ok: false });
			expect((r2 as { error: { code: string } }).error.code).toBe('force_retry_resolved');
		});
	});

	describe('denying a forced retry keeps the call denied', () => {
		it('revokes the token so the retry is denied again', async () => {
			const harness = await makeHarness();
			const { first, retryResult } = await denyThenForceRetry(
				harness,
				SHELL_REQ('cat > out.txt'),
				'deny',
				'Still no.'
			);
			expect(retryResult).toMatchObject({ ok: false });
			expect((retryResult as { error: { message: string } }).error.message).toContain('Still no.');
			// The token was revoked, so the exact retry is denied again (and
			// mints a fresh token).
			const retried = await harness.onPermissionRequest(SHELL_REQ('cat > out.txt'));
			expect(retried).toMatchObject({ kind: 'reject' });
			expect(tokenFromFeedback((retried as { feedback: string }).feedback)).not.toBe(
				tokenFromFeedback((first as { feedback: string }).feedback)
			);
		});
	});

	describe('force_retry_tool input validation', () => {
		it('rejects an unknown token', async () => {
			const harness = await makeHarness();
			const result = await harness.forceRetryTool.handler(
				{ token: 'a'.repeat(24), reason: REASON },
				stream()
			);
			expect(result).toMatchObject({ ok: false });
			expect((result as { error: { message: string } }).error.message).toContain(
				'Unknown or expired'
			);
			expect(harness.interactive.listForConversation(harness.conversationId)).toHaveLength(0);
		});

		it('rejects a non-hex token at the schema boundary', async () => {
			const harness = await makeHarness();
			await expect(
				harness.forceRetryTool.handler({ token: 'not-a-token', reason: REASON }, stream())
			).rejects.toThrow();
		});

		it('rejects a short reason', async () => {
			const harness = await makeHarness();
			await expect(
				harness.forceRetryTool.handler({ token: 'a'.repeat(24), reason: 'short' }, stream())
			).rejects.toThrow();
		});

		it('does not approve a token for a different conversation', async () => {
			const harness = await makeHarness();
			const first = await harness.onPermissionRequest(SHELL_REQ('cat > out.txt'));
			expect(first).toMatchObject({ kind: 'reject' });
			const token = tokenFromFeedback((first as { feedback: string }).feedback);

			const other = await makeHarness();
			const result = await other.forceRetryTool.handler({ token, reason: REASON }, stream());
			expect(result).toMatchObject({ ok: false });
			expect((result as { error: { message: string } }).error.message).toContain(
				'another conversation'
			);
		});
	});

	describe('unforced auto-allow paths are unchanged', () => {
		it('never-prompt still auto-allows with no token or dialog', async () => {
			const harness = await makeHarness({ behavior: 'never-prompt' });
			const result = await harness.onPermissionRequest({
				kind: 'url',
				toolName: 'web_fetch',
				url: 'https://example.com/docs',
				args: { url: 'https://example.com/docs' }
			});
			expect(result).toEqual({ kind: 'approve-once' });
			expect(harness.interactive.listForConversation(harness.conversationId)).toHaveLength(0);
		});

		it('auto-approve still auto-allows with no dialog', async () => {
			const harness = await makeHarness({ approvalMode: 'auto-approve' });
			const result = await harness.onPermissionRequest(URL_REQ);
			expect(result).toEqual({ kind: 'approve-once' });
			expect(harness.interactive.listForConversation(harness.conversationId)).toHaveLength(0);
		});
	});
});
