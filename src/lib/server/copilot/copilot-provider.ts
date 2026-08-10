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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalMode, PortalEvent, SessionMode } from '$lib/types';
import { AsyncQueue } from '../runtime/async-queue';
import { withTimeout } from '../runtime/with-timeout';
import { buildPortalSystemGuidance } from '../runtime/system-guidance';
import { createInteractiveCallbacks } from './interactive-adapter';
import { SdkEventAdapter, type RuntimeSessionMode } from './sdk-events';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderCompletionRequest,
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
import { buildShellTools } from '../tools/shell';
import { buildCreateDirectoryTools } from '../tools/create-directory';
import { buildMoveTools } from '../tools/move';
import { buildTrashTools } from '../tools/trash';
import { buildReadFileTools } from '../tools/read-file';
import { buildApplyPatchTools } from '../tools/apply-patch';
import { buildGrepTools } from '../tools/grep';
import { buildEditFileTools } from '../tools/edit-file';
import { buildWorktreeTools } from '../tools/worktree';
import { workspaceRootsFor } from '../leases';
import { filterPortalToolGroups } from '../tools/filter-groups';
import { buildPermissionRequestResolver, type PortalTool } from '../tools/types';
import { buildToolArgsValidator } from '../tools/schema-error';
import { wrapToolsForStreaming } from './tool-streaming';
import { ticketWorkspaceFromConversation } from '../ticket-workspace';
import { appGlobalSymbols, getOrCreateGlobalSingleton } from '../global-singleton';
import { ulid } from '../db/ids';

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

/**
 * One `CopilotClient` per portal user.
 *
 * IMPORTANT: callers must pass `providerAuthToken` (resolve it with
 * `providers/auth.ts` `providerAuthToken()`, which is just
 * `provider.resolveAuthToken?.(userId)`). The cache is keyed on `userId` alone
 * and **first caller wins**, while `gitHubToken` is only applied at
 * construction — so a single token-less caller that happens to run first pins
 * that user's client to the machine's logged-in identity, and every later
 * session for them silently inherits it. Every current caller resolves a token;
 * this note exists because the requirement is otherwise invisible here, and an
 * out-of-band background caller (the adversary shadow) already reintroduced it
 * once.
 */
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
	Required<Pick<ProviderSession, 'setMode' | 'setApprovalMode' | 'resetSessionApprovals'>>;

interface SdkSession {
	on(event: string, listener: (e: unknown) => void): void;
	off?(event: string, listener: (e: unknown) => void): void;
	/** Resolves with the message ID, NOT the reply text; content arrives via `on`. */
	send(args: { prompt: string }): Promise<string>;
	/**
	 * Sends and waits for the session to go idle, resolving with the final
	 * assistant message. This is the request/response shape `send` is not, and
	 * is what the tool-less side-call path uses. `timeout` defaults to 60s in
	 * the SDK, so callers with their own budget must pass it explicitly.
	 */
	sendAndWait(
		args: { prompt: string },
		timeout?: number
	): Promise<{ data?: { content?: string } } | undefined>;
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
	// DB; the /session PATCH endpoint flips these via setMode/setApprovalMode
	// on the live ConversationSession so a turn already in flight picks up
	// the change without a recreate.
	let approvalMode: ApprovalMode = opts.approvalMode ?? 'ask';
	let currentMode: SessionMode = opts.mode ?? 'interactive';
	let sessionWorkspacePath: string | null = null;
	// Abort signal for the in-flight turn, set at the start of each `send` and
	// cleared when it ends. Custom tool handlers' streaming context mirrors this
	// so a cancelled turn stops their incremental emission.
	let currentTurnSignal: AbortSignal | null = null;
	const toolPermissionBehavior = new Map<string, 'normal' | 'always-prompt' | 'never-prompt'>();
	// Populated after `portalTools` is assembled (see the loop below); consulted
	// only at force-retry approval time, so the resolver can be threaded into
	// `buildPermissionTools` before the names exist.
	const portalToolsByName = new Map<string, PortalTool>();
	const resolvePortalTool = (name: string): PortalTool | null =>
		portalToolsByName.get(name) ?? null;
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
			shell: buildShellTools(opts.workingDirectory),
			git: buildGitTools(opts.workingDirectory, {
				userId: opts.userId,
				conversationId: opts.conversationId
			}),
			filesystem: [
				...buildCreateDirectoryTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildMoveTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildTrashTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildReadFileTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildApplyPatchTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildEditFileTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				}),
				...buildGrepTools(opts.workingDirectory, {
					userId: opts.userId,
					conversationId: opts.conversationId
				})
			],
			worktree: buildWorktreeTools({
				userId: opts.userId,
				conversationId: opts.conversationId
			}),
			tickets: buildTicketTools({
				userId: opts.userId,
				workspaceKey: opts.workspaceKey ?? ticketWorkspaceFromConversation(opts.workingDirectory),
				conversationId: opts.conversationId
			}),
			permissions: buildPermissionTools({
				userId: opts.userId,
				conversationId: opts.conversationId,
				policy: opts.policy,
				getMode: () => currentMode,
				getApprovalMode: () => approvalMode,
				emit,
				resolvePortalTool
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
		getWorkspaceRoots: () =>
			workspaceRootsFor(opts.conversationId, opts.userId, opts.workingDirectory),
		policy: opts.policy,
		emit,
		getApprovalMode: () => approvalMode,
		getSessionWorkspacePath: () => sessionWorkspacePath,
		getPermissionBehavior: (tool) => toolPermissionBehavior.get(tool) ?? 'normal',
		getAgentModel: () => opts.model,
		getAgentBackend: () => 'copilot',
		getAdversaryModel: () => opts.adversaryModel ?? null,
		getAdversaryBackend: () => opts.adversaryBackend ?? null,
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
		// Built from this session's real tool set so guidance for absent tool
		// groups (e.g. a disabled `tickets` group) isn't sent.
		systemMessage: {
			mode: 'append' as const,
			content: buildPortalSystemGuidance(portalTools.map((tool) => tool.name))
		},
		...(contextTier ? { contextTier } : {}),
		tools: wrapToolsForStreaming(portalTools, emit, () => currentTurnSignal),
		onPermissionRequest,
		onUserInputRequest,
		onElicitationRequest,
		onExitPlanModeRequest,
		onAutoModeSwitchRequest: onAutoModeSwitch
	};
	for (const tool of portalTools) {
		portalToolsByName.set(tool.name, tool);
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

	// Push initial mode + approval mode to the runtime. Best-effort: the
	// `rpc` surface is preview API and may be missing on stub clients;
	// skipping the call is fine because the portal enforces the approval mode
	// itself in `onPermissionRequest`, and a missing mode RPC just means
	// the agent runs in its default mode (still safe).
	async function applyMode(mode: SessionMode): Promise<void> {
		try {
			await sdkSession.rpc?.mode?.set?.({ mode });
			currentMode = mode;
		} catch (e) {
			log.warn('copilot.session.mode_set_failed', {
				conversationId: opts.conversationId,
				mode,
				err: (e as Error).message
			});
		}
	}
	// Only `auto-approve` has a runtime counterpart: it is mirrored to the SDK so
	// the model knows it runs less supervised. `ask` and `auto-deny` are settled
	// entirely by the portal's interactive adapter, so the SDK toggle is simply
	// cleared for both.
	async function applyApprovalMode(mode: ApprovalMode): Promise<void> {
		approvalMode = mode;
		const enabled = mode === 'auto-approve';
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
	if (approvalMode === 'auto-approve') await applyApprovalMode(approvalMode);

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
		async setApprovalMode(mode: ApprovalMode) {
			await applyApprovalMode(mode);
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
	type: 'copilot',
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
			approvalMode: true,
			resetSessionApprovals: true
		},
		features: {
			modes: {
				supported: true,
				behavior: 'supported',
				label: 'Runtime modes',
				description: 'Interactive, plan, and autopilot are forwarded to Copilot.'
			},
			approvalMode: {
				supported: true,
				behavior: 'supported',
				label: 'Approval mode',
				description:
					'Auto-approve is mirrored to the Copilot runtime; every approval mode is enforced by the portal.'
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
		},
		sideCompletion: true
	},
	resolveAuthToken(userId: string): string | undefined {
		const cfg = loadConfig();
		return tokens.getGithubToken(userId) ?? cfg.COPILOT_GITHUB_TOKEN ?? undefined;
	},
	fetchAuthStatus,
	listModels: fetchModels,
	openSession: open,
	complete: completeSideCall,
	shutdown: shutdownClient
};

/**
 * One-shot completion on an ephemeral Copilot session.
 *
 * The SDK genuinely has no completions endpoint: `CopilotClient` exposes only
 * `createSession` / `resumeSession`, so a session is the only way in. It does
 * provide `sendAndWait`, which turns that into a real request/response call —
 * `send` alone resolves with the **message id** and delivers the text through
 * the event stream, so using it here would return an id that no verdict parser
 * could read.
 *
 * Still more expensive than an OpenAI-compatible POST (a session is created and
 * torn down per call), which is why callers must treat it as fire-and-forget
 * and bound it with their own timeout.
 *
 * Three properties make the ephemeral session safe to run outside a
 * conversation:
 *
 *   * **No portal tools.** `tools: []` is the SDK-consumer tool set, so nothing
 *     in `src/lib/server/tools/` is reachable.
 *   * **Every permission refused.** That field does *not* remove the runtime's
 *     own built-in tools, and the SDK offers no switch that does, so the
 *     permission callback is the actual guard. A reviewer that could ask a
 *     human for approval would recurse the permission problem it exists to
 *     review.
 *   * **A scratch working directory.** Custom instruction files (`AGENTS.md`,
 *     `.github/copilot-instructions.md`) are loaded from the working directory
 *     *regardless of* `enableConfigDiscovery`, so pointing this at a user's
 *     repository would inject that repo's instructions into the reviewer's
 *     context. An empty temp dir has nothing to find and nothing to reach.
 *
 * `systemMessage.mode` is `append` (never `replace`) for the same reason as the
 * conversation path: `replace` drops the SDK's own guardrail sections.
 */
async function completeSideCall(req: ProviderCompletionRequest): Promise<string> {
	// `userId` is required here, unlike the OpenAI-compatible providers: Copilot
	// auth and model entitlements are per-user, so there is no operator-level
	// credential to fall back on.
	if (!req.userId) throw new Error('Copilot completion requires a userId');
	const client = await getClient(req.userId, req.providerAuthToken);
	const sessionId = `side-call-${ulid()}`;
	const workingDirectory = await mkdtemp(join(tmpdir(), 'portal-sidecall-'));
	// ONE deadline across both phases. Giving `createSession` and `sendAndWait`
	// the full budget each would let a call run to ~2x it, past the caller's own
	// guard (the shadow releases its in-flight slot at timeout + 5s), so a
	// verdict the model really produced would be thrown away as an error — and
	// only ever on this backend, which pays a session setup the OpenAI-compatible
	// path does not. That would bias one arm of the experiment.
	const deadline = Date.now() + req.timeoutMs;
	const remaining = () => Math.max(1, deadline - Date.now());

	// Held separately from the awaited value: `withTimeout` does not cancel what
	// it wraps, so if session creation loses the race the session still arrives
	// moments later. Cleanup below chains off THIS promise rather than the
	// awaited result, because otherwise that late session is never disconnected
	// and holds runtime resources for the life of the process — once per
	// permission request on a slow runtime.
	const creating = client.createSession({
		sessionId,
		model: req.model,
		workingDirectory,
		streaming: false,
		systemMessage: { mode: 'append' as const, content: req.system },
		tools: [],
		// `user-not-available` is the literal truth — a side completion has no
		// conversation and no human attached — and unlike a denial it does not
		// make the SDK log a tool rejection against a user who was never asked.
		onPermissionRequest: async () => ({ kind: 'user-not-available' }) as const
	}) as unknown as Promise<SdkSession>;

	try {
		const session = await withTimeout(creating, remaining(), 'copilot side-call createSession');
		// `sendAndWait`'s own timeout defaults to 60s, which would outlive the
		// caller's budget; pass ours so both agree on when to give up.
		const reply = await withTimeout(
			session.sendAndWait({ prompt: req.user }, remaining()),
			remaining(),
			'copilot side-call sendAndWait'
		);
		const content = reply?.data?.content;
		// Resolving with no assistant message is a real outcome (the session went
		// idle without answering). Reject rather than return '' so it lands as a
		// transport error instead of masquerading as an unparseable verdict.
		if (typeof content !== 'string' || !content) {
			throw new Error('copilot side-call returned no assistant message');
		}
		return content;
	} finally {
		// Cleanup is chained off `creating`, not off the awaited local, so a
		// session that arrives after the timeout is still disconnected. The temp
		// directory is removed only once that has settled — it is the session's
		// cwd, and pulling it out from under a live session is worse than
		// leaving it a moment longer.
		//
		// Fully best-effort: a leaked session or directory must not turn an
		// answer we already have into an error, so nothing here propagates.
		//
		// If `creating` never settles at all — the hung-runtime case `withTimeout`
		// exists for — this chain never advances and the empty scratch dir is
		// left behind. Accepted: the orphaned session is unavoidable there
		// regardless, and one empty `mkdtemp` directory is a smaller cost than
		// deleting a live session's cwd out from under it.
		void creating
			.then(
				(s) => s.disconnect(),
				() => {
					/* creation failed; there is nothing to disconnect */
				}
			)
			.catch((e) => log.warn('copilot.side_call.disconnect_failed', { sessionId, err: String(e) }))
			.then(() => rm(workingDirectory, { recursive: true, force: true }))
			.catch((e) => log.warn('copilot.side_call.cleanup_failed', { sessionId, err: String(e) }));
	}
}

function normalizeSessionWorkspacePath(path: string | undefined): string | null {
	const trimmed = path?.trim();
	if (!trimmed) return null;
	return trimmed;
}
