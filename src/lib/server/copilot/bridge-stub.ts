// In-process fake of the subset of `@github/copilot-sdk` we use, gated by the
// `COPILOT_STUB=1` env var. Lets e2e tests exercise the full turn-runner /
// SSE / persistence path without real Copilot credentials or network.
//
// Keep this faithful to the real SDK's event shape — see copilot-provider.ts
// and sdk-events.ts for the fields each event must carry.
//
// Test triggers: include any of the following tokens in the prompt to drive
// interactive flows from a Playwright test without a real Copilot CLI:
//   @trigger-permission         -> onPermissionRequest fires (shell tool)
//   @trigger-auto-mode-switch   -> onAutoModeSwitchRequest fires
//   @trigger-user-input         -> onUserInputRequest fires
//   @trigger-elicitation        -> onElicitationRequest fires (simple form)
//   @trigger-exit-plan-mode     -> onExitPlanModeRequest fires
//   @trigger-sampling           -> emits sampling.requested + .completed
//   @trigger-mcp-oauth          -> emits mcp.oauth_required + _completed
//   @trigger-external-tool      -> emits external_tool.requested + .completed
//   @trigger-slow-start         -> delays the first delta so the pre-message
//                                  "thinking" state is observable by tests

import { ulid } from 'ulid';
import { loadConfig } from '../config';

type Listener = (e: unknown) => void;

interface StubHandlers {
	onPermissionRequest?: (req: unknown) => Promise<unknown>;
	onUserInputRequest?: (req: unknown) => Promise<unknown>;
	onElicitationRequest?: (ctx: unknown) => Promise<unknown>;
	onExitPlanModeRequest?: (req: unknown) => Promise<unknown>;
	onAutoModeSwitchRequest?: (req: unknown) => Promise<unknown>;
}

class StubSession {
	readonly sessionId: string;
	readonly model: string;
	private listeners = new Map<string, Set<Listener>>();
	private aborted = false;
	private handlers: StubHandlers;

	constructor(sessionId: string, model: string, handlers: StubHandlers) {
		this.sessionId = sessionId;
		this.model = model;
		this.handlers = handlers;
	}

	setHandlers(handlers: StubHandlers) {
		this.handlers = handlers;
	}

	on(event: string, listener: Listener) {
		let set = this.listeners.get(event);
		if (!set) {
			set = new Set();
			this.listeners.set(event, set);
		}
		set.add(listener);
	}

	off(event: string, listener: Listener) {
		this.listeners.get(event)?.delete(listener);
	}

	private emit(event: string, data: unknown) {
		const set = this.listeners.get(event);
		if (!set) return;
		for (const l of set) {
			try {
				l({ data });
			} catch {
				// listeners should never throw in the real SDK either
			}
		}
	}

	async send(args: { prompt: string }): Promise<string> {
		this.aborted = false;
		const reply = `Stubbed reply to: ${args.prompt}`;
		queueMicrotask(() => void this.run(args.prompt, reply));
		return reply;
	}

	// Stub equivalents of the SDK's typed RPC surface used by copilot-provider.ts.
	// No-ops: the stub doesn't model the runtime's permission/mode state
	// machine, so all the bridge needs from us is "don't blow up".
	rpc = {
		mode: { set: async (_args: { mode: string }): Promise<void> => void _args },
		permissions: {
			setApproveAll: async (_args: { enabled: boolean }) => {
				void _args;
				return { success: true };
			},
			resetSessionApprovals: async (): Promise<void> => undefined
		}
	};

	private async fireTriggers(prompt: string) {
		// Run each trigger in sequence so the test sees deterministic order.
		if (prompt.includes('@trigger-permission')) {
			await this.handlers.onPermissionRequest?.({
				kind: 'shell',
				toolName: 'shell',
				// Pick a command that the default seed grants don't cover so
				// the dialog always renders. `npm` is not on the seed list,
				// so this exercises the real interactive path.
				fullCommandText: 'npm install left-pad'
			});
		}
		if (prompt.includes('@trigger-user-input')) {
			await this.handlers.onUserInputRequest?.({
				question: 'What name should I use?',
				allowFreeform: true
			});
		}
		if (prompt.includes('@trigger-elicitation')) {
			await this.handlers.onElicitationRequest?.({
				message: 'Please fill in the form.',
				mode: 'form',
				elicitationSource: 'stub-server',
				requestedSchema: {
					type: 'object',
					properties: {
						name: { type: 'string', title: 'Name' },
						count: { type: 'integer', title: 'Count', default: 1 }
					},
					required: ['name']
				}
			});
		}
		if (prompt.includes('@trigger-exit-plan-mode')) {
			await this.handlers.onExitPlanModeRequest?.({
				summary: 'Plan complete — ready to execute.',
				planContent: '- Step 1\n- Step 2',
				actions: ['execute', 'revise'],
				recommendedAction: 'execute'
			});
		}
		if (prompt.includes('@trigger-auto-mode-switch')) {
			await this.handlers.onAutoModeSwitchRequest?.({
				errorCode: 'rate_limited',
				retryAfterSeconds: 30
			});
		}
		if (prompt.includes('@trigger-sampling')) {
			const requestId = ulid();
			this.emit('sampling.requested', { requestId, serverName: 'stub-mcp' });
			await new Promise((r) => setTimeout(r, 20));
			this.emit('sampling.completed', { requestId });
		}
		if (prompt.includes('@trigger-mcp-oauth')) {
			const requestId = ulid();
			this.emit('mcp.oauth_required', {
				requestId,
				serverName: 'stub-mcp',
				serverUrl: 'https://example.invalid/oauth'
			});
			await new Promise((r) => setTimeout(r, 20));
			this.emit('mcp.oauth_completed', { requestId });
		}
		if (prompt.includes('@trigger-external-tool')) {
			const requestId = ulid();
			this.emit('external_tool.requested', {
				requestId,
				toolName: 'stub-external'
			});
			await new Promise((r) => setTimeout(r, 20));
			this.emit('external_tool.completed', { requestId });
		}
	}

	private async run(prompt: string, reply: string) {
		try {
			await this.fireTriggers(prompt);
		} catch {
			// triggers are best-effort
		}
		if (this.aborted) return;
		// Hold before the first delta so tests can observe the assistant turn
		// while it's still "thinking" (no content/tools/reasoning yet).
		if (prompt.includes('@trigger-slow-start')) {
			await new Promise((r) => setTimeout(r, 800));
			if (this.aborted) return;
		}
		const chunks = reply.match(/.{1,16}/g) ?? [reply];
		for (const chunk of chunks) {
			if (this.aborted) return;
			this.emit('assistant.message_delta', { deltaContent: chunk });
			await new Promise((r) => setTimeout(r, 5));
		}
		if (this.aborted) return;
		this.emit('assistant.message', { content: reply });
		this.emit('session.usage_info', {
			currentTokens: 100,
			tokenLimit: 200_000,
			messagesLength: 2,
			systemTokens: 50,
			conversationTokens: 50,
			toolDefinitionsTokens: 0,
			isInitial: false
		});
		this.emit('session.idle', {});
	}

	async abort() {
		this.aborted = true;
	}

	async disconnect() {
		this.listeners.clear();
	}
}

interface StubSessionConfig extends StubHandlers {
	model: string;
	sessionId?: string;
	streaming?: boolean;
	workingDirectory?: string;
}

function pickHandlers(opts: StubSessionConfig): StubHandlers {
	return {
		onPermissionRequest: opts.onPermissionRequest,
		onUserInputRequest: opts.onUserInputRequest,
		onElicitationRequest: opts.onElicitationRequest,
		onExitPlanModeRequest: opts.onExitPlanModeRequest,
		onAutoModeSwitchRequest: opts.onAutoModeSwitchRequest
	};
}

export class StubCopilotClient {
	private sessions = new Map<string, StubSession>();

	async start() {}
	async stop() {}

	async getAuthStatus() {
		return {
			status: 'authenticated' as const,
			user: { login: 'stub-user' }
		};
	}

	async listModels() {
		return [
			{
				id: 'stub-model',
				name: 'Stub Model',
				vendor: 'stub',
				preview: false,
				billing: { multiplier: 0, restrictedToPlans: [] }
			}
		];
	}

	async getSessionMetadata(sessionId: string) {
		return this.sessions.has(sessionId) ? { sessionId } : undefined;
	}

	async createSession(opts: StubSessionConfig) {
		const s = new StubSession(opts.sessionId ?? ulid(), opts.model, pickHandlers(opts));
		this.sessions.set(s.sessionId, s);
		return s;
	}

	async resumeSession(sessionId: string, opts: StubSessionConfig) {
		let s = this.sessions.get(sessionId);
		if (!s) {
			s = new StubSession(sessionId, opts.model, pickHandlers(opts));
			this.sessions.set(sessionId, s);
		} else {
			s.setHandlers(pickHandlers(opts));
		}
		return s;
	}
}

export function isStubMode(): boolean {
	return loadConfig().COPILOT_STUB;
}
