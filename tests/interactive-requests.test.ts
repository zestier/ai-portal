import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	decideByPolicy,
	register,
	resolve,
	cancel,
	cancelConversation,
	expireConversation,
	hasPending,
	awaitingInputConversationIds,
	newRequestId,
	get,
	defaultInteractiveResponse,
	InteractivePromptCancelledError
} from '../src/lib/server/runtime/interactive-requests';
import { createInteractiveCallbacks } from '../src/lib/server/copilot/interactive-adapter';
import { isBlockingKind } from '../src/lib/interactive/request-registry';
import * as users from '../src/lib/server/db/repos/users';
import * as convs from '../src/lib/server/db/repos/conversations';
import * as settings from '../src/lib/server/db/repos/settings';
import type {
	InteractiveKind,
	InteractiveResponse,
	InteractiveRequestView,
	PortalEvent
} from '../src/lib/types';
import { setupLocalEnv } from './helpers/env';

describe('decideByPolicy', () => {
	let wsRoot: string;
	beforeAll(() => {
		wsRoot = realpathSync(mkdtempSync(join(tmpdir(), 'portal-policy-ws-')));
		mkdirSync(join(wsRoot, 'src'));
		writeFileSync(join(wsRoot, 'src', 'a.ts'), 'x');
	});
	afterAll(() => {
		rmSync(wsRoot, { recursive: true, force: true });
	});

	it('only auto-approves the permission kind', () => {
		// Non-permission kinds are user-facing decisions; never silently apply.
		expect(decideByPolicy('allow-all', 'auto_mode_switch')).toBe('ask');
		expect(decideByPolicy('allow-all', 'exit_plan_mode')).toBe('ask');
		expect(decideByPolicy('allow-all', 'user_input')).toBe('ask');
		expect(decideByPolicy('deny-all', 'elicitation')).toBe('ask');
	});
	it('permission kind respects the policy table', () => {
		expect(decideByPolicy('allow-all', 'permission', 'shell')).toBe('approved');
		expect(decideByPolicy('deny-all', 'permission', 'read')).toBe('denied');
		expect(decideByPolicy('prompt', 'permission', 'shell')).toBe('ask');
		expect(decideByPolicy('prompt', 'permission', 'shell', { scopeKey: 'ls -la' })).toBe('ask');
		expect(decideByPolicy('prompt', 'permission', 'url')).toBe('ask');
	});
	it('prompt policy auto-allows file ops only inside the workspace', () => {
		const ctx = { workspaceRoot: wsRoot, scopeKey: join(wsRoot, 'src', 'a.ts') };
		expect(decideByPolicy('prompt', 'permission', 'read', ctx)).toBe('approved');
		expect(decideByPolicy('prompt', 'permission', 'write', ctx)).toBe('approved');
		expect(decideByPolicy('prompt', 'permission', 'edit', ctx)).toBe('approved');
	});
	it('prompt policy auto-allows not-yet-existing files inside the workspace', () => {
		const ctx = { workspaceRoot: wsRoot, scopeKey: join(wsRoot, 'src', 'new.ts') };
		expect(decideByPolicy('prompt', 'permission', 'write', ctx)).toBe('approved');
	});
	it('prompt policy prompts for file ops outside the workspace', () => {
		expect(
			decideByPolicy('prompt', 'permission', 'read', {
				workspaceRoot: wsRoot,
				scopeKey: '/etc/passwd'
			})
		).toBe('ask');
		expect(
			decideByPolicy('prompt', 'permission', 'write', {
				workspaceRoot: wsRoot,
				scopeKey: '../other/x'
			})
		).toBe('ask');
		// Missing context falls back to ask (safer default).
		expect(decideByPolicy('prompt', 'permission', 'read')).toBe('ask');
		expect(decideByPolicy('prompt', 'permission', 'write')).toBe('ask');
	});
	it('allow-all / deny-all ignore workspace context', () => {
		const ctx = { workspaceRoot: wsRoot, scopeKey: '/etc/passwd' };
		expect(decideByPolicy('allow-all', 'permission', 'write', ctx)).toBe('approved');
		expect(decideByPolicy('deny-all', 'permission', 'read', ctx)).toBe('denied');
	});
});

describe('interactive request registry', () => {
	let userId: string;
	let conversationId: string;
	beforeEach(async () => {
		await setupLocalEnv('portal-interactive-test-');
		userId = users.ensureLocalUser().id;
		conversationId = convs.create(userId, { title: 't', workdir: '/tmp', model: null }).id;
	});

	it('classifies every interactive kind as blocking or info (drift guard)', () => {
		// Exhaustive Record so adding a new InteractiveKind forces a decision
		// here rather than silently defaulting one way in the sidebar indicator.
		const expected: Record<InteractiveKind, boolean> = {
			permission: true,
			auto_mode_switch: true,
			user_input: true,
			elicitation: true,
			exit_plan_mode: true,
			sampling: false,
			mcp_oauth: false,
			external_tool: false
		};
		for (const [kind, blocking] of Object.entries(expected) as Array<[InteractiveKind, boolean]>) {
			expect(isBlockingKind(kind)).toBe(blocking);
		}
	});

	it('defines default cancellations through the interactive-kind registry', () => {
		const expected: Record<InteractiveKind, InteractiveResponse> = {
			permission: { kind: 'permission', decision: 'deny' },
			auto_mode_switch: { kind: 'auto_mode_switch', decision: 'no' },
			user_input: { kind: 'user_input', answer: '', wasFreeform: true },
			elicitation: { kind: 'elicitation', action: 'cancel' },
			exit_plan_mode: { kind: 'exit_plan_mode', approved: false },
			sampling: { kind: 'sampling', action: 'ack' },
			mcp_oauth: { kind: 'mcp_oauth', action: 'ack' },
			external_tool: { kind: 'external_tool', action: 'ack' }
		};
		for (const [kind, response] of Object.entries(expected) as Array<
			[InteractiveKind, InteractiveResponse]
		>) {
			expect(defaultInteractiveResponse(kind)).toEqual(response);
		}
	});

	function makePending(
		kind: InteractiveKind,
		view: InteractiveRequestView,
		emit: ((ev: PortalEvent) => void) | undefined
	) {
		const requestId = view.requestId;
		let resolved: InteractiveResponse | null = null;
		let rejected: unknown = null;
		register({
			requestId,
			conversationId,
			kind,
			view,
			resolve: (r) => {
				resolved = r;
			},
			reject: (e) => {
				rejected = e;
			},
			emit,
			// Disable the default 10-minute timer so the test process can exit
			// cleanly without dangling timers.
			timeoutMs: 0
		});
		return {
			requestId,
			getResolved: () => resolved,
			getRejected: () => rejected
		};
	}

	function permView(requestId: string): InteractiveRequestView {
		return {
			requestId,
			kind: 'permission',
			tool: 'shell',
			permissionKind: 'shell',
			summary: 'ls',
			args: null
		};
	}

	it('resolve emits interactive.resolved before unblocking the SDK', () => {
		const events: Array<PortalEvent & { _resolvedAtEmit?: unknown }> = [];
		const requestId = newRequestId();
		const { getResolved } = makePending('permission', permView(requestId), (ev) => {
			events.push({ ...ev, _resolvedAtEmit: getResolved() });
		});

		expect(resolve(requestId, userId, { kind: 'permission', decision: 'allow-once' })).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: 'interactive.resolved',
			requestId,
			kind: 'permission',
			outcome: { kind: 'permission', decision: 'allow-once' }
		});
		expect(events[0]._resolvedAtEmit).toBeNull();
		expect(getResolved()).toEqual({ kind: 'permission', decision: 'allow-once' });
		expect(get(requestId)).toBeUndefined();
		expect(resolve(requestId, userId, { kind: 'permission', decision: 'allow-once' })).toBe(false);
	});

	it('rejects a response whose kind does not match the pending request', () => {
		const events: PortalEvent[] = [];
		const requestId = newRequestId();
		const { getResolved } = makePending('permission', permView(requestId), (ev) => events.push(ev));

		const ok = resolve(requestId, userId, {
			kind: 'auto_mode_switch',
			decision: 'yes'
		});
		expect(ok).toBe(false);
		expect(events).toHaveLength(0);
		expect(getResolved()).toBeNull();
		expect(get(requestId)).toBeDefined();
	});

	it('cancel rejects the deferred and emits a cancelled event with a neutral outcome', () => {
		const events: PortalEvent[] = [];
		const requestId = newRequestId();
		const view: InteractiveRequestView = {
			requestId,
			kind: 'auto_mode_switch',
			errorCode: 'rate_limited'
		};
		const { getResolved, getRejected } = makePending('auto_mode_switch', view, (ev) =>
			events.push(ev)
		);
		cancel(requestId, 'turn_aborted');
		// The event log still carries a neutral default outcome (for UI display)
		// plus the cancellation markers, so a replayed log can clear the dialog.
		expect(events[0]).toMatchObject({
			type: 'interactive.resolved',
			requestId,
			kind: 'auto_mode_switch',
			outcome: { kind: 'auto_mode_switch', decision: 'no' },
			cancelled: true,
			cancelReason: 'turn_aborted'
		});
		// The deferred is REJECTED, not resolved, so a waiting handler can tell
		// this apart from a genuine user denial.
		expect(getResolved()).toBeNull();
		expect(getRejected()).toBeInstanceOf(InteractivePromptCancelledError);
		expect((getRejected() as InteractivePromptCancelledError).reason).toBe('turn_aborted');
		expect(get(requestId)).toBeUndefined();
	});

	it('cancel audits a permission prompt as auto-cancelled, not auto-deny', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const requestId = newRequestId();
		const { getRejected } = makePending('permission', permView(requestId), undefined);
		cancel(requestId, 'turn_aborted');
		expect(getRejected()).toBeInstanceOf(InteractivePromptCancelledError);
		const recent = settings.listRecentDecisionsForUser(userId, 5);
		expect(recent[0].decision).toBe('auto-cancelled');
		expect(recent[0].tool).toBe('shell');
	});

	it('cancelConversation rejects every pending request for a conversation', () => {
		const a = newRequestId();
		const b = newRequestId();
		const aPending = makePending('permission', permView(a), undefined);
		const bPending = makePending(
			'exit_plan_mode',
			{
				requestId: b,
				kind: 'exit_plan_mode',
				summary: 'go?',
				actions: ['execute'],
				recommendedAction: 'execute'
			},
			undefined
		);
		cancelConversation(conversationId, 'turn_aborted');
		expect(aPending.getResolved()).toBeNull();
		expect(bPending.getResolved()).toBeNull();
		expect(aPending.getRejected()).toBeInstanceOf(InteractivePromptCancelledError);
		expect(bPending.getRejected()).toBeInstanceOf(InteractivePromptCancelledError);
		expect(get(a)).toBeUndefined();
		expect(get(b)).toBeUndefined();
	});

	it('hasPending reflects outstanding requests per conversation', () => {
		expect(hasPending(conversationId)).toBe(false);
		const requestId = newRequestId();
		const { getResolved } = makePending('permission', permView(requestId), undefined);
		expect(hasPending(conversationId)).toBe(true);
		expect(hasPending('some-other-conversation')).toBe(false);
		resolve(requestId, userId, { kind: 'permission', decision: 'allow-once' });
		expect(getResolved()).toEqual({ kind: 'permission', decision: 'allow-once' });
		expect(hasPending(conversationId)).toBe(false);
	});

	it('awaitingInputConversationIds flags blocking kinds only', () => {
		expect(awaitingInputConversationIds().has(conversationId)).toBe(false);

		// An info-only kind (auto-resolved by the SDK) must NOT flag the
		// conversation as awaiting user input.
		const infoId = newRequestId();
		makePending(
			'sampling',
			{ requestId: infoId, kind: 'sampling', summary: 'mcp sample' },
			undefined
		);
		expect(awaitingInputConversationIds().has(conversationId)).toBe(false);

		// A blocking kind flags it.
		const blockId = newRequestId();
		makePending('permission', permView(blockId), undefined);
		expect(awaitingInputConversationIds().has(conversationId)).toBe(true);
	});

	it('awaitingInputConversationIds dedupes multiple prompts per conversation and clears on resolve', () => {
		const a = newRequestId();
		const b = newRequestId();
		makePending('permission', permView(a), undefined);
		makePending(
			'user_input',
			{ requestId: b, kind: 'user_input', question: 'pick', allowFreeform: true },
			undefined
		);
		const awaiting = awaitingInputConversationIds();
		expect(awaiting.has(conversationId)).toBe(true);
		// Deduped: one conversation entry despite two outstanding prompts.
		expect([...awaiting].filter((id) => id === conversationId)).toHaveLength(1);

		// Still awaiting while one prompt remains.
		resolve(a, userId, { kind: 'permission', decision: 'allow-once' });
		expect(awaitingInputConversationIds().has(conversationId)).toBe(true);

		// Cleared once the last blocking prompt resolves.
		resolve(b, userId, { kind: 'user_input', answer: 'x', wasFreeform: true });
		expect(awaitingInputConversationIds().has(conversationId)).toBe(false);
	});

	it('awaitingInputConversationIds clears after cancel and expire', () => {
		const a = newRequestId();
		makePending('permission', permView(a), undefined);
		expect(awaitingInputConversationIds().has(conversationId)).toBe(true);
		cancel(a, 'turn_aborted');
		expect(awaitingInputConversationIds().has(conversationId)).toBe(false);

		const b = newRequestId();
		makePending('permission', permView(b), undefined);
		expect(awaitingInputConversationIds().has(conversationId)).toBe(true);
		expireConversation(conversationId, 'capacity_evict');
		expect(awaitingInputConversationIds().has(conversationId)).toBe(false);
	});

	it('expireConversation rejects prompts and audits them as auto-expired', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const events: PortalEvent[] = [];
		const requestId = newRequestId();
		const { getResolved, getRejected } = makePending('permission', permView(requestId), (ev) =>
			events.push(ev)
		);

		expireConversation(conversationId, 'capacity_evict');

		// The deferred is REJECTED (agent unblocks via the SDK's
		// `user-not-available` path) — distinct from a plain user deny.
		expect(getResolved()).toBeNull();
		expect(getRejected()).toBeInstanceOf(InteractivePromptCancelledError);
		expect(get(requestId)).toBeUndefined();
		expect(hasPending(conversationId)).toBe(false);

		// The resolved event marks it cancelled with the supplied reason and
		// carries the re-issue outcome for display.
		expect(events[0]).toMatchObject({
			type: 'interactive.resolved',
			requestId,
			kind: 'permission',
			cancelled: true,
			cancelReason: 'capacity_evict'
		});
		const outcome = (
			events[0] as { outcome?: { kind: string; decision: string; feedback?: string } }
		).outcome as { kind: string; decision: string; feedback?: string };
		expect(outcome.kind).toBe('permission');
		expect(outcome.decision).toBe('deny');
		expect(outcome.feedback ?? '').toMatch(/re-issue/i);

		// Audited as `auto-expired`, NOT `auto-deny`.
		const recent = settings.listRecentDecisionsForUser(userId, 5);
		expect(recent[0].decision).toBe('auto-expired');
		expect(recent[0].tool).toBe('shell');
	});

	it('expireConversation rejects non-permission kinds too', () => {
		const requestId = newRequestId();
		const { getResolved, getRejected } = makePending(
			'user_input',
			{ requestId, kind: 'user_input', question: 'pick', allowFreeform: true },
			undefined
		);
		expireConversation(conversationId, 'capacity_evict');
		expect(getResolved()).toBeNull();
		expect(getRejected()).toBeInstanceOf(InteractivePromptCancelledError);
		expect(get(requestId)).toBeUndefined();
	});

	it('an emit callback that throws does not break resolution', () => {
		const requestId = newRequestId();
		const { getResolved } = makePending('permission', permView(requestId), () => {
			throw new Error('boom');
		});
		expect(() =>
			resolve(requestId, userId, { kind: 'permission', decision: 'allow-once' })
		).not.toThrow();
		expect(getResolved()).toEqual({ kind: 'permission', decision: 'allow-once' });
	});

	it('allow-always installs a grant for the tool in the conversation', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		expect(settings.hasGrant(userId, conversationId, 'shell')).toBe(false);
		resolve(requestId, userId, { kind: 'permission', decision: 'allow-always' });
		expect(settings.hasGrant(userId, conversationId, 'shell')).toBe(true);
	});

	it('refuses to persist an allow-always grant when policy is deny-all', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.save(userId, {
			defaultProvider: 'copilot',
			defaultModel: null,
			defaultWorkdir: null,
			defaultConversationMode: 'interactive',
			defaultPolicy: 'deny-all',
			theme: 'dark',
			accent: 'default',
			defaultMemoryExtractorModel: null,
			defaultMemoryExtractorBackend: null,
			defaultContextTier: null
		});
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		resolve(requestId, userId, { kind: 'permission', decision: 'allow-always' });
		expect(settings.hasGrant(userId, conversationId, 'shell')).toBe(false);
	});

	it('lists recent permission decisions for the user', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		for (const decision of ['allow-once', 'deny', 'allow-always'] as const) {
			const requestId = newRequestId();
			makePending('permission', permView(requestId), undefined);
			resolve(requestId, userId, { kind: 'permission', decision });
		}
		const recent = settings.listRecentDecisionsForUser(userId, 10);
		expect(recent).toHaveLength(3);
		expect(recent[0].decision).toBe('allow-always');
		expect(recent[0].tool).toBe('shell');
		expect(recent[0].conversationId).toBe(conversationId);
	});

	it('matchGrant honors stored deny grants over allow grants', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId,
			conversationId,
			tool: 'shell'
		});
		settings.addGrant({
			userId,
			conversationId,
			tool: 'shell',
			permissionKind: 'shell',
			scopePattern: 'rm *',
			decision: 'deny'
		});
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'rm -rf /')).toBe('deny');
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls -la')).toBe('allow');
	});

	it('matchGrant skips expired grants', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId,
			conversationId,
			tool: 'shell',
			expiresAt: Date.now() - 1000
		});
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls')).toBe('none');
	});

	it('user-global grants apply across conversations', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const other = convs.create(userId, { title: 'other', workdir: '/tmp', model: null }).id;
		settings.addGrant({ userId, conversationId: null, tool: 'shell' });
		expect(settings.matchGrant(userId, other, 'shell', 'shell', 'anything')).toBe('allow');
	});

	it('deny-always writes a deny grant and rejects future matching requests', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		resolve(requestId, userId, {
			kind: 'permission',
			decision: 'deny-always',
			scope: { permissionKind: 'shell', pattern: 'rm *' }
		});
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'rm -rf /')).toBe('deny');
		// Unrelated commands still fall through.
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls')).toBe('none');
	});

	it('deny-always stores custom feedback as the deny grant reason and replays it in the resolution', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const events: PortalEvent[] = [];
		const requestId = newRequestId();
		makePending('permission', permView(requestId), (ev) => events.push(ev));
		resolve(requestId, userId, {
			kind: 'permission',
			decision: 'deny-always',
			scope: { permissionKind: 'shell', pattern: 'rm *' },
			feedback: 'Use structured file tools instead.'
		});

		expect(events[0]).toMatchObject({
			type: 'interactive.resolved',
			outcome: {
				kind: 'permission',
				decision: 'deny-always',
				feedback: 'Use structured file tools instead.'
			}
		});
		expect(
			settings.matchGrantDetailed(userId, conversationId, 'shell', 'shell', 'rm -rf /')
		).toEqual({
			outcome: 'deny',
			feedback: 'Use structured file tools instead.',
			denyReason: 'Use structured file tools instead.'
		});
	});

	it('allow-always with expiresInMs writes a TTL grant', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		resolve(requestId, userId, {
			kind: 'permission',
			decision: 'allow-always',
			expiresInMs: 60_000
		});
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls')).toBe('allow');
		expect(
			settings.matchGrant(userId, conversationId, 'shell', 'shell', 'ls', {}, Date.now() + 120_000)
		).toBe('none');
	});

	it('deny-always is allowed even when policy is deny-all', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.save(userId, {
			defaultProvider: 'copilot',
			defaultModel: null,
			defaultWorkdir: null,
			defaultConversationMode: 'interactive',
			defaultPolicy: 'deny-all',
			theme: 'dark',
			accent: 'default',
			defaultMemoryExtractorModel: null,
			defaultMemoryExtractorBackend: null,
			defaultContextTier: null
		});
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		resolve(requestId, userId, {
			kind: 'permission',
			decision: 'deny-always'
		});
		// Recording a deny grant under deny-all is fine — it's never less safe.
		expect(settings.matchGrant(userId, conversationId, 'shell', 'shell', 'x')).toBe('deny');
	});

	it('allow-always with applyToAllConversations writes a user-global grant', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const convsRepo = await import('../src/lib/server/db/repos/conversations');
		const other = convsRepo.create(userId, { title: 'other', workdir: '/tmp', model: null }).id;
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		resolve(requestId, userId, {
			kind: 'permission',
			decision: 'allow-always',
			applyToAllConversations: true
		});
		expect(settings.matchGrant(userId, other, 'shell', 'shell', 'whatever')).toBe('allow');
	});

	it('allow-always with a structured fs prefix scope persists and matches descendants', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'portal-fs-prefix-grant-')));
		try {
			mkdirSync(join(tmp, 'sub'));
			writeFileSync(join(tmp, 'sub', 'a.txt'), 'x');

			// Mimic the dialog: a `read` permission for `cat ~/.config/foo`
			// where the user picked "anywhere under this directory".
			const fsPermView: InteractiveRequestView = {
				requestId: newRequestId(),
				kind: 'permission',
				tool: 'cat',
				permissionKind: 'read',
				summary: join(tmp, 'sub', 'a.txt'),
				args: { path: join(tmp, 'sub', 'a.txt') }
			};
			makePending('permission', fsPermView, undefined);
			resolve(fsPermView.requestId, userId, {
				kind: 'permission',
				decision: 'allow-always',
				scope: {
					permissionKind: 'read',
					scope: {
						kind: 'fs',
						perms: ['read'],
						rule: { kind: 'path', root: 'absolute', behavior: 'prefix', value: tmp }
					}
				}
			});

			// Descendants match; sibling-with-shared-prefix and a path outside don't.
			const target = join(tmp, 'sub', 'a.txt');
			expect(settings.matchGrant(userId, conversationId, 'cat', 'read', target, { target })).toBe(
				'allow'
			);
			expect(
				settings.matchGrant(userId, conversationId, 'cat', 'read', '/etc/passwd', {
					target: '/etc/passwd'
				})
			).toBe('none');
			expect(
				settings.matchGrant(userId, conversationId, 'cat', 'read', `${tmp}-evil/file`, {
					target: `${tmp}-evil/file`
				})
			).toBe('none');
			// Write under the same prefix is NOT granted — perms filter restricts to read.
			expect(settings.matchGrant(userId, conversationId, 'cat', 'write', target, { target })).toBe(
				'none'
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('allow-always with additionalScopes persists each as its own grant', async () => {
		const settings = await import('../src/lib/server/db/repos/settings');
		const { parseShellCommand } = await import('../src/lib/server/permissions/shell-parser');
		const requestId = newRequestId();
		makePending('permission', permView(requestId), undefined);
		// Mimic the dialog's shell branch: the user ticked "any node" and
		// "any rg" on a `node --version | rg v` prompt and clicked Allow
		// always. The first scope rides in `scope`; the rest in
		// `additionalScopes`.
		resolve(requestId, userId, {
			kind: 'permission',
			decision: 'allow-always',
			scope: {
				permissionKind: 'shell',
				scope: {
					kind: 'shell',
					rule: { command: [{ token: 'node' }], positionals: { kind: 'any' } }
				}
			},
			additionalScopes: [
				{
					permissionKind: 'shell',
					scope: {
						kind: 'shell',
						rule: { command: [{ token: 'rg' }], positionals: { kind: 'any' } }
					}
				}
			]
		});

		// Each grant matches independently on its own argv0; exercise the
		// `rg` grant in a pipeline to verify per-segment matching.
		const nodeParsed = parseShellCommand('node --version');
		const rgParsed = parseShellCommand('node --version | rg v');
		const unrelated = parseShellCommand('curl https://example.com');
		if (nodeParsed.kind !== 'parsed') throw new Error('node parse');
		if (rgParsed.kind !== 'parsed') throw new Error('rg parse');
		if (unrelated.kind !== 'parsed') throw new Error('curl parse');

		expect(
			settings.matchGrant(userId, conversationId, 'shell', 'shell', 'node --version', {
				shellSegments: nodeParsed.segments
			})
		).toBe('allow');
		expect(
			settings.matchGrant(userId, conversationId, 'shell', 'shell', 'node --version | rg v', {
				shellSegments: rgParsed.segments
			})
		).toBe('allow');
		// A command covered by neither grant still falls through.
		expect(
			settings.matchGrant(userId, conversationId, 'shell', 'shell', 'curl https://example.com', {
				shellSegments: unrelated.segments
			})
		).toBe('none');
	});
});

describe('interactive permission adapter feedback', () => {
	let userId: string;
	let conversationId: string;

	beforeEach(async () => {
		await setupLocalEnv('portal-interactive-adapter-test-');
		userId = users.ensureLocalUser().id;
		conversationId = convs.create(userId, { title: 'adapter', workdir: '/tmp', model: null }).id;
	});

	function callbacks(
		events: PortalEvent[] = [],
		opts: {
			mode?: 'interactive' | 'best-effort';
			policy?: 'prompt' | 'allow-all' | 'deny-all';
		} = {}
	) {
		return createInteractiveCallbacks({
			conversationId,
			userId,
			workingDirectory: '/tmp',
			policy: opts.policy ?? 'prompt',
			emit: (ev) => events.push(ev),
			getApproveAll: () => false,
			getMode: () => opts.mode ?? 'interactive',
			getSessionWorkspacePath: () => null,
			getPermissionBehavior: () => 'normal'
		});
	}

	it('returns manual deny feedback to the SDK reject response', async () => {
		const events: PortalEvent[] = [];
		const permission = callbacks(events).onPermissionRequest({
			kind: 'url',
			toolName: 'web_fetch',
			url: 'https://example.com/',
			args: { url: 'https://example.com/' }
		});
		await Promise.resolve();
		const request = events.find((ev) => ev.type === 'interactive.request');
		if (request?.type !== 'interactive.request') throw new Error('expected interactive request');

		resolve(request.request.requestId, userId, {
			kind: 'permission',
			decision: 'deny',
			feedback: '  Use the structured tool instead.  '
		});

		await expect(permission).resolves.toEqual({
			kind: 'reject',
			feedback: 'Use the structured tool instead.'
		});
	});

	it('keeps a plain SDK reject when manual deny feedback is empty', async () => {
		const events: PortalEvent[] = [];
		const permission = callbacks(events).onPermissionRequest({
			kind: 'url',
			toolName: 'web_fetch',
			url: 'https://example.com/',
			args: { url: 'https://example.com/' }
		});
		await Promise.resolve();
		const request = events.find((ev) => ev.type === 'interactive.request');
		if (request?.type !== 'interactive.request') throw new Error('expected interactive request');

		resolve(request.request.requestId, userId, {
			kind: 'permission',
			decision: 'deny',
			feedback: '   '
		});

		await expect(permission).resolves.toEqual({ kind: 'reject' });
	});

	it('matching allow grants override prompt grants before policy auto-approval', async () => {
		settings.addGrant({
			userId,
			conversationId: null,
			tool: 'url_fetcher',
			permissionKind: 'url',
			scope: { kind: 'url', rule: { kind: 'host', host: 'example.com' } },
			decision: 'allow'
		});
		settings.addGrant({
			userId,
			conversationId: null,
			tool: 'url_fetcher',
			permissionKind: 'url',
			scope: { kind: 'url', rule: { kind: 'host', host: 'example.com' } },
			decision: 'prompt'
		});
		const events: PortalEvent[] = [];
		const permission = callbacks(events, { policy: 'allow-all' }).onPermissionRequest({
			kind: 'url',
			toolName: 'url_fetcher',
			url: 'https://example.com/',
			args: { url: 'https://example.com/' }
		});
		await Promise.resolve();
		expect(events.some((ev) => ev.type === 'interactive.request')).toBe(false);
		await expect(permission).resolves.toEqual({ kind: 'approve-once' });
		expect(settings.listRecentDecisionsForUser(userId, 5)[0]).toMatchObject({
			tool: 'url_fetcher',
			decision: 'auto-allow'
		});
	});

	it('matching prompt grants reject clearly in best-effort mode', async () => {
		settings.addGrant({
			userId,
			conversationId: null,
			tool: 'url_fetcher',
			permissionKind: 'url',
			scope: { kind: 'url', rule: { kind: 'host', host: 'example.com' } },
			decision: 'prompt'
		});

		await expect(
			callbacks([], { mode: 'best-effort', policy: 'allow-all' }).onPermissionRequest({
				kind: 'url',
				toolName: 'url_fetcher',
				url: 'https://example.com/',
				args: { url: 'https://example.com/' }
			})
		).resolves.toEqual(
			expect.objectContaining({
				kind: 'reject',
				feedback: expect.stringContaining('requires interactive approval')
			})
		);
	});
});
