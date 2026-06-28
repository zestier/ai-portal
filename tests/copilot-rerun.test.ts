import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupLocalEnv } from './helpers/env';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { appGlobalSymbols, clearGlobalSingletonValues } from '../src/lib/server/global-singleton';

// A fake @github/copilot-sdk session whose `.on` records handlers and whose
// `.send` drives an `assistant.message_delta` + `session.idle` (the terminal
// the SDK event adapter turns into the portal `done`). This lets the REAL
// Copilot provider `openSession` run end-to-end without a live CLI subprocess.
function makeSdkSession(sessionId: string) {
	const handlers = new Map<string, (e: unknown) => void>();
	return {
		sessionId,
		on: vi.fn((event: string, handler: (e: unknown) => void) => {
			handlers.set(event, handler);
		}),
		off: vi.fn((event: string) => {
			handlers.delete(event);
		}),
		send: vi.fn(async () => {
			handlers.get('assistant.message_delta')?.({ text: 'hi' });
			handlers.get('session.idle')?.({});
			return '';
		}),
		abort: vi.fn().mockResolvedValue(undefined),
		disconnect: vi.fn().mockResolvedValue(undefined),
		workspacePath: '/tmp/copilot-session-workspace',
		rpc: {
			mode: { set: vi.fn().mockResolvedValue(undefined) },
			permissions: {
				setApproveAll: vi.fn().mockResolvedValue({ success: true }),
				resetSessionApprovals: vi.fn().mockResolvedValue(undefined)
			}
		}
	};
}

const sessionsById = new Map<string, ReturnType<typeof makeSdkSession>>();
// When set, the next createSession() rejects with this — used to simulate the
// Copilot CLI refusing to open the freshly-rotated rerun session.
let createSessionError: Error | null = null;

const clientStub = {
	start: vi.fn().mockResolvedValue(undefined),
	stop: vi.fn().mockResolvedValue(undefined),
	getAuthStatus: vi.fn().mockResolvedValue({ authenticated: true }),
	listModels: vi.fn().mockResolvedValue([]),
	createSession: vi.fn(async (cfg: { sessionId?: string }) => {
		if (createSessionError) throw createSessionError;
		const id = cfg.sessionId ?? 'gen';
		const s = makeSdkSession(id);
		sessionsById.set(id, s);
		return s;
	}),
	resumeSession: vi.fn(async (id: string) => {
		const s = sessionsById.get(id) ?? makeSdkSession(id);
		sessionsById.set(id, s);
		return s;
	}),
	// Mimic the real CLI: only ids this client created/resumed have metadata.
	// A freshly-rotated rerun id therefore takes the create path.
	getSessionMetadata: vi.fn(async (id: string) =>
		sessionsById.has(id) ? { sessionId: id } : undefined
	)
};

vi.mock('@github/copilot-sdk', () => {
	class CopilotClient {
		constructor() {
			return clientStub as unknown as CopilotClient;
		}
	}
	const RuntimeConnection = {
		forStdio: () => ({ kind: 'stdio' }),
		forUri: (url: string) => ({ kind: 'uri', url })
	};
	return { CopilotClient, RuntimeConnection };
});

async function freshImports() {
	vi.resetModules();
	clearGlobalSingletonValues(appGlobalSymbols('copilot-provider.clients'));
	clearGlobalSingletonValues(appGlobalSymbols('copilot-provider.starting'));
	clearGlobalSingletonValues(appGlobalSymbols('pool.sessions'));
	clearGlobalSingletonValues(appGlobalSymbols('pool.inflight'));
	const users = await import('../src/lib/server/db/repos/users');
	const convs = await import('../src/lib/server/db/repos/conversations');
	const messages = await import('../src/lib/server/db/repos/messages');
	const edit = await import('../src/lib/server/message-edit');
	const turnStart = await import('../src/lib/server/turn-start');
	return { users, convs, messages, edit, turnStart };
}

async function drain(turn: { subscribe: () => AsyncIterable<{ event: { type: string } }> }) {
	const events: { type: string; message?: string }[] = [];
	for await (const { event } of turn.subscribe()) {
		events.push(event);
		if (event.type === 'done') break;
	}
	return events;
}

type Repos = Awaited<ReturnType<typeof freshImports>>;

async function copilotConversationWithReply(repos: Repos) {
	const { users, convs, messages, turnStart } = repos;
	const u = users.ensureLocalUser();
	const conv = convs.create(u.id, {
		title: 'copilot',
		workdir: '/tmp',
		model: 'gpt-4',
		provider: 'copilot'
	});
	// First send creates the SDK session under conv.providerSessionId.
	const u1 = messages.append(conv.id, { role: 'user', content: 'first' });
	const t1 = await turnStart.startTurnFromUserMessage(conv, u1);
	await drain(t1);
	messages.append(conv.id, { role: 'assistant', content: 'reply' });
	return { u, conv, u1 };
}

describe('copilot rerun (inline edit / regenerate) provider path', () => {
	beforeEach(async () => {
		const dir = await setupLocalEnv('portal-copilot-rerun-');
		mkdirSync(join(dir, 'session-workspace'), { recursive: true });
		sessionsById.clear();
		createSessionError = null;
		for (const fn of Object.values(clientStub)) (fn as ReturnType<typeof vi.fn>).mockClear?.();
	});

	it('inline-edit rerun rotates to a fresh session id and streams a fresh reply', async () => {
		const repos = await freshImports();
		const { u, conv, u1 } = await copilotConversationWithReply(repos);
		const originalSessionId = repos.convs.get(conv.id, u.id)?.providerSessionId;

		const { conversation, userMessage } = repos.edit.inlineEditMessage({
			userId: u.id,
			conversationId: conv.id,
			messageId: u1.id,
			newContent: 'edited'
		});
		// The rerun must target a brand-new provider session id.
		expect(conversation.providerSessionId).not.toBe(originalSessionId);

		const turn = await repos.turnStart.startTurnFromUserMessage(conversation, userMessage, {
			includePriorMessages: true
		});
		const events = await drain(turn);

		expect(events.find((e) => e.type === 'error')).toBeUndefined();
		expect(events.some((e) => e.type === 'done')).toBe(true);
		// The fresh id was opened via createSession, not resumeSession.
		expect(clientStub.createSession).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: conversation.providerSessionId })
		);
	});

	it('regenerate rerun streams a fresh reply without an error', async () => {
		const repos = await freshImports();
		const { users, convs, messages, turnStart } = repos;
		const u = users.ensureLocalUser();
		const conv = convs.create(u.id, {
			title: 'copilot',
			workdir: '/tmp',
			model: 'gpt-4',
			provider: 'copilot'
		});
		const u1 = messages.append(conv.id, { role: 'user', content: 'q' });
		await drain(await turnStart.startTurnFromUserMessage(conv, u1));
		const a1 = messages.append(conv.id, { role: 'assistant', content: 'a' });

		const { conversation, userMessage } = repos.edit.regenerateFromAssistant({
			userId: u.id,
			conversationId: conv.id,
			messageId: a1.id
		});
		const turn = await turnStart.startTurnFromUserMessage(conversation, userMessage, {
			includePriorMessages: true
		});
		const events = await drain(turn);
		expect(events.find((e) => e.type === 'error')).toBeUndefined();
		expect(events.some((e) => e.type === 'done')).toBe(true);
	});

	it('surfaces a clear, conversation-scoped error when the fresh session fails to open', async () => {
		const repos = await freshImports();
		const { u, conv, u1 } = await copilotConversationWithReply(repos);

		// Simulate the CLI refusing to open the rotated rerun session.
		createSessionError = new Error('runtime connection lost');

		const { conversation, userMessage } = repos.edit.inlineEditMessage({
			userId: u.id,
			conversationId: conv.id,
			messageId: u1.id,
			newContent: 'edited'
		});
		const turn = await repos.turnStart.startTurnFromUserMessage(conversation, userMessage, {
			includePriorMessages: true
		});
		const events = await drain(turn);

		const errEvent = events.find((e) => e.type === 'error') as
			| { type: string; message?: string }
			| undefined;
		expect(errEvent).toBeDefined();
		// Not a raw, opaque SDK string: it names what failed and for which
		// conversation, and still includes the underlying reason.
		expect(errEvent?.message).toContain('GitHub Copilot session');
		expect(errEvent?.message).toContain(conv.id);
		expect(errEvent?.message).toContain('runtime connection lost');
	});
});
