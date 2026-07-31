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
//   @trigger-git-commit-permission:<leaseId>
//                               -> onPermissionRequest fires for a git_commit
//                                  targeting that worktree lease
//   @trigger-auto-mode-switch   -> onAutoModeSwitchRequest fires
//   @trigger-user-input         -> onUserInputRequest fires
//   @trigger-elicitation        -> onElicitationRequest fires (simple form)
//   @trigger-exit-plan-mode     -> onExitPlanModeRequest fires
//   @trigger-sampling           -> emits sampling.requested + .completed
//   @trigger-mcp-oauth          -> emits mcp.oauth_required + _completed
//   @trigger-external-tool      -> emits external_tool.requested + .completed
//   @trigger-view-image         -> writes a PNG, fires a read permission for it,
//                                  then runs the native `view` tool over it so
//                                  the captured image attachment renders inline.
//                                  Add `-autoallow` to skip the permission
//                                  callback (mirrors the SDK auto-allowing an
//                                  in-workspace read), exercising the
//                                  execution_start direct-capture fallback.
//   @trigger-slow-start         -> delays the first delta so the pre-message
//                                  "thinking" state is observable by tests
//   @trigger-long-reasoning     -> emits one reasoning burst large enough to
//                                  exceed INLINE_REASONING_MAX_BYTES, so tests
//                                  can drive the conversation-open trim and the
//                                  lazy fetch that rehydrates it on expand

import { ulid } from 'ulid';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config';

// A minimal valid 1x1 PNG. Written to the working directory by the
// `@trigger-view-image` flow so the real interactive adapter can capture it as
// an image attachment (extension allowlist + magic-byte sniff both pass).
const TINY_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

type Listener = (e: unknown) => void;

interface StubHandlers {
	onPermissionRequest?: ((req: unknown) => Promise<unknown>) | undefined;
	onUserInputRequest?: ((req: unknown) => Promise<unknown>) | undefined;
	onElicitationRequest?: ((ctx: unknown) => Promise<unknown>) | undefined;
	onExitPlanModeRequest?: ((req: unknown) => Promise<unknown>) | undefined;
	onAutoModeSwitchRequest?: ((req: unknown) => Promise<unknown>) | undefined;
}

class StubSession {
	readonly sessionId: string;
	readonly model: string;
	private listeners = new Map<string, Set<Listener>>();
	private aborted = false;
	private handlers: StubHandlers;
	private readonly workingDirectory: string;
	// Staged `@trigger-view-image` lifecycle: the read permission (which lets
	// the adapter capture the image) fires up front, but the tool start/complete
	// events are emitted only after the assistant message has begun — matching
	// the real SDK ordering (tools render under an existing message bubble).
	private pendingViewImage: { toolCallId: string; imgPath: string } | null = null;

	constructor(sessionId: string, model: string, handlers: StubHandlers, workingDirectory: string) {
		this.sessionId = sessionId;
		this.model = model;
		this.handlers = handlers;
		this.workingDirectory = workingDirectory;
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
		// `@trigger-git-commit-permission:<leaseId>` raises the always-prompt
		// git_commit dialog for a commit that lands in a worktree, so a test can
		// assert the human is told WHERE it lands rather than just what it says.
		const commitInLease = /@trigger-git-commit-permission:([A-Za-z0-9]+)/.exec(prompt);
		if (commitInLease) {
			await this.handlers.onPermissionRequest?.({
				kind: 'custom',
				toolName: 'git_commit',
				args: {
					worktree: commitInLease[1],
					paths: 'all',
					subject: 'feature: sub-agent work'
				}
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
		if (prompt.includes('@trigger-view-image')) {
			// Mirror the real native `view`-on-an-image lifecycle. By default the
			// read permission fires now (exercising permission-time capture); the
			// `@trigger-view-image-autoallow` variant SKIPS the permission callback
			// to mirror the SDK auto-allowing an in-workspace read without invoking
			// us, exercising the execution_start direct-capture fallback. Either
			// way the tool start/complete events are deferred to `run()` until the
			// assistant message bubble exists, since the live client only attaches
			// tool calls to an existing message.
			const autoAllow = prompt.includes('@trigger-view-image-autoallow');
			const imgPath = join(this.workingDirectory, `view-image-${ulid()}.png`);
			try {
				writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, 'base64'));
			} catch {
				// best-effort; if the write fails the read simply captures nothing
			}
			const toolCallId = ulid();
			if (!autoAllow) {
				await this.handlers.onPermissionRequest?.({
					kind: 'read',
					path: imgPath,
					intention: 'view the screenshot',
					toolCallId
				});
			}
			this.pendingViewImage = { toolCallId, imgPath };
		}
	}

	private async runPendingViewImage() {
		const pending = this.pendingViewImage;
		if (!pending) return;
		this.pendingViewImage = null;
		this.emit('tool.execution_start', {
			toolCallId: pending.toolCallId,
			toolName: 'view',
			arguments: { path: pending.imgPath }
		});
		await new Promise((r) => setTimeout(r, 5));
		this.emit('tool.execution_complete', {
			toolCallId: pending.toolCallId,
			toolName: 'view',
			success: true,
			result: { content: `Viewed image ${pending.imgPath}` }
		});
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
		if (prompt.includes('@trigger-long-reasoning')) {
			// Comfortably over INLINE_REASONING_MAX_BYTES so the conversation-open
			// payload trims it. Split across deltas like the real SDK does.
			const burst = 'pondering the payload trim. '.repeat(40);
			for (const part of burst.match(/.{1,64}/g) ?? [burst]) {
				if (this.aborted) return;
				this.emit('assistant.reasoning_delta', { deltaContent: part });
				await new Promise((r) => setTimeout(r, 1));
			}
			if (this.aborted) return;
		}
		const chunks = reply.match(/.{1,16}/g) ?? [reply];
		for (let i = 0; i < chunks.length; i++) {
			if (this.aborted) return;
			this.emit('assistant.message_delta', { deltaContent: chunks[i] });
			await new Promise((r) => setTimeout(r, 5));
			// After the first chunk the client has an assistant bubble to attach
			// to, so emit any staged `view` tool lifecycle now (realistic ordering:
			// the model calls a tool partway through its response).
			if (i === 0 && this.pendingViewImage) {
				await this.runPendingViewImage();
				if (this.aborted) return;
			}
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
		const s = new StubSession(
			opts.sessionId ?? ulid(),
			opts.model,
			pickHandlers(opts),
			opts.workingDirectory ?? process.cwd()
		);
		this.sessions.set(s.sessionId, s);
		return s;
	}

	async resumeSession(sessionId: string, opts: StubSessionConfig) {
		let s = this.sessions.get(sessionId);
		if (!s) {
			s = new StubSession(
				sessionId,
				opts.model,
				pickHandlers(opts),
				opts.workingDirectory ?? process.cwd()
			);
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
