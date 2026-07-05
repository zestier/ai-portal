// Copilot provider implementation around `@github/copilot-sdk`. Owns SDK
// client/session lifecycle; event normalization and interactive callbacks live
// in sibling adapters.
//
// NOTE: Pinned to @github/copilot-sdk 1.0.1. The SDK connects via the
// `RuntimeConnection` factory (forStdio/forUri) and gates the 1M window behind
// the `contextTier` session field. If upgrading, audit this file plus
// sdk-events.ts / interactive-adapter.ts (event names + handler field names).

import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import type { ContextTier } from '@github/copilot-sdk';
import type { PortalEvent, SessionMode } from '$lib/types';
import { AsyncQueue } from '../runtime/async-queue';
import { withTimeout } from '../runtime/with-timeout';
import { PORTAL_SYSTEM_GUIDANCE } from '../runtime/system-guidance';
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
import * as settingsRepo from '../db/repos/settings';
import { loadConfig } from '../config';
import { log } from '../log';
import { StubCopilotClient, isStubMode } from './bridge-stub';
import { BoundedTtlCache } from './bounded-ttl-cache';
import { buildGitTools } from '../tools/git';
import { buildTicketTools } from '../tools/tickets';
import { buildPermissionTools } from '../tools/permissions';
import { buildMemoryTools } from '../tools/memory';
import { buildPromptTemplateTools } from '../tools/prompt-templates';
import { buildFilesystemTools } from '../tools/filesystem';
import { filterPortalToolGroups } from '../tools/filter-groups';
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

function sdkCallTimeoutMs(): number {
	return loadConfig().COPILOT_SDK_CALL_TIMEOUT_MS;
}

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
		// CLI. The SDK passes it as the `RuntimeConnection.forUri` connection
		// token; for URI connections it does NOT fall back to the
		// COPILOT_CONNECTION_TOKEN environment variable, so without this the
		// handshake authenticates as `undefined` and the server rejects it.
		const connectionToken = cliUrl ? loadConfig().COPILOT_CONNECTION_TOKEN : undefined;
		const client = isStubMode()
			? (new StubCopilotClient() as unknown as CopilotClient)
			: cliUrl
				? new CopilotClient({
						connection: RuntimeConnection.forUri(
							cliUrl,
							connectionToken ? { connectionToken } : undefined
						)
					})
				: new CopilotClient({
						connection: RuntimeConnection.forStdio(),
						useLoggedInUser: true,
						...(providerAuthToken !== undefined ? { gitHubToken: providerAuthToken } : {})
					});
		await withTimeout(client.start(), sdkCallTimeoutMs(), 'copilot client.start');
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
// available models) can differ between users. Bounded so a long-running server
// that sees many distinct users doesn't accumulate a permanent registry of
// every userId — entries expire on read and the map is LRU-capped.
const MODELS_TTL_MS = 5 * 60_000;
const MODELS_CACHE_MAX = 1000;
const modelsCache = new BoundedTtlCache<string, ProviderModelInfo[]>({
	ttlMs: MODELS_TTL_MS,
	maxEntries: MODELS_CACHE_MAX
});

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
	if (cached) {
		return cached;
	}
	const client = await getClient(userId, providerAuthToken);
	const models = await client.listModels();
	modelsCache.set(userId, models);
	return models;
}

// Resolve the context window tier to request for the session. The 1M window is
// the SDK's `"long_context"` ContextTier — a premium, separately-billed tier
// that newer Copilot CLIs gate behind an explicit opt-in (older CLIs defaulted
// to the full window). Sessions otherwise run at the standard `"default"` tier
// (~200k). We forward the tier on both the create and resume paths via the
// SDK's `contextTier` session-config field; the model-advertised
// `max_context_window_tokens` is NOT the knob that controls this.
//
// Source priority: the per-user setting wins when set (so a user can opt into
// — or out of — the large window), falling back to the instance-wide
// `COPILOT_CONTEXT_TIER` default when the user has expressed no preference.
// Returns undefined for the default tier so we don't write an unnecessary
// override.
function resolveContextTier(userId: string): ContextTier | undefined {
	const userTier = settingsRepo.get(userId)?.defaultContextTier ?? null;
	const tier = userTier ?? loadConfig().COPILOT_CONTEXT_TIER;
	return tier === 'long_context' ? 'long_context' : undefined;
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
	const portalTools = filterPortalToolGroups(
		{
			git: buildGitTools(opts.workingDirectory),
			filesystem: buildFilesystemTools(opts.workingDirectory),
			tickets: buildTicketTools({
				userId: opts.userId,
				workspaceKey: ticketWorkspaceFromConversation(opts.workingDirectory),
				conversationId: opts.conversationId
			}),
			permissions: buildPermissionTools({
				userId: opts.userId,
				conversationId: opts.conversationId,
				policy: opts.policy,
				getMode: () => currentMode,
				emit
			}),
			memory: buildMemoryTools({
				userId: opts.userId,
				conversationId: opts.conversationId,
				mode: opts.memoryMode ?? 'off',
				globalMemoryEnabled: opts.globalMemoryEnabled === true
			}),
			'prompt-templates': buildPromptTemplateTools({ userId: opts.userId })
		},
		opts.disabledToolGroups
	);
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
	const onExitPlanModeRequest = async (req: Parameters<typeof onExitPlanMode>[0]) => {
		const response = await onExitPlanMode(req);
		return {
			approved: response.approved,
			...(response.selectedAction !== undefined ? { selectedAction: response.selectedAction } : {}),
			...(response.feedback !== undefined ? { feedback: response.feedback } : {})
		};
	};

	let existingMetadata: unknown;
	try {
		existingMetadata = await withTimeout(
			client.getSessionMetadata(providerSessionId),
			sdkCallTimeoutMs(),
			'copilot getSessionMetadata'
		);
	} catch (e) {
		log.warn('copilot.session.metadata_lookup_failed', {
			conversationId: opts.conversationId,
			providerSessionId,
			err: (e as Error).message
		});
	}

	// Pin the session context window tier so it doesn't inherit the standard
	// (~200k) tier. Resolved before building the config so both the create and
	// resume paths carry it. See resolveContextTier for why the 1M window is a
	// tier opt-in rather than a model-capabilities override.
	const contextTier = resolveContextTier(opts.userId);
	if (contextTier) {
		log.info('copilot.session.context_tier', {
			conversationId: opts.conversationId,
			model: opts.model,
			contextTier
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
		// Append our standing guidance to the SDK-managed system prompt. `append`
		// mode keeps every SDK guardrail/safety section intact and just adds ours;
		// `replace` would drop those, so we never use it here. Set once at session
		// establishment (carried on both the create and resume paths) so it costs
		// system tokens once rather than being re-sent every turn like the prelude.
		systemMessage: { mode: 'append' as const, content: PORTAL_SYSTEM_GUIDANCE },
		...(contextTier ? { contextTier } : {}),
		tools: wrapToolsForStreaming(portalTools, emit, () => currentTurnSignal),
		onPermissionRequest,
		onUserInputRequest,
		onElicitationRequest,
		onExitPlanModeRequest,
		onAutoModeSwitchRequest: onAutoModeSwitch
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
	// Open a brand-new SDK session for `providerSessionId`. This is the path a
	// rerun (inline edit / regenerate) always takes: rerunFromUserMessage
	// rotates the provider session to a freshly-minted id the Copilot CLI has
	// never seen, so `getSessionMetadata` above returns nothing and there's no
	// session to resume. Wrap it so a genuine open failure surfaces a clear,
	// safe message (naming the conversation) instead of a raw SDK error string
	// — the turn runner forwards `Error.message` straight into the chat as the
	// turn's error event, so an opaque message is what the user would otherwise
	// see. The auth token lives on the client, never in this message.
	const createFreshSession = async (): Promise<SdkSession> => {
		try {
			return (await withTimeout(
				client.createSession({
					...sessionConfig,
					sessionId: providerSessionId
				}),
				sdkCallTimeoutMs(),
				'copilot createSession'
			)) as unknown as SdkSession;
		} catch (e) {
			throw new Error(
				`Failed to open a GitHub Copilot session for conversation ${opts.conversationId}: ${
					(e as Error).message
				}`,
				{ cause: e }
			);
		}
	};
	// Redacted snapshot of what we hand the SDK, so a connected-CLI session can
	// be diffed against a managed one without exposing auth/tool internals. The
	// auth token lives on the CopilotClient (construction time), never in
	// sessionConfig, so it can't leak here; we still avoid logging tool arg
	// schemas and handler bodies by reducing tools to their names.
	const sessionConfigSummary = {
		conversationId: opts.conversationId,
		providerSessionId,
		path: existingMetadata ? 'resume' : 'create',
		model: sessionConfig.model,
		workingDirectory: sessionConfig.workingDirectory,
		streaming: sessionConfig.streaming,
		contextTier: 'contextTier' in sessionConfig ? sessionConfig.contextTier : null,
		systemMessage: {
			mode: sessionConfig.systemMessage.mode,
			chars: sessionConfig.systemMessage.content.length
		},
		toolNames: portalTools.map((t) => t.name),
		handlers: {
			onPermissionRequest: Boolean(sessionConfig.onPermissionRequest),
			onUserInputRequest: Boolean(sessionConfig.onUserInputRequest),
			onElicitationRequest: Boolean(sessionConfig.onElicitationRequest),
			onExitPlanModeRequest: Boolean(sessionConfig.onExitPlanModeRequest),
			onAutoModeSwitchRequest: Boolean(sessionConfig.onAutoModeSwitchRequest)
		}
	};
	log.info('copilot.session.config', sessionConfigSummary);
	if (existingMetadata) {
		try {
			sdkSession = (await withTimeout(
				client.resumeSession(providerSessionId, sessionConfig),
				sdkCallTimeoutMs(),
				'copilot resumeSession'
			)) as unknown as SdkSession;
		} catch (e) {
			log.warn('copilot.session.resume_failed_falling_back_to_create', {
				conversationId: opts.conversationId,
				providerSessionId,
				err: (e as Error).message
			});
			sdkSession = await createFreshSession();
		}
	} else {
		sdkSession = await createFreshSession();
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
		},
		localModelLoad: {
			primeAfterModelSwap: false
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
