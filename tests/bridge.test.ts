import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupLocalEnv, resetServerSingletons } from './helpers/env';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { appGlobalSymbols, clearGlobalSingletonValues } from '../src/lib/server/global-singleton';
import * as usersRepo from '../src/lib/server/db/repos/users';
import * as settingsRepo from '../src/lib/server/db/repos/settings';
import { PORTAL_SYSTEM_GUIDANCE } from '../src/lib/server/runtime/system-guidance';

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

// Spy on the structured logger so tests can assert on diagnostic log payloads
// (e.g. the redacted session.config line) without scraping stdout, which is
// unreliable under vitest's fork pool. Mocking it also silences the warn-level
// audit noise the bridge emits during these tests. Declared via vi.hoisted so
// the spies exist before the (hoisted) vi.mock factory and before the top-level
// repo imports below transitively evaluate the mocked log module.
const { logInfoSpy, logWarnSpy } = vi.hoisted(() => ({
	logInfoSpy: vi.fn(),
	logWarnSpy: vi.fn()
}));

vi.mock('../src/lib/server/log', () => ({
	log: {
		debug: vi.fn(),
		info: logInfoSpy,
		warn: logWarnSpy,
		error: vi.fn()
	}
}));

vi.mock('@github/copilot-sdk', () => {
	class CopilotClient {
		constructor(...args: unknown[]) {
			clientCtor(...args);
			return clientStub as unknown as CopilotClient;
		}
	}
	const RuntimeConnection = {
		forStdio: (opts?: { path?: string; args?: readonly string[] }) => ({
			kind: 'stdio' as const,
			...opts
		}),
		forTcp: (opts?: { port?: number; connectionToken?: string }) => ({
			kind: 'tcp' as const,
			...opts
		}),
		forUri: (url: string, opts?: { connectionToken?: string }) => ({
			kind: 'uri' as const,
			url,
			connectionToken: opts?.connectionToken
		})
	};
	return { CopilotClient, RuntimeConnection };
});

// Import after the mock is registered. The bridge module caches a
// CopilotClient per portal `userId`; we use vi.resetModules() between
// tests to force a fresh import (and a fresh `new CopilotClient(...)`
// call which still returns our stub).
async function importBridge() {
	vi.resetModules();
	clientCtor.mockClear();
	// copilot-provider stashes its per-user `clients`/`starting` maps on
	// globalThis (so Vite HMR re-imports don't orphan live subprocesses), and
	// those survive vi.resetModules(). Clear them here so each fresh import
	// starts with an empty client cache, matching this suite's isolation.
	clearGlobalSingletonValues(appGlobalSymbols('copilot-provider.clients'));
	clearGlobalSingletonValues(appGlobalSymbols('copilot-provider.starting'));
	return await import('../src/lib/server/copilot/copilot-provider');
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
	logInfoSpy.mockReset();
	logWarnSpy.mockReset();
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

	it('appends portal system guidance on both the create and resume paths', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();
		await open(baseOpts);
		expect(clientStub.createSession.mock.calls[0][0].systemMessage).toEqual({
			mode: 'append',
			content: PORTAL_SYSTEM_GUIDANCE
		});

		clientStub.createSession.mockClear();
		clientStub.getSessionMetadata.mockResolvedValue({ sessionId: 'conv-123' });
		const { open: openAgain } = await importBridge();
		await openAgain(baseOpts);
		expect(clientStub.resumeSession.mock.calls[0][1].systemMessage).toEqual({
			mode: 'append',
			content: PORTAL_SYSTEM_GUIDANCE
		});
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

describe('bridge.open() context tier', () => {
	it('omits contextTier by default (standard window)', async () => {
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.createSession.mock.calls[0][0]).not.toHaveProperty('contextTier');
	});

	it('pins contextTier to long_context when COPILOT_CONTEXT_TIER=long_context', async () => {
		process.env.COPILOT_CONTEXT_TIER = 'long_context';
		await resetServerSingletons();
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.createSession.mock.calls[0][0].contextTier).toBe('long_context');
	});

	it('forwards the long_context tier on the resume path too', async () => {
		process.env.COPILOT_CONTEXT_TIER = 'long_context';
		await resetServerSingletons();
		clientStub.getSessionMetadata.mockResolvedValue({ sessionId: 'conv-123' });
		const { open } = await importBridge();

		await open(baseOpts);

		expect(clientStub.resumeSession.mock.calls[0][1].contextTier).toBe('long_context');
	});

	it('logs a redacted session.config payload with contextTier and no auth token', async () => {
		process.env.COPILOT_CONTEXT_TIER = 'long_context';
		await resetServerSingletons();
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();

		await open({ ...baseOpts, providerAuthToken: 'super-secret-token' });

		const call = logInfoSpy.mock.calls.find((c) => c[0] === 'copilot.session.config');
		expect(call).toBeTruthy();
		const payload = call![1] as Record<string, unknown>;
		expect(payload.contextTier).toBe('long_context');
		expect(payload.path).toBe('create');
		expect((payload.handlers as Record<string, boolean>).onPermissionRequest).toBe(true);
		// The auth token lives on the client, never in the session payload —
		// guard against a future refactor leaking it into this diagnostic log.
		expect(JSON.stringify(payload)).not.toContain('super-secret-token');
	});

	it("uses the user's defaultContextTier over the server env default", async () => {
		// Env default is the standard tier; the per-user setting opts into 1M.
		const user = usersRepo.ensureLocalUser();
		settingsRepo.save(user.id, {
			...settingsRepo.defaults(),
			defaultContextTier: 'long_context'
		});
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();

		await open({ ...baseOpts, userId: user.id });

		expect(clientStub.createSession.mock.calls[0][0].contextTier).toBe('long_context');
	});

	it("lets a user's explicit default tier override a long_context server default", async () => {
		process.env.COPILOT_CONTEXT_TIER = 'long_context';
		await resetServerSingletons();
		const user = usersRepo.ensureLocalUser();
		settingsRepo.save(user.id, {
			...settingsRepo.defaults(),
			defaultContextTier: 'default'
		});
		clientStub.getSessionMetadata.mockResolvedValue(undefined);
		const { open } = await importBridge();

		await open({ ...baseOpts, userId: user.id });

		expect(clientStub.createSession.mock.calls[0][0]).not.toHaveProperty('contextTier');
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
		await open({ ...baseOpts, approvalMode: 'auto-deny' });

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

	it('omits tools for disabled portal groups', async () => {
		const { open } = await importBridge();
		await open({ ...baseOpts, disabledToolGroups: ['git', 'tickets'] });

		const tools = clientStub.createSession.mock.calls[0][0].tools as Array<{ name: string }>;
		const names = tools.map((t) => t.name);
		// Disabled groups drop out entirely...
		expect(names).not.toContain('git_status');
		expect(names).not.toContain('git_commit');
		expect(names).not.toContain('ticket_add');
		expect(names).not.toContain('ticket_list');
		// ...while other groups remain.
		expect(names).toContain('permission_capabilities');
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
		await open({ ...baseOpts, userId: user.id, approvalMode: 'auto-deny' });

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
				approvalMode: string;
				capabilities: Array<{
					permissionKind: string;
					status: string;
					allowed?: Array<{ summary: string }>;
				}>;
				escalation: {
					forceRetry: { supported: boolean; guidance: string };
					requestPermissionGrant: { supported: boolean; guidance: string };
				};
			};
		};
		expect(envelope.ok).toBe(true);
		const response = envelope.result;
		expect(response).toMatchObject({
			escalation: {
				forceRetry: {
					supported: true,
					guidance: expect.stringContaining('force_retry_tool')
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

	it('forwards the session mode to the runtime RPC verbatim', async () => {
		const { open } = await importBridge();
		const session = await open({ ...baseOpts, mode: 'autopilot' });

		await session.setMode('autopilot');

		expect(sdkSessionStub.rpc.mode.set).toHaveBeenCalledWith({ mode: 'autopilot' });
	});

	it('mirrors only the auto-approve approval mode into the runtime approve-all RPC', async () => {
		const { open } = await importBridge();
		const session = await open({ ...baseOpts, approvalMode: 'auto-deny' });

		// auto-deny is portal-side only: nothing is pushed at open.
		expect(sdkSessionStub.rpc.permissions.setApproveAll).not.toHaveBeenCalled();

		await session.setApprovalMode('auto-approve');
		expect(sdkSessionStub.rpc.permissions.setApproveAll).toHaveBeenCalledWith({ enabled: true });

		await session.setApprovalMode('ask');
		expect(sdkSessionStub.rpc.permissions.setApproveAll).toHaveBeenLastCalledWith({
			enabled: false
		});
	});

	// The two combinations `best-effort` made unreachable: it force-forwarded
	// autopilot to the runtime, so auto-deny could never coexist with plan or
	// interactive. On the split axes the runtime mode is untouched by the
	// approval mode, and vice versa.
	for (const mode of ['plan', 'interactive'] as const) {
		it(`combines ${mode} mode with the auto-deny approval mode`, async () => {
			const { open } = await importBridge();
			await open({ ...baseOpts, mode, approvalMode: 'auto-deny' });

			if (mode === 'interactive') {
				// interactive is the runtime default, so nothing is pushed.
				expect(sdkSessionStub.rpc.mode.set).not.toHaveBeenCalled();
			} else {
				expect(sdkSessionStub.rpc.mode.set).toHaveBeenCalledWith({ mode });
			}
			// auto-deny is never mirrored as an approve-all signal.
			expect(sdkSessionStub.rpc.permissions.setApproveAll).not.toHaveBeenCalled();

			const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
				req: unknown
			) => Promise<unknown>;
			const result = await onPermissionRequest({
				kind: 'url',
				toolName: 'web_fetch',
				url: 'https://example.com/docs',
				args: { url: 'https://example.com/docs' }
			});
			expect(result).toEqual(
				expect.objectContaining({
					kind: 'reject',
					feedback: expect.stringContaining('auto-deny')
				})
			);
		});
	}

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

		expect(result).toMatchObject({
			kind: 'reject',
			feedback: expect.stringContaining('force_retry_tool') as unknown as string
		});
	});

	it('auto-rejects prompt-worthy permission requests under auto-deny with concise feedback', async () => {
		const { open } = await importBridge();
		await open({ ...baseOpts, approvalMode: 'auto-deny' });

		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const result = await onPermissionRequest({
			kind: 'shell',
			toolName: 'shell',
			fullCommandText: "printf 'auto-deny demo\\n' > /tmp/copilot-auto-deny-demo.txt"
		});

		expect(result).toEqual(
			expect.objectContaining({
				kind: 'reject',
				feedback: expect.stringContaining('auto-deny')
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
				feedback: expect.stringContaining('force_retry_tool')
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
		expect(feedback).not.toContain("printf 'auto-deny demo\\n' > /tmp/copilot-auto-deny-demo.txt");
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
				expectedExtraHint: 'retry the denied fetch with `force_retry_tool`',
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
			expect(kindFeedback).toContain('force_retry_tool');
			expect(kindFeedback).toContain('after verifying no allowed alternative works');
			expect(kindFeedback).not.toContain(c.forbiddenDetail);
		}
	});

	it('uses prompt grant feedback when prompt-required matches under the auto-deny approval mode', async () => {
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
		await open({ ...baseOpts, userId: user.id, approvalMode: 'auto-deny' });

		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const result = await onPermissionRequest({
			kind: 'shell',
			toolName: 'shell',
			fullCommandText: 'node scripts/check.js',
			args: { command: 'node scripts/check.js' }
		});

		expect(result).toMatchObject({ kind: 'reject' });
		const resultFeedback = (result as { feedback: string }).feedback;
		expect(resultFeedback).toContain(feedback);
		expect(resultFeedback).toContain('force_retry_tool');
	});

	it('auto-rejects shell git commands with concise structured-tool feedback', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		await open({ ...baseOpts, userId: user.id, approvalMode: 'auto-deny' });

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

	it('denials carry a force_retry_tool token and hint through the bridge', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		await open({ ...baseOpts, userId: user.id, approvalMode: 'auto-deny' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;

		const result = await onPermissionRequest({
			kind: 'shell',
			toolName: 'shell',
			fullCommandText: 'git reflog expire --expire=now --all',
			args: { command: 'git reflog expire --expire=now --all' }
		});

		expect(result).toEqual(
			expect.objectContaining({
				kind: 'reject',
				feedback: expect.stringContaining('force_retry_tool')
			})
		);
		expect((result as { feedback: string }).feedback).toMatch(
			/force_retry_tool` with `token: "([0-9a-f]{24})"/
		);
	});

	it('force_retry_tool raises a human dialog for the exact denied call, and approval auto-allows the retry', async () => {
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
		const session = await open({ ...baseOpts, userId: user.id, approvalMode: 'auto-deny' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const tools = clientStub.createSession.mock.calls[0][0].tools as Array<{
			name: string;
			handler(args: unknown): Promise<{ resultType: string; detailedContent: string }>;
		}>;
		const forceRetryTool = tools.find((t) => t.name === 'force_retry_tool');
		expect(forceRetryTool).toBeTruthy();

		// First, the exact call is denied: it mints a one-shot token whose
		// feedback carries the hard-deny reason.
		const request = {
			kind: 'shell',
			toolName: 'shell',
			fullCommandText: 'rm -rf build',
			args: { command: 'rm -rf build' }
		};
		const denied = await onPermissionRequest(request);
		expect(denied).toMatchObject({ kind: 'reject' });
		const deniedFeedback = (denied as { feedback: string }).feedback;
		expect(deniedFeedback).toContain('rm is forbidden');
		const token = /force_retry_tool` with `token: "([0-9a-f]{24})"/.exec(deniedFeedback)?.[1];
		expect(token).toBeTruthy();

		// Second, `force_retry_tool` raises a fresh dialog for the exact call
		// carrying the escalation reason and the original deny reason.
		const reason =
			'There is no structured deletion tool available, and the user explicitly requested cleanup.';
		let escalation: Promise<{ resultType: string; detailedContent: string }> | null = null;
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			escalation = forceRetryTool!.handler({ token, reason });
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
		const view = (first.value as { request: { requestId: string } }).request;
		const resolved = interactive.resolve(view.requestId, user.id, {
			kind: 'permission',
			decision: 'allow-once'
		});
		expect(resolved).toBe(true);
		expect((await escalation!).resultType).toBe('success');
		ac.abort();

		// Third, the identical retry is auto-allowed so the SDK executes it
		// natively; the token is consumed one-shot.
		const retried = await onPermissionRequest(request);
		expect(retried).toEqual({ kind: 'approve-once' });
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
		await open({ ...baseOpts, userId: user.id, approvalMode: 'auto-deny' });
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

	it('force_retry_tool validates inputs and rejects unknown tokens through the bridge', async () => {
		const { open } = await importBridge();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		await open({ ...baseOpts, userId: user.id });
		const tools = clientStub.createSession.mock.calls[0][0].tools as Array<{
			name: string;
			handler(args: unknown): Promise<{ resultType: string; detailedContent: string }>;
		}>;
		const forceRetryTool = tools.find((t) => t.name === 'force_retry_tool');
		expect(forceRetryTool).toBeTruthy();
		const reason =
			'No structured alternative exists for this exact operation, so a human prompt is required.';

		const unknown = await forceRetryTool!.handler({ token: 'a'.repeat(24), reason });
		expect(unknown.resultType).toBe('failure');
		expect(JSON.parse(unknown.detailedContent).error.message).toContain('Unknown or expired');

		const invalidToken = await forceRetryTool!.handler({ token: 'not-a-token', reason });
		expect(invalidToken.resultType).toBe('failure');
		expect(JSON.parse(invalidToken.detailedContent).error.message).toContain(
			'must be the 24-hex-character token'
		);

		const short = await forceRetryTool!.handler({ token: 'a'.repeat(24), reason: 'short' });
		expect(short.resultType).toBe('failure');
		expect(JSON.parse(short.detailedContent).error.message).toContain('at least 20 characters');
	});

	it('shows useful git_commit details in the permission prompt', async () => {
		const { open } = await importBridge();
		const interactive = await import('../src/lib/server/runtime/interactive-requests');
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		const user = ensureLocalUser();
		const session = await open({ ...baseOpts, userId: user.id });
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

	it('matches a forced-retry approval against the persisted tool args via toolCallId', async () => {
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
		messages.insertToolCall(assistant.id, {
			id: 'git-commit-tool',
			tool: 'shell',
			argsJson: JSON.stringify({ command: 'git reflog expire --expire=now --all' }),
			resultJson: null,
			status: 'pending',
			startedAt: Date.now(),
			endedAt: null,
			textOffset: 0,
			parentToolCallId: null
		});
		const session = await open({ ...baseOpts, userId: user.id, approvalMode: 'auto-deny' });
		const onPermissionRequest = clientStub.createSession.mock.calls[0][0].onPermissionRequest as (
			req: unknown
		) => Promise<unknown>;
		const tools = clientStub.createSession.mock.calls[0][0].tools as Array<{
			name: string;
			handler(args: unknown): Promise<{ resultType: string }>;
		}>;
		const forceRetryTool = tools.find((t) => t.name === 'force_retry_tool');

		const request = {
			kind: 'shell',
			toolName: 'shell',
			toolCallId: 'git-commit-tool',
			fullCommandText: 'git reflog expire --expire=now --all',
			args: { command: 'git reflog expire --expire=now --all' }
		};
		const denied = await onPermissionRequest(request);
		expect(denied).toMatchObject({ kind: 'reject' });
		const token = /force_retry_tool` with `token: "([0-9a-f]{24})"/.exec(
			(denied as { feedback: string }).feedback
		)?.[1];
		expect(token).toBeTruthy();

		const reason =
			'This exact reflog cleanup is required, and no structured Git tool exposes expiration.';
		let escalation: Promise<{ resultType: string }> | null = null;
		sdkSessionStub.send.mockReset().mockImplementation(async () => {
			await Promise.resolve();
			escalation = forceRetryTool!.handler({ token, reason });
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
		const view = (first.value as { request: { requestId: string } }).request;
		interactive.resolve(view.requestId, user.id, { kind: 'permission', decision: 'allow-once' });
		expect((await escalation!).resultType).toBe('success');
		ac.abort();

		// The retried request re-derives the same args hash from the persisted
		// args and is auto-allowed one-shot.
		const retried = await onPermissionRequest(request);
		expect(retried).toEqual({ kind: 'approve-once' });
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

describe('bridge.open() remote CLI (COPILOT_CLI_URL) construction', () => {
	beforeEach(() => {
		delete process.env.COPILOT_CLI_URL;
		delete process.env.COPILOT_CONNECTION_TOKEN;
	});

	it('connects via RuntimeConnection.forUri with the COPILOT_CONNECTION_TOKEN', async () => {
		process.env.COPILOT_CLI_URL = '127.0.0.1:9000';
		process.env.COPILOT_CONNECTION_TOKEN = 'shared-handshake-secret';
		// Re-read config so the new env vars take effect.
		const { resetConfigForTests } = await import('../src/lib/server/config');
		resetConfigForTests();

		const { open } = await importBridge();
		await open(baseOpts);

		expect(clientCtor).toHaveBeenCalledTimes(1);
		const args = clientCtor.mock.calls[0][0] as {
			connection?: { kind?: string; url?: string; connectionToken?: string };
			gitHubToken?: string;
			useLoggedInUser?: boolean;
		};
		expect(args.connection?.kind).toBe('uri');
		expect(args.connection?.url).toBe('127.0.0.1:9000');
		expect(args.connection?.connectionToken).toBe('shared-handshake-secret');
		// URI mode must NOT pass gitHubToken/useLoggedInUser — the remote CLI
		// manages its own auth.
		expect(args.gitHubToken).toBeUndefined();
		expect(args.useLoggedInUser).toBeUndefined();
	});

	it('omits the connection token when COPILOT_CONNECTION_TOKEN is unset', async () => {
		process.env.COPILOT_CLI_URL = '127.0.0.1:9000';
		const { resetConfigForTests } = await import('../src/lib/server/config');
		resetConfigForTests();

		const { open } = await importBridge();
		await open(baseOpts);

		const args = clientCtor.mock.calls[0][0] as {
			connection?: { kind?: string; url?: string; connectionToken?: string };
		};
		expect(args.connection?.kind).toBe('uri');
		expect(args.connection?.url).toBe('127.0.0.1:9000');
		expect(args.connection?.connectionToken).toBeUndefined();
	});
});
