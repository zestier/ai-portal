import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Shared mock SDK client/session instances. These are mutated per test.
const sdkSessionStub = {
	on: vi.fn(),
	off: vi.fn(),
	send: vi.fn(),
	abort: vi.fn(),
	disconnect: vi.fn(),
	workspacePath: '/tmp/copilot-session-workspace',
	rpc: {
		mode: {
			set: vi.fn()
		},
		permissions: {
			setApproveAll: vi.fn(),
			resetSessionApprovals: vi.fn()
		}
	}
};

const clientStub = {
	start: vi.fn().mockResolvedValue(undefined),
	stop: vi.fn().mockResolvedValue(undefined),
	getAuthStatus: vi.fn(),
	listModels: vi.fn(),
	createSession: vi.fn().mockResolvedValue(sdkSessionStub),
	resumeSession: vi.fn().mockResolvedValue(sdkSessionStub),
	getSessionMetadata: vi.fn()
};

// Count how many times `new CopilotClient(...)` runs so tests can
// distinguish "one shared client" from "one per portal user". The mock
// constructor still returns the same `clientStub` instance — what we
// care about is how many distinct construction calls happened.
const clientCtor = vi.fn();

vi.mock('@github/copilot-sdk', () => {
	class CopilotClient {
		constructor(...args: unknown[]) {
			clientCtor(...args);
			return clientStub as unknown as CopilotClient;
		}
	}
	return { CopilotClient };
});

// Import after the mock is registered. The bridge module caches a
// CopilotClient per portal `userId`; we use vi.resetModules() between
// tests to force a fresh import (and a fresh `new CopilotClient(...)`
// call which still returns our stub).
async function importBridge() {
	vi.resetModules();
	clientCtor.mockClear();
	return await import('../src/lib/server/copilot/bridge');
}

const baseOpts = {
	conversationId: 'conv-123',
	userId: 'user-1',
	workingDirectory: '/tmp',
	model: 'gpt-4',
	policy: 'prompt' as const
};

beforeEach(async () => {
	// bridge.open() loads config (via bridge-stub.isStubMode → loadConfig)
	// so we need the same AUTH_MODE=none + HOST guards that real tests use.
	const dataDir = await setupLocalEnv('portal-bridge-test-');
	const sessionWorkspace = join(dataDir, 'session-workspace');
	mkdirSync(sessionWorkspace, { recursive: true });
	// Reset every stub so any test that re-implements one (e.g. the
	// usage_info test below mutates sdkSessionStub.send) can't leak its
	// implementation into the next test. Re-install default resolved
	// values for the methods bridge expects to be promise-returning.
	for (const fn of Object.values(clientStub)) fn.mockReset();
	for (const fn of [
		sdkSessionStub.on,
		sdkSessionStub.off,
		sdkSessionStub.send,
		sdkSessionStub.abort,
		sdkSessionStub.disconnect,
		sdkSessionStub.rpc.mode.set,
		sdkSessionStub.rpc.permissions.setApproveAll,
		sdkSessionStub.rpc.permissions.resetSessionApprovals
	])
		fn.mockReset();
	clientStub.start.mockResolvedValue(undefined);
	clientStub.stop.mockResolvedValue(undefined);
	clientStub.createSession.mockResolvedValue(sdkSessionStub);
	clientStub.resumeSession.mockResolvedValue(sdkSessionStub);
	clientStub.getAuthStatus.mockResolvedValue({ authenticated: true });
	clientStub.listModels.mockResolvedValue([]);
	clientStub.getSessionMetadata.mockResolvedValue(undefined);
	sdkSessionStub.workspacePath = sessionWorkspace;
	sdkSessionStub.abort.mockResolvedValue(undefined);
	sdkSessionStub.disconnect.mockResolvedValue(undefined);
	sdkSessionStub.rpc.mode.set.mockResolvedValue(undefined);
	sdkSessionStub.rpc.permissions.setApproveAll.mockResolvedValue({ success: true });
	sdkSessionStub.rpc.permissions.resetSessionApprovals.mockResolvedValue(undefined);
});

describe('bridge.open() session resume behavior', () => {
	it('creates a new SDK session when no prior metadata exists', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.getSessionMetadata).toHaveBeenCalledWith('conv-123');
		expect(clientStub.resumeSession).not.toHaveBeenCalled();
		expect(clientStub.createSession).toHaveBeenCalledTimes(1);
		const arg = clientStub.createSession.mock.calls[0][0];
		expect(arg.sessionId).toBe('conv-123');
		expect(arg.model).toBe('gpt-4');
		expect(arg.streaming).toBe(true);
	});

	it('resumes the SDK session when prior metadata exists', async () => {
		clientStub.getSessionMetadata.mockResolvedValue({ sessionId: 'conv-123' });
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.resumeSession).toHaveBeenCalledTimes(1);
		expect(clientStub.resumeSession.mock.calls[0][0]).toBe('conv-123');
		const cfg = clientStub.resumeSession.mock.calls[0][1];
		expect(cfg.model).toBe('gpt-4');
		expect(cfg.streaming).toBe(true);
		// resumeSession's config type does not accept sessionId; passing it
		// would be a type error and confuse the SDK.
		expect(cfg).not.toHaveProperty('sessionId');
		expect(clientStub.createSession).not.toHaveBeenCalled();
	});

	it('falls back to createSession when resumeSession throws', async () => {
		clientStub.getSessionMetadata.mockResolvedValue({ sessionId: 'conv-123' });
		clientStub.resumeSession.mockRejectedValueOnce(new Error('session gone'));
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.resumeSession).toHaveBeenCalledTimes(1);
		expect(clientStub.createSession).toHaveBeenCalledTimes(1);
		expect(clientStub.createSession.mock.calls[0][0].sessionId).toBe('conv-123');
	});

	it('falls back to createSession when getSessionMetadata throws', async () => {
		clientStub.getSessionMetadata.mockRejectedValueOnce(new Error('rpc failed'));
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.resumeSession).not.toHaveBeenCalled();
		expect(clientStub.createSession).toHaveBeenCalledTimes(1);
		expect(clientStub.createSession.mock.calls[0][0].sessionId).toBe('conv-123');
	});
});

describe('bridge.open() context-usage event translation', () => {
	it('subscribes to session.usage_info and compaction events', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();
		await open(baseOpts);

		const subscribed = sdkSessionStub.on.mock.calls.map((c) => c[0]);
		expect(subscribed).toEqual(
			expect.arrayContaining([
				'session.usage_info',
				'session.compaction_start',
				'session.compaction_complete'
			])
		);
	});

	it('translates session.usage_info into a context.usage PortalEvent during a turn', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		// `send()` is invoked inside the bridge's session.send wrapper. We
		// resolve it on a microtask so the bridge sets up its activeQueue
		// before we synthesize the SDK event.
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			// fire the SDK event after the bridge has installed its handlers
			// and activeQueue is set.
			await Promise.resolve();
			const handlers = new Map<string, (e: unknown) => void>(
				sdkSessionStub.on.mock.calls.map((c) => [c[0] as string, c[1] as (e: unknown) => void])
			);
			handlers.get('session.usage_info')?.({
				data: {
					currentTokens: 1234,
					tokenLimit: 100_000,
					messagesLength: 4,
					systemTokens: 700,
					conversationTokens: 500,
					toolDefinitionsTokens: 34,
					isInitial: true
				}
			});
			handlers.get('session.idle')?.({});
			return 'msg-id';
		});

		const { open } = await importBridge();
		const session = await open(baseOpts);
		const ac = new AbortController();
		const events: unknown[] = [];
		for await (const ev of session.send('hi', ac.signal)) {
			events.push(ev);
			if ((ev as { type: string }).type === 'done') break;
		}

		const usage = events.find((e) => (e as { type: string }).type === 'context.usage') as
			| { currentTokens: number; tokenLimit: number; isInitial?: boolean }
			| undefined;
		expect(usage).toBeTruthy();
		expect(usage!.currentTokens).toBe(1234);
		expect(usage!.tokenLimit).toBe(100_000);
		expect(usage!.isInitial).toBe(true);
	});
});

describe('bridge.open() session mode and permissions', () => {
	it('injects portal tools', async () => {
		const { open } = await importBridge();
		await open({ ...baseOpts, mode: 'best-effort' });

		const tools = clientStub.createSession.mock.calls[0][0].tools as Array<{
			name: string;
			description?: string;
		}>;
		expect(tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: 'git_status' }),
				expect.objectContaining({ name: 'git_diff' }),
				expect.objectContaining({ name: 'git_log' }),
				expect.objectContaining({ name: 'git_show_commit' }),
				expect.objectContaining({ name: 'git_show_file' }),
				expect.objectContaining({ name: 'ticket_add' }),
				expect.objectContaining({ name: 'ticket_list' }),
				expect.objectContaining({ name: 'ticket_get' }),
				expect.objectContaining({ name: 'ticket_update' }),
				expect.objectContaining({
					name: 'permission_capabilities',
					description: expect.stringContaining('allowed alternatives')
				})
			])
		);
	});

	it('permission_capabilities reports effective alternatives without raw grant internals', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const settings = await import('../src/lib/server/db/repos/settings');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const user = ensureLocalUser();
		convs.create(user.id, {
			id: baseOpts.conversationId,
			title: 'test',
			workdir: baseOpts.workingDirectory,
			model: baseOpts.model
		});
		settings.addGrant({
			userId: user.id,
			conversationId: null,
			tool: 'url_fetcher',
			permissionKind: 'url',
			scope: { kind: 'url', rule: { kind: 'host', host: 'api.example.test' } }
		});
		settings.addGrant({
			userId: user.id,
			conversationId: baseOpts.conversationId,
			tool: 'read',
			permissionKind: 'read',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'absolute', behavior: 'exact', value: '/secret/file.txt' }
			},
			decision: 'deny',
			denyReason: 'Do not expose this exact path in capability output.'
		});
		await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });

		const tools = clientStub.createSession.mock.calls[0][0].tools as Array<{
			name: string;
			handler(args: unknown): Promise<{ detailedContent: string }>;
		}>;
		const tool = tools.find((t) => t.name === 'permission_capabilities');
		expect(tool).toBeTruthy();

		// The SDK adapter returns a structured ToolResultObject; the full envelope
		// rides on `detailedContent` (the model gets concise `textResultForLlm`).
		const envelope = JSON.parse(
			(await tool!.handler({ permissionKind: 'url', toolName: 'url_fetcher' })).detailedContent
		) as {
			ok: boolean;
			result: {
				mode: string;
				bestEffort: boolean;
				capabilities: Array<{
					permissionKind: string;
					status: string;
					allowed?: Array<{ summary: string }>;
				}>;
				escalation: {
					forcePermissionPrompt: { supported: boolean; guidance: string };
				};
			};
		};
		expect(envelope.ok).toBe(true);
		const response = envelope.result;

		expect(response).toMatchObject({
			mode: 'best-effort',
			bestEffort: true,
			escalation: {
				forcePermissionPrompt: {
					supported: true,
					guidance: expect.stringContaining('after verifying no allowed alternative works')
				}
			}
		});
		expect(response.capabilities).toEqual([
			expect.objectContaining({
				permissionKind: 'url',
				status: 'allowed',
				allowed: [
					expect.objectContaining({
						summary: expect.stringContaining('api.example.test')
					})
				]
			})
		]);

		const readResult = await tool!.handler({ permissionKind: 'read' });
		const readResponseText = readResult.detailedContent;
		expect(readResponseText).not.toContain('/secret/file.txt');
		expect(readResponseText).not.toContain('Do not expose this exact path');
		expect(readResponseText).toContain('specific absolute exact rule');
	});

	it('maps best-effort mode to autopilot on the runtime RPC', async () => {
		const { open } = await importBridge();
		const session = await open({ ...baseOpts, mode: 'best-effort' });

		await session.setMode('best-effort');

		expect(sdkSessionStub.rpc.mode.set).toHaveBeenCalledWith({ mode: 'autopilot' });
	});

	it('auto-approves filesystem requests inside the SDK session workspace', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		await open({ ...baseOpts, userId: user.id, workingDirectory: '/workspace/project' });

		const planPath = join(sdkSessionStub.workspacePath, 'plan.md');
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const result = await onPermissionRequest({
			kind: 'write',
			path: planPath,
			args: { path: planPath }
		});

		expect(result).toEqual({ kind: 'approve-once' });
	});

	it('lets an explicit deny grant revoke SDK session workspace access', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const settings = await import('../src/lib/server/db/repos/settings');
		const user = ensureLocalUser();
		settings.addGrant({
			userId: user.id,
			conversationId: null,
			tool: 'write',
			permissionKind: 'write',
			scope: {
				kind: 'fs',
				perms: ['write'],
				rule: { kind: 'path', root: 'session-workspace', behavior: 'any' }
			},
			decision: 'deny'
		});
		await open({ ...baseOpts, userId: user.id, workingDirectory: '/workspace/project' });

		const planPath = join(sdkSessionStub.workspacePath, 'plan.md');
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const result = await onPermissionRequest({
			kind: 'write',
			path: planPath,
			args: { path: planPath }
		});

		expect(result).toEqual({ kind: 'reject' });
	});

	it('auto-rejects prompt-worthy permission requests in best-effort mode with concise feedback', async () => {
		const { open } = await importBridge();
		await open({ ...baseOpts, mode: 'best-effort' });

		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const result = await onPermissionRequest({
			kind: 'shell',
			toolName: 'shell',
			fullCommandText: "printf 'best-effort demo\\n' > /tmp/copilot-best-effort-demo.txt"
		});

		expect(result).toEqual(
			expect.objectContaining({
				kind: 'reject',
				feedback: expect.stringContaining('best-effort')
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				feedback: expect.stringContaining('A shell permission request was auto-rejected')
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				feedback: expect.stringContaining('Try a structured tool')
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				feedback: expect.stringContaining('forcePermissionPrompt')
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				feedback: expect.stringContaining('after verifying no allowed alternative works')
			})
		);
		expect(result).toEqual(
			expect.objectContaining({
				feedback: expect.stringContaining('permission_capabilities')
			})
		);
		const feedback = (result as { feedback: string }).feedback;
		expect(feedback).not.toContain('The user would have been asked to approve:');
		expect(feedback).not.toContain('shell (shell)');
		expect(feedback).not.toContain(
			"printf 'best-effort demo\\n' > /tmp/copilot-best-effort-demo.txt"
		);
		expect(feedback).not.toContain('Reason: redirection');

		const cases = [
			{
				request: { kind: 'read', toolName: 'view', path: '/var/private/read-secret.txt' },
				expectedKind: 'read',
				expectedHint: 'structured read/search tools',
				forbiddenDetail: '/var/private/read-secret.txt'
			},
			{
				request: {
					kind: 'write',
					toolName: 'create',
					path: '/var/private/write-secret.txt'
				},
				expectedKind: 'write',
				expectedHint: 'structured workspace edit/create workflow',
				forbiddenDetail: '/var/private/write-secret.txt'
			},
			{
				request: { kind: 'edit', toolName: 'edit', path: '/var/private/edit-secret.txt' },
				expectedKind: 'edit',
				expectedHint: 'structured workspace edit/create workflow',
				forbiddenDetail: '/var/private/edit-secret.txt'
			},
			{
				request: {
					kind: 'url',
					toolName: 'web_fetch',
					url: 'https://example.com/private-token'
				},
				expectedKind: 'url',
				expectedHint: 'local source or another non-network approach',
				expectedExtraHint: 'retry with `forcePermissionPrompt` instead of guessing',
				forbiddenDetail: 'https://example.com/private-token'
			}
		];

		for (const c of cases) {
			const kindResult = await onPermissionRequest(c.request);
			expect(kindResult).toEqual(
				expect.objectContaining({
					kind: 'reject',
					feedback: expect.stringContaining(
						`A ${c.expectedKind} permission request was auto-rejected`
					)
				})
			);
			const kindFeedback = (kindResult as { feedback: string }).feedback;
			expect(kindFeedback).toContain(c.expectedHint);
			if ('expectedExtraHint' in c) expect(kindFeedback).toContain(c.expectedExtraHint);
			expect(kindFeedback).toContain('permission_capabilities');
			expect(kindFeedback).toContain('forcePermissionPrompt');
			expect(kindFeedback).toContain('after verifying no allowed alternative works');
			expect(kindFeedback).not.toContain(c.forbiddenDetail);
		}
	});

	it('uses prompt grant feedback when prompt-required matches auto-deny in best-effort mode', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const settings = await import('../src/lib/server/db/repos/settings');
		const user = ensureLocalUser();
		const feedback = 'Node scripts require a human reviewer; use package scripts if available.';
		settings.addGrant({
			userId: user.id,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'node' }] } },
			decision: 'prompt',
			denyReason: feedback
		});
		await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });

		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const result = await onPermissionRequest({
			kind: 'shell',
			toolName: 'shell',
			fullCommandText: 'node scripts/check.js',
			args: { command: 'node scripts/check.js' }
		});

		expect(result).toEqual({ kind: 'reject', feedback });
	});

	it('auto-rejects shell git commands with concise structured-tool feedback', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });

		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const result = await onPermissionRequest({
			kind: 'shell',
			toolName: 'shell',
			fullCommandText: 'git status --short',
			args: { command: 'git status --short' }
		});

		expect(result).toEqual(
			expect.objectContaining({
				kind: 'reject',
				feedback: expect.stringContaining('Use git_status')
			})
		);
	});

	it('matches manual shell rerun approvals against the persisted tool args', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const messages = await import('../src/lib/server/db/repos/messages');
		const settings = await import('../src/lib/server/db/repos/settings');
		const { argsHash } = await import('../src/lib/server/tool-invocation');
		const user = ensureLocalUser();
		convs.create(user.id, {
			id: baseOpts.conversationId,
			title: 'rerun',
			workdir: baseOpts.workingDirectory,
			model: baseOpts.model
		});
		const msg = messages.append(baseOpts.conversationId, { role: 'assistant', content: '' });
		const args = {
			command: 'node -e "process.exit(7)"',
			description: 'Trigger harmless nonzero failure',
			mode: 'sync',
			initial_wait: 30
		};
		messages.insertToolCall(msg.id, {
			id: 'tc-rerun-shell',
			tool: 'bash',
			argsJson: JSON.stringify(args),
			resultJson: null,
			status: 'pending',
			startedAt: Date.now(),
			endedAt: null,
			textOffset: 0,
			parentToolCallId: null
		});
		settings.addGrant({
			userId: user.id,
			conversationId: baseOpts.conversationId,
			tool: 'shell',
			permissionKind: null,
			scopePattern: null,
			scope: null,
			decision: 'force-allow',
			argsHash: argsHash(args),
			expiresAt: Date.now() + 60_000
		});
		await open({ ...baseOpts, userId: user.id });

		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const result = await onPermissionRequest({
			kind: 'shell',
			toolName: 'shell',
			toolCallId: 'tc-rerun-shell',
			fullCommandText: 'node -e "process.exit(7)"',
			args: { command: 'node -e "process.exit(7)"' }
		});

		expect(result).toEqual({ kind: 'approve-once' });
	});

	it('raises a one-time prompt for shell git escalation even in best-effort mode', async () => {
		const { open } = await importBridge();
		const interactive = await import('../src/lib/server/runtime/interactive-requests');
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		const session = await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const reason =
			'Structured Git tools do not expose reflog expiration, and this exact command is needed for cleanup.';

		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			void onPermissionRequest({
				kind: 'shell',
				toolName: 'shell',
				fullCommandText: 'git reflog expire --expire=now --all',
				args: {
					command: 'git reflog expire --expire=now --all',
					forcePermissionPrompt: reason
				}
			});
			return 'msg-id';
		});

		const ac = new AbortController();
		const iter = session.send('hi', ac.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toMatchObject({
			type: 'interactive.request',
			request: {
				kind: 'permission',
				tool: 'shell',
				permissionKind: 'shell',
				canPersistDecision: false,
				escalationReason: reason,
				defaultDenyFeedback: expect.stringContaining('structured Git tool')
			}
		});
		ac.abort();
		interactive.cancelConversation(baseOpts.conversationId, 'test_cleanup');
	});

	it('raises a one-time prompt for URL escalation in best-effort mode', async () => {
		const { open } = await importBridge();
		const interactive = await import('../src/lib/server/runtime/interactive-requests');
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		const session = await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const reason =
			'External documentation is required to verify current API behavior; no local source can confirm it.';

		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			void onPermissionRequest({
				kind: 'url',
				toolName: 'web_fetch',
				url: 'https://example.com/docs',
				args: {
					url: 'https://example.com/docs',
					forcePermissionPrompt: reason
				}
			});
			return 'msg-id';
		});

		const ac = new AbortController();
		const iter = session.send('hi', ac.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toMatchObject({
			type: 'interactive.request',
			request: {
				kind: 'permission',
				tool: 'web_fetch',
				permissionKind: 'url',
				canPersistDecision: false,
				escalationReason: reason
			}
		});
		ac.abort();
		interactive.cancelConversation(baseOpts.conversationId, 'test_cleanup');
	});

	it('lets forcePermissionPrompt escalate hard deny grants to a human prompt', async () => {
		const { open } = await importBridge();
		const interactive = await import('../src/lib/server/runtime/interactive-requests');
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const settings = await import('../src/lib/server/db/repos/settings');
		const user = ensureLocalUser();
		settings.addGrant({
			userId: user.id,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'rm' }] } },
			decision: 'deny',
			denyReason: 'Hard deny: rm is forbidden in shell.'
		});
		const session = await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const reason =
			'There is no structured deletion tool available, and the user explicitly requested cleanup.';

		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			void onPermissionRequest({
				kind: 'shell',
				toolName: 'shell',
				fullCommandText: 'rm -rf build',
				args: {
					command: 'rm -rf build',
					forcePermissionPrompt: reason
				}
			});
			return 'msg-id';
		});

		const ac = new AbortController();
		const iter = session.send('hi', ac.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toMatchObject({
			type: 'interactive.request',
			request: {
				kind: 'permission',
				tool: 'shell',
				permissionKind: 'shell',
				canPersistDecision: false,
				escalationReason: reason,
				defaultDenyFeedback: expect.stringContaining('rm is forbidden')
			}
		});
		ac.abort();
		interactive.cancelConversation(baseOpts.conversationId, 'test_cleanup');
	});

	it('lets forcePermissionPrompt escalate prompt-required grants', async () => {
		const { open } = await importBridge();
		const interactive = await import('../src/lib/server/runtime/interactive-requests');
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const settings = await import('../src/lib/server/db/repos/settings');
		const user = ensureLocalUser();
		settings.addGrant({
			userId: user.id,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'node' }] } },
			decision: 'prompt',
			denyReason: 'Node shell commands require human approval.'
		});
		const session = await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const reason =
			'The repository has no package script for this exact diagnostic, so a one-off node command is required.';

		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			void onPermissionRequest({
				kind: 'shell',
				toolName: 'shell',
				fullCommandText: 'node scripts/diagnose.js',
				args: {
					command: 'node scripts/diagnose.js',
					forcePermissionPrompt: reason
				}
			});
			return 'msg-id';
		});

		const ac = new AbortController();
		const iter = session.send('hi', ac.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toMatchObject({
			type: 'interactive.request',
			request: {
				kind: 'permission',
				tool: 'shell',
				permissionKind: 'shell',
				canPersistDecision: false,
				escalationReason: reason
			}
		});
		ac.abort();
		interactive.cancelConversation(baseOpts.conversationId, 'test_cleanup');
	});

	it('auto-allows matching approve grants without prompting', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const settings = await import('../src/lib/server/db/repos/settings');
		const user = ensureLocalUser();
		settings.addGrant({
			userId: user.id,
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scope: { kind: 'shell', rule: { command: [{ token: 'node' }] } },
			decision: 'allow'
		});
		await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;

		const result = await onPermissionRequest({
			kind: 'shell',
			toolName: 'shell',
			fullCommandText: 'node --version',
			args: { command: 'node --version' }
		});

		expect(result).toEqual({ kind: 'approve-once' });
	});

	it('recognizes top-level forcePermissionPrompt for escalation', async () => {
		const { open } = await importBridge();
		const interactive = await import('../src/lib/server/runtime/interactive-requests');
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		const session = await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const reason =
			'Structured Git tools do not expose reflog expiration, and this exact command is needed for cleanup.';

		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			void onPermissionRequest({
				kind: 'shell',
				toolName: 'shell',
				fullCommandText: 'git reflog expire --expire=now --all',
				forcePermissionPrompt: reason,
				args: { command: 'git reflog expire --expire=now --all' }
			});
			return 'msg-id';
		});

		const ac = new AbortController();
		const iter = session.send('hi', ac.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toMatchObject({
			type: 'interactive.request',
			request: {
				kind: 'permission',
				tool: 'shell',
				permissionKind: 'shell',
				canPersistDecision: false,
				escalationReason: reason
			}
		});
		ac.abort();
		interactive.cancelConversation(baseOpts.conversationId, 'test_cleanup');
	});

	it('shows useful git_commit details in the permission prompt', async () => {
		const { open } = await importBridge();
		const interactive = await import('../src/lib/server/runtime/interactive-requests');
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		const session = await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;

		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			void onPermissionRequest({
				kind: 'custom-tool',
				toolName: 'git_commit',
				args: {
					paths: ['src/a.ts', 'src/b.ts'],
					subject: 'Add git commit tool',
					body: 'Details\nMore details',
					trailers: [{ token: 'Co-authored-by', value: 'Copilot <copilot@example.com>' }]
				}
			});
			return 'msg-id';
		});

		const ac = new AbortController();
		const iter = session.send('hi', ac.signal)[Symbol.asyncIterator]();
		const first = await iter.next();
		expect(first.value).toMatchObject({
			type: 'interactive.request',
			request: {
				kind: 'permission',
				tool: 'git_commit',
				permissionKind: 'custom-tool',
				canPersistDecision: false,
				summary: expect.stringContaining('Subject: Add git commit tool')
			}
		});
		const summary = (first.value as { request: { summary: string } }).request.summary;
		expect(summary).toContain('Target: 2 selected paths');
		expect(summary).toContain('- src/a.ts');
		expect(summary).toContain('Body: 2 lines');
		expect(summary).toContain('Trailers: 1 (Co-authored-by)');
		expect(summary).toContain('one-time only');
		ac.abort();
		interactive.cancelConversation(baseOpts.conversationId, 'test_cleanup');
	});

	it('rejects invalid forcePermissionPrompt values with syntax feedback', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;

		const cases = [
			{
				name: 'top-level boolean',
				request: {
					kind: 'shell',
					toolName: 'shell',
					fullCommandText: 'git status --short',
					forcePermissionPrompt: true,
					args: { command: 'git status --short' }
				}
			},
			{
				name: 'args object',
				request: {
					kind: 'shell',
					toolName: 'shell',
					fullCommandText: 'git status --short',
					args: { command: 'git status --short', forcePermissionPrompt: { reason: 'try anyway' } }
				}
			},
			{
				name: 'blank string',
				request: {
					kind: 'shell',
					toolName: 'shell',
					fullCommandText: 'git status --short',
					args: { command: 'git status --short', forcePermissionPrompt: '   ' }
				}
			},
			{
				name: 'too-short string',
				request: {
					kind: 'shell',
					toolName: 'shell',
					fullCommandText: 'git status --short',
					args: { command: 'git status --short', forcePermissionPrompt: 'too short' }
				}
			}
		];

		for (const c of cases) {
			const result = await onPermissionRequest(c.request);
			expect(result, c.name).toEqual({
				kind: 'reject',
				feedback:
					'`forcePermissionPrompt` must be a reason string of at least 20 characters explaining why no allowed alternative works.'
			});
		}
	});

	it('recognizes forcePermissionPrompt from persisted tool args via toolCallId', async () => {
		const { open } = await importBridge();
		const interactive = await import('../src/lib/server/runtime/interactive-requests');
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const messages = await import('../src/lib/server/db/repos/messages');
		const convs = await import('../src/lib/server/db/repos/conversations');
		const user = ensureLocalUser();
		const conv = convs.create(user.id, {
			id: baseOpts.conversationId,
			title: 'test',
			workdir: baseOpts.workingDirectory,
			model: baseOpts.model
		});
		const assistant = messages.append(conv.id, {
			role: 'assistant',
			content: '',
			status: 'streaming'
		});
		const reason =
			'Structured Git tools do not expose reflog expiration, and this exact command is needed for cleanup.';
		messages.insertToolCall(assistant.id, {
			id: 'git-commit-tool',
			tool: 'shell',
			argsJson: JSON.stringify({
				command: 'git reflog expire --expire=now --all',
				forcePermissionPrompt: reason
			}),
			resultJson: null,
			status: 'pending',
			startedAt: Date.now(),
			endedAt: null,
			textOffset: 0,
			parentToolCallId: null
		});
		const session = await open({ ...baseOpts, userId: user.id, mode: 'best-effort' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;

		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			void onPermissionRequest({
				kind: 'shell',
				toolName: 'shell',
				toolCallId: 'git-commit-tool',
				fullCommandText: 'git reflog expire --expire=now --all',
				args: { command: 'git reflog expire --expire=now --all' }
			});
			return 'msg-id';
		});

		const ac = new AbortController();
		const iter = session.send('hi', ac.signal)[Symbol.asyncIterator]();
		let seen: Awaited<ReturnType<typeof iter.next>> | null = null;
		for (let i = 0; i < 5; i++) {
			const next = await iter.next();
			if (next.value?.type === 'interactive.request') {
				seen = next;
				break;
			}
		}
		expect(seen?.value).toMatchObject({
			type: 'interactive.request',
			request: {
				kind: 'permission',
				tool: 'shell',
				permissionKind: 'shell',
				canPersistDecision: false,
				escalationReason: reason
			}
		});
		ac.abort();
		interactive.cancelConversation(baseOpts.conversationId, 'test_cleanup');
	});
});

describe('bridge.open() reasoning segmentation', () => {
	it('opens a new reasoning segment after a visible delta or tool call, and emits .end on close', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			const handlers = new Map<string, (e: unknown) => void>(
				sdkSessionStub.on.mock.calls.map((c) => [c[0] as string, c[1] as (e: unknown) => void])
			);
			// Reasoning -> tool -> reasoning -> delta -> reasoning -> idle.
			// Three distinct segments expected, each closed by .end.
			handlers.get('assistant.reasoning_delta')?.({ data: { deltaContent: 'think A' } });
			handlers.get('tool.execution_start')?.({
				data: { toolCallId: 't1', toolName: 'noop', arguments: {} }
			});
			handlers.get('tool.execution_complete')?.({
				data: { toolCallId: 't1', success: true, result: null }
			});
			handlers.get('assistant.reasoning_delta')?.({ data: { deltaContent: 'think B' } });
			handlers.get('assistant.message_delta')?.({ data: { deltaContent: 'hello' } });
			handlers.get('assistant.reasoning_delta')?.({ data: { deltaContent: 'think C' } });
			handlers.get('session.idle')?.({});
			return 'msg-id';
		});

		const { open } = await importBridge();
		const session = await open(baseOpts);
		const ac = new AbortController();
		const events: { type: string; segmentId?: string; text?: string; durationMs?: number }[] = [];
		for await (const ev of session.send('hi', ac.signal)) {
			events.push(ev as { type: string; segmentId?: string; text?: string; durationMs?: number });
			if (ev.type === 'done') break;
		}

		const reasonings = events.filter((e) => e.type === 'message.reasoning');
		const ends = events.filter((e) => e.type === 'message.reasoning.end');
		// Three contiguous reasoning bursts -> three unique segment ids.
		const segIds = Array.from(new Set(reasonings.map((r) => r.segmentId!)));
		expect(segIds.length).toBe(3);
		expect(reasonings.map((r) => r.text)).toEqual(['think A', 'think B', 'think C']);
		// Each closed segment emits a .end with a numeric duration.
		expect(ends.map((e) => e.segmentId)).toEqual(segIds);
		for (const e of ends) expect(typeof e.durationMs).toBe('number');

		// .end for segment 1 must precede tool.call; .end for segment 2 must
		// precede the first message.delta. Ordering is what powers the
		// interleaved render.
		const idx = (predicate: (e: { type: string; segmentId?: string }) => boolean) =>
			events.findIndex(predicate);
		const firstEndIdx = idx((e) => e.type === 'message.reasoning.end' && e.segmentId === segIds[0]);
		const toolCallIdx = idx((e) => e.type === 'tool.call');
		const secondEndIdx = idx(
			(e) => e.type === 'message.reasoning.end' && e.segmentId === segIds[1]
		);
		const firstDeltaIdx = idx((e) => e.type === 'message.delta');
		expect(firstEndIdx).toBeGreaterThanOrEqual(0);
		expect(firstEndIdx).toBeLessThan(toolCallIdx);
		expect(secondEndIdx).toBeGreaterThanOrEqual(0);
		expect(secondEndIdx).toBeLessThan(firstDeltaIdx);
	});
});

describe('bridge.open() tool live-streaming events', () => {
	it('forwards tool.execution_partial_result and tool.execution_progress as portal events', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			const handlers = new Map<string, (e: unknown) => void>(
				sdkSessionStub.on.mock.calls.map((c) => [c[0] as string, c[1] as (e: unknown) => void])
			);
			handlers.get('tool.execution_start')?.({
				data: { toolCallId: 't1', toolName: 'bash', arguments: { command: 'echo hi' } }
			});
			handlers.get('tool.execution_progress')?.({
				data: { toolCallId: 't1', progressMessage: 'Connecting…' }
			});
			handlers.get('tool.execution_partial_result')?.({
				data: { toolCallId: 't1', partialOutput: 'hi\n' }
			});
			handlers.get('tool.execution_partial_result')?.({
				data: { toolCallId: 't1', partialOutput: 'world\n' }
			});
			handlers.get('tool.execution_complete')?.({
				data: { toolCallId: 't1', success: true, result: { content: 'hi\nworld\n' } }
			});
			handlers.get('session.idle')?.({});
			return 'msg-id';
		});

		const { open } = await importBridge();
		const session = await open(baseOpts);
		const ac = new AbortController();
		const events: { type: string; toolCallId?: string; output?: string; message?: string }[] = [];
		for await (const ev of session.send('hi', ac.signal)) {
			events.push(ev as (typeof events)[number]);
			if (ev.type === 'done') break;
		}

		const partials = events.filter((e) => e.type === 'tool.partial_output');
		expect(partials.map((p) => p.output)).toEqual(['hi\n', 'world\n']);
		const progress = events.find((e) => e.type === 'tool.progress');
		expect(progress?.message).toBe('Connecting…');

		// Order: progress + partials must arrive between tool.call and tool.result.
		const callIdx = events.findIndex((e) => e.type === 'tool.call');
		const resultIdx = events.findIndex((e) => e.type === 'tool.result');
		const progressIdx = events.findIndex((e) => e.type === 'tool.progress');
		const firstPartialIdx = events.findIndex((e) => e.type === 'tool.partial_output');
		expect(callIdx).toBeGreaterThanOrEqual(0);
		expect(resultIdx).toBeGreaterThan(callIdx);
		expect(progressIdx).toBeGreaterThan(callIdx);
		expect(progressIdx).toBeLessThan(resultIdx);
		expect(firstPartialIdx).toBeGreaterThan(progressIdx);
		expect(firstPartialIdx).toBeLessThan(resultIdx);
	});

	it('drops empty partial_output and progress payloads', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			const handlers = new Map<string, (e: unknown) => void>(
				sdkSessionStub.on.mock.calls.map((c) => [c[0] as string, c[1] as (e: unknown) => void])
			);
			handlers.get('tool.execution_start')?.({
				data: { toolCallId: 't1', toolName: 'bash', arguments: {} }
			});
			handlers.get('tool.execution_partial_result')?.({
				data: { toolCallId: 't1', partialOutput: '' }
			});
			handlers.get('tool.execution_progress')?.({
				data: { toolCallId: 't1', progressMessage: '' }
			});
			handlers.get('tool.execution_complete')?.({
				data: { toolCallId: 't1', success: true, result: null }
			});
			handlers.get('session.idle')?.({});
			return 'msg-id';
		});

		const { open } = await importBridge();
		const session = await open(baseOpts);
		const ac = new AbortController();
		const events: { type: string }[] = [];
		for await (const ev of session.send('hi', ac.signal)) {
			events.push(ev as { type: string });
			if (ev.type === 'done') break;
		}
		expect(events.find((e) => e.type === 'tool.partial_output')).toBeUndefined();
		expect(events.find((e) => e.type === 'tool.progress')).toBeUndefined();
	});
});

describe('bridge.open() per-user CopilotClient caching', () => {
	it('reuses one CopilotClient when the same userId opens multiple sessions', async () => {
		const { open } = await importBridge();

		await open({ ...baseOpts, conversationId: 'conv-a', userId: 'alice' });
		await open({ ...baseOpts, conversationId: 'conv-b', userId: 'alice' });

		expect(clientCtor).toHaveBeenCalledTimes(1);
	});

	it('starts a separate CopilotClient for each distinct userId', async () => {
		const { open } = await importBridge();

		await open({
			...baseOpts,
			conversationId: 'conv-a',
			userId: 'alice',
			providerAuthToken: 'tok-A'
		});
		await open({
			...baseOpts,
			conversationId: 'conv-b',
			userId: 'bob',
			providerAuthToken: 'tok-B'
		});

		// One construction per portal user. This is the guard against the
		// "first-logged-in-user's token serves every other user" bug.
		expect(clientCtor).toHaveBeenCalledTimes(2);
		// Each construction sees that user's own token. The bridge wires
		// gitHubToken from opts.providerAuthToken, so we can assert the SDK was
		// handed the right credentials per user.
		const firstArgs = clientCtor.mock.calls[0][0] as { gitHubToken?: string };
		const secondArgs = clientCtor.mock.calls[1][0] as { gitHubToken?: string };
		expect(firstArgs.gitHubToken).toBe('tok-A');
		expect(secondArgs.gitHubToken).toBe('tok-B');
	});
});
