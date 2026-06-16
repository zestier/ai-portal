// Copilot provider implementation around `@github/copilot-sdk`. Owns SDK
// client/session lifecycle; event normalization and interactive callbacks live
// in sibling adapters.
//
// NOTE: Pinned to @github/copilot-sdk ^1.0.0-beta. The SDK is in preview; if
// upgrading, audit this file plus sdk-events.ts / interactive-adapter.ts.

import { CopilotClient } from '@github/copilot-sdk';
import type { PortalEvent, SessionMode } from '$lib/types';
import { AsyncQueue } from '../runtime/async-queue';
import { createInteractiveCallbacks } from './interactive-adapter';
import { SdkEventAdapter, toRuntimeMode, type RuntimeSessionMode } from './sdk-events';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderSession
} from '../providers/provider';
import * as messagesRepo from '../db/repos/messages';
import * as tokens from '../db/repos/tokens';
import { loadConfig } from '../config';
import { log } from '../log';
import { StubCopilotClient, isStubMode } from './bridge-stub';
import { buildGitTools } from '../tools/git';
import { buildTicketTools } from '../tools/tickets';
import { buildPermissionTools } from '../tools/permissions';
import { buildMemoryTools } from '../tools/memory';
import { buildFilesystemTools } from '../tools/filesystem';
import { buildPermissionRequestResolver } from '../tools/types';
import { buildToolArgsValidator } from '../tools/schema-error';
import { wrapToolsForStreaming } from './tool-streaming';
import { ticketWorkspaceFromConversation } from '../ticket-workspace';
import { appGlobalSymbols, getOrCreateGlobalSingleton } from '../global-singleton';

// One CopilotClient per portal user. Sharing a single process-wide
// client would cause the SDK subprocess spawned for whichever user
// logged in first to handle every other user's turns too — which
// silently re-attributes Copilot API calls (billing, audit trail) to
// the wrong GitHub identity. With the documented multi-user allowlist
// (`ALLOWED_GITHUB_LOGINS`) that's a real cross-user bleed.
// Stashed on globalThis so Vite HMR re-imports of this module in dev don't
// orphan the live CopilotClient subprocesses in the old module's closure,
// which would let getClient() spawn duplicate clients. Same pattern as the
// session/inflight maps in pool.ts and the turn/pending registries.
const CLIENTS_KEYS = appGlobalSymbols('copilot-provider.clients');
const STARTING_KEYS = appGlobalSymbols('copilot-provider.starting');
const clients: Map<string, CopilotClient> = getOrCreateGlobalSingleton(
	CLIENTS_KEYS,
	() => new Map<string, CopilotClient>()
);
const starting: Map<string, Promise<CopilotClient>> = getOrCreateGlobalSingleton(
	STARTING_KEYS,
	() => new Map<string, Promise<CopilotClient>>()
);

export async function getClient(
	userId: string,
	providerAuthToken?: string
): Promise<CopilotClient> {
	const existing = clients.get(userId);
	if (existing) return existing;
	const inflight = starting.get(userId);
	if (inflight) return inflight;
	const p = (async () => {
		const cliUrl = process.env.COPILOT_CLI_URL?.trim();
		// Forward the configured connection token to a token-protected remote
		// CLI. The SDK's `connect` handshake sends `tcpConnectionToken`; for
		// `cliUrl` connections it does NOT fall back to the
		// COPILOT_CONNECTION_TOKEN environment variable, so without this the
		// handshake authenticates as `undefined` and the server rejects it.
		const connectionToken = cliUrl ? loadConfig().COPILOT_CONNECTION_TOKEN : undefined;
		const client = isStubMode()
			? (new StubCopilotClient() as unknown as CopilotClient)
			: cliUrl
				? new CopilotClient({
						cliUrl,
						autoStart: false,
						...(connectionToken ? { tcpConnectionToken: connectionToken } : {})
					})
				: new CopilotClient({
						useStdio: true,
						autoStart: false,
						useLoggedInUser: true,
						gitHubToken: providerAuthToken
					});
		await client.start();
		clients.set(userId, client);
		log.info('copilot.client.started', { userId });
		return client;
	})();
	starting.set(userId, p);
	try {
		return await p;
	} finally {
		starting.delete(userId);
	}
}

export async function shutdownClient() {
	const all = [...clients.values()];
	clients.clear();
	starting.clear();
	for (const c of all) {
		try {
			await c.stop();
		} catch (e) {
			log.warn('copilot.client.stop_failed', { err: String(e) });
		}
	}
}

// Per-user listModels cache: entitlements (and therefore the list of
// available models) can differ between users.
const modelsCache = new Map<string, { at: number; models: ProviderModelInfo[] }>();
const MODELS_TTL_MS = 5 * 60_000;

export async function fetchAuthStatus(
	userId: string,
	providerAuthToken?: string
): Promise<ProviderAuthStatus> {
	const client = await getClient(userId, providerAuthToken);
	return client.getAuthStatus();
}

export async function fetchModels(
	userId: string,
	providerAuthToken?: string
): Promise<ProviderModelInfo[]> {
	const cached = modelsCache.get(userId);
	if (cached && Date.now() - cached.at < MODELS_TTL_MS) {
		return cached.models;
	}
	const client = await getClient(userId, providerAuthToken);
	const models = await client.listModels();
	modelsCache.set(userId, { at: Date.now(), models });
	return models;
}

export type BridgeOpenOptions = ProviderOpenOptions;
export type ConversationSession = ProviderSession &
	Required<Pick<ProviderSession, 'setMode' | 'setApproveAll' | 'resetSessionApprovals'>>;

interface SdkSession {
	on(event: string, listener: (e: unknown) => void): void;
	off?(event: string, listener: (e: unknown) => void): void;
	send(args: { prompt: string }): Promise<string>;
	abort?(): Promise<void>;
	disconnect(): Promise<void>;
	/** SDK-provided infinite-session workspace (e.g. ~/.copilot/session-state/<id>). */
	workspacePath?: string;
	/** Public typed RPC surface exposed by the SDK's CopilotSession. We
	 * narrow it to just the methods we touch so a preview-version drift
	 * surfaces as a compile error here rather than a runtime mystery. */
	rpc?: {
		mode?: {
			set?: (params: { mode: RuntimeSessionMode }) => Promise<void>;
		};
		permissions?: {
			setApproveAll?: (params: { enabled: boolean }) => Promise<{ success: boolean }>;
			resetSessionApprovals?: () => Promise<unknown>;
		};
	};
}

export async function open(opts: BridgeOpenOptions): Promise<ConversationSession> {
	const client = await getClient(opts.userId, opts.providerAuthToken);
	const providerSessionId = opts.providerSessionId ?? opts.conversationId;

	let activeQueue: AsyncQueue<PortalEvent> | null = null;

	function emit(ev: PortalEvent) {
		activeQueue?.push(ev);
	}

	// Mutable session-level state. Mirrors the conversation row in the
	// DB; the /session PATCH endpoint flips these via setMode/setApproveAll
	// on the live ConversationSession so a turn already in flight picks up
	// the change without a recreate.
	let approveAllTools = opts.approveAllTools === true;
	let currentMode: SessionMode = opts.mode ?? 'interactive';
	let sessionWorkspacePath: string | null = null;
	// Abort signal for the in-flight turn, set at the start of each `send` and
	// cleared when it ends. Custom tool handlers' streaming context mirrors this
	// so a cancelled turn stops their incremental emission.
	let currentTurnSignal: AbortSignal | null = null;
	const toolPermissionBehavior = new Map<string, 'normal' | 'always-prompt' | 'never-prompt'>();

	const eventAdapter = new SdkEventAdapter({
		conversationId: opts.conversationId,
		getQueue: () => activeQueue,
		setQueue: (q) => {
			activeQueue = q;
		},
		getMode: () => currentMode,
		setMode: (mode) => {
			currentMode = mode;
		},
		onSubagentLifecycle: (ev) => {
			messagesRepo.updateBackgroundAgentLifecycle(ev.toolCallId, ev.agentId, ev.status);
		}
	});
	const portalTools = [
		...buildGitTools(opts.workingDirectory),
		...buildFilesystemTools(opts.workingDirectory),
		...buildTicketTools({
			userId: opts.userId,
			workspaceKey: ticketWorkspaceFromConversation(opts.workingDirectory),
			conversationId: opts.conversationId
		}),
		...buildPermissionTools({
			userId: opts.userId,
			conversationId: opts.conversationId,
			policy: opts.policy,
			getMode: () => currentMode
		}),
		...buildMemoryTools({
			userId: opts.userId,
			conversationId: opts.conversationId,
			mode: opts.memoryMode ?? 'off',
			globalMemoryEnabled: opts.globalMemoryEnabled === true
		})
	];
	const validateCustomToolArgs = buildToolArgsValidator(portalTools);
	const derivePermissionRequest = buildPermissionRequestResolver(portalTools);
	const {
		onPermissionRequest,
		onUserInputRequest,
		onElicitationRequest,
		onExitPlanMode,
		onAutoModeSwitch
	} = createInteractiveCallbacks({
		conversationId: opts.conversationId,
		userId: opts.userId,
		workingDirectory: opts.workingDirectory,
		policy: opts.policy,
		emit,
		getApproveAll: () => approveAllTools,
		getMode: () => currentMode,
		getSessionWorkspacePath: () => sessionWorkspacePath,
		getPermissionBehavior: (tool) => toolPermissionBehavior.get(tool) ?? 'normal',
		validateCustomToolArgs,
		derivePermissionRequest
	});

	let existingMetadata: unknown;
	try {
		existingMetadata = await client.getSessionMetadata(providerSessionId);
	} catch (e) {
		log.warn('copilot.session.metadata_lookup_failed', {
			conversationId: opts.conversationId,
			providerSessionId,
			err: (e as Error).message
		});
	}

	// Wrap each portal tool's handler so the SDK runtime — which invokes handlers
	// with its own `ToolInvocation` (no streaming channel) — still lets custom
	// tools stream. See `tool-streaming.ts`. `portalTools` is still used directly
	// below for permission registration and arg validation.
	const sessionConfig = {
		model: opts.model,
		workingDirectory: opts.workingDirectory,
		streaming: true,
		tools: wrapToolsForStreaming(portalTools, emit, () => currentTurnSignal),
		onPermissionRequest,
		onUserInputRequest,
		onElicitationRequest,
		onExitPlanMode,
		onAutoModeSwitch
	};
	for (const tool of portalTools) {
		if (
			tool.permissionBehavior === 'always-prompt' ||
			tool.permissionBehavior === 'normal' ||
			tool.permissionBehavior === 'never-prompt'
		) {
			toolPermissionBehavior.set(tool.name, tool.permissionBehavior);
		}
	}

	let sdkSession: SdkSession;
	if (existingMetadata) {
		try {
			sdkSession = (await client.resumeSession(
				providerSessionId,
				sessionConfig
			)) as unknown as SdkSession;
		} catch (e) {
			log.warn('copilot.session.resume_failed_falling_back_to_create', {
				conversationId: opts.conversationId,
				providerSessionId,
				err: (e as Error).message
			});
			sdkSession = (await client.createSession({
				...sessionConfig,
				sessionId: providerSessionId
			})) as unknown as SdkSession;
		}
	} else {
		sdkSession = (await client.createSession({
			...sessionConfig,
			sessionId: providerSessionId
		})) as unknown as SdkSession;
	}
	sessionWorkspacePath = normalizeSessionWorkspacePath(sdkSession.workspacePath);

	eventAdapter.attach(sdkSession);

	// Push initial mode + approve-all to the runtime. Best-effort: the
	// `rpc` surface is preview API and may be missing on stub clients;
	// skipping the call is fine because the bridge enforces approve-all
	// itself in `onPermissionRequest`, and a missing mode RPC just means
	// the agent runs in its default mode (still safe).
	async function applyMode(mode: SessionMode): Promise<void> {
		const runtimeMode = toRuntimeMode(mode);
		try {
			await sdkSession.rpc?.mode?.set?.({ mode: runtimeMode });
			currentMode = mode;
		} catch (e) {
			log.warn('copilot.session.mode_set_failed', {
				conversationId: opts.conversationId,
				mode,
				runtimeMode,
				err: (e as Error).message
			});
		}
	}
	async function applyApproveAll(enabled: boolean): Promise<void> {
		approveAllTools = enabled;
		try {
			await sdkSession.rpc?.permissions?.setApproveAll?.({ enabled });
		} catch (e) {
			log.warn('copilot.session.set_approve_all_failed', {
				conversationId: opts.conversationId,
				enabled,
				err: (e as Error).message
			});
		}
	}
	// Await initialization before returning so the first turn cannot call
	// `session.send()` before `rpc.mode.set` / `setApproveAll` complete and
	// run in the wrong mode. Both helpers swallow their own errors (best-effort
	// via log.warn), so awaiting here does not change open()'s error semantics.
	if (currentMode !== 'interactive') await applyMode(currentMode);
	if (approveAllTools) await applyApproveAll(true);

	const session: ConversationSession = {
		provider: 'copilot',
		conversationId: opts.conversationId,
		providerSessionId,
		workingDirectory: opts.workingDirectory,
		model: opts.model,
		lastUsed: Date.now(),
		async *send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent> {
			if (activeQueue) throw new Error('session busy: a turn is already in progress');
			const q = new AsyncQueue<PortalEvent>();
			activeQueue = q;
			currentTurnSignal = signal;
			eventAdapter.resetTurn();
			const onAbort = () => {
				q.push({ type: 'error', code: 'aborted', message: 'Aborted by client.' });
				q.end();
				if (sdkSession.abort) sdkSession.abort().catch(() => undefined);
			};
			signal.addEventListener('abort', onAbort, { once: true });

			try {
				await sdkSession.send({ prompt });
			} catch (err) {
				q.push({
					type: 'error',
					code: 'send_failed',
					message: err instanceof Error ? err.message : String(err)
				});
				q.end();
			}
			try {
				for await (const ev of q) {
					opts.onEvent?.(ev);
					yield ev;
				}
			} finally {
				signal.removeEventListener('abort', onAbort);
				if (activeQueue === q) activeQueue = null;
				if (currentTurnSignal === signal) currentTurnSignal = null;
				this.lastUsed = Date.now();
			}
		},
		async abort() {
			if (sdkSession.abort) await sdkSession.abort();
		},
		async setMode(mode: SessionMode) {
			await applyMode(mode);
		},
		async setApproveAll(enabled: boolean) {
			await applyApproveAll(enabled);
		},
		async resetSessionApprovals() {
			try {
				await sdkSession.rpc?.permissions?.resetSessionApprovals?.();
			} catch (e) {
				log.warn('copilot.session.reset_session_approvals_failed', {
					conversationId: opts.conversationId,
					err: (e as Error).message
				});
			}
		},
		async dispose() {
			eventAdapter.detach();
			try {
				await sdkSession.disconnect();
			} catch (e) {
				log.warn('copilot.session.disconnect_failed', {
					conversationId: opts.conversationId,
					err: String(e)
				});
			}
		}
	};

	return session;
}

export const copilotProvider: ModelBackendProvider = {
	id: 'copilot',
	displayName: 'GitHub Copilot',
	ui: {
		chatPlaceholder: 'Message GitHub Copilot...',
		defaultModelPlaceholder: 'claude-sonnet-4.5',
		setupHint:
			'Run `copilot auth login` on the host, or set a per-user token in the database, then reload.',
		setupHintVisibility: 'when-unauthenticated'
	},
	status: {
		probe: 'when-default',
		skippedStatusMessage: 'Not checked because GitHub Copilot is not the default provider.'
	},
	capabilities: {
		authStatus: true,
		modelList: true,
		session: {
			open: true,
			resume: true,
			dispose: true,
			abort: true
		},
		stream: {
			send: true,
			contract: 'PortalEvent'
		},
		controls: {
			mode: true,
			approveAll: true,
			resetSessionApprovals: true
		},
		features: {
			modes: {
				supported: true,
				behavior: 'supported',
				label: 'Runtime modes',
				description: 'Interactive, plan, autopilot, and best-effort are forwarded to Copilot.'
			},
			approveAll: {
				supported: true,
				behavior: 'supported',
				label: 'Approve all',
				description: 'Approve-all is mirrored to the Copilot runtime and enforced by the portal.'
			},
			contextUsage: {
				supported: true,
				behavior: 'supported',
				label: 'Context usage',
				description: 'Copilot context-window and compaction events are shown in the header.'
			},
			subagents: {
				supported: true,
				behavior: 'supported',
				label: 'Subagents',
				description: 'Copilot task subagent lifecycle events are streamed and persisted.'
			},
			mcpInfoEvents: {
				supported: true,
				behavior: 'supported',
				label: 'MCP info events',
				description: 'MCP sampling, OAuth, and external-tool info events are surfaced to the UI.'
			},
			planExit: {
				supported: true,
				behavior: 'supported',
				label: 'Plan exit',
				description: 'Copilot can request approval before leaving plan mode.'
			},
			elicitation: {
				supported: true,
				behavior: 'supported',
				label: 'Elicitation',
				description: 'Copilot elicitation callbacks are rendered as interactive requests.'
			}
		},
		optionalRuntimeFeatures: {
			infiniteSessionMetadata: true,
			permissionCallbacks: true,
			userInputCallbacks: true,
			elicitationCallbacks: true,
			exitPlanModeCallbacks: true,
			autoModeSwitchCallbacks: true,
			contextWindowEvents: true,
			contextCompactionEvents: true,
			fileEditEvents: true,
			reasoningEvents: true,
			subagentLifecycleEvents: true
		}
	},
	resolveAuthToken(userId: string): string | undefined {
		const cfg = loadConfig();
		return tokens.getGithubToken(userId) ?? cfg.COPILOT_GITHUB_TOKEN ?? undefined;
	},
	fetchAuthStatus,
	listModels: fetchModels,
	openSession: open,
	shutdown: shutdownClient
};

function normalizeSessionWorkspacePath(path: string | undefined): string | null {
	const trimmed = path?.trim();
	if (!trimmed) return null;
	return trimmed;
}
