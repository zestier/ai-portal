// pi session plumbing: wraps `createAgentSession` (the pi SDK) in the portal's
// `ProviderSession` interface so the turn-runner's existing dispatch /
// persistence / SSE pipeline drives a pi agent unchanged.
//
// Design:
//  - a shared `ModelRuntime` (created once in index.ts) supplies the model and
//    auth; each turn builds a fresh pi session with `SessionManager.inMemory()`
//    (no session files) and `noTools: 'builtin'` — the portal tools are
//    registered as pi `customTools` (override, not wrap) and the pi built-ins
//    (read/bash/edit/write) are disabled.
//  - every tool call is gated by the portal permission gateway: the resolver
//    (see permission-gate.ts) runs inside a `tool_call` extension registered on
//    the resource loader. A `{block: true}` return makes pi produce an
//    immediate error tool result, so a denied call still emits the normal
//    tool.call / tool.result pair on the portal timeline.
//  - the permission tools (request_permission_grant / force_retry_tool /
//    permission_capabilities) and the gate share one `emit` that routes
//    `interactive.request` events into the active turn's stream, so the human
//    permission dialogs work exactly as on the non-pi path.
//  - `send()` adapts pi's callback-style `session.subscribe` to the portal's
//    async-iterator contract via `AsyncQueue`, mapping events through
//    `PiEventMapper`.

import { ulid } from 'ulid';
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type CreateAgentSessionOptions,
	type InlineExtension,
	type ModelRuntime,
	type ToolDefinition
} from '@earendil-works/pi-coding-agent';
import type { ApprovalMode, PortalEvent, SessionMode } from '$lib/types';
import type { PortalTool } from '../tools/types';
import { assemblePiTools } from '../tools/assemble';
import { createPiPermissionResolver } from './permission-gate';
import { workspaceRootsFor } from '../leases';
import type { ProviderSession } from './session-contract';
import { AsyncQueue } from '../runtime/async-queue';
import { log } from '../log';
import { PiEventMapper } from './events';

export type PiModel = NonNullable<CreateAgentSessionOptions['model']>;

/**
 * Decides whether a pi tool call may run. `allow: true` lets it through;
 * otherwise the call is blocked with `reason`. Wired to the portal permission
 * gateway (permission-gate.ts), which routes every request through the user's
 * grants, policy, and interactive-request dialogs.
 */
export interface PiPermissionResolver {
	(
		toolName: string,
		args: Record<string, unknown>,
		toolCallId: string
	): Promise<{
		allow: boolean;
		reason?: string;
	}>;
}

export interface CreatePiSessionOptions {
	cwd: string;
	model: PiModel;
	runtime: ModelRuntime;
	/** The portal tool set, adapted for pi (from assemblePiTools). */
	customTools: ToolDefinition[];
	/** Portal tools by name — the permission gate's lookup index. */
	portalToolsByName: ReadonlyMap<string, PortalTool>;
	/** The portal permission gateway resolver. */
	permissionResolver: PiPermissionResolver;
}

/** Create a pi `AgentSession` over the shared runtime with in-memory session state. */
export async function createPiSession(opts: CreatePiSessionOptions): Promise<AgentSession> {
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir,
		extensionFactories: [createPiPermissionBridge(opts.permissionResolver)],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true
	});
	await loader.reload();
	const { session } = await createAgentSession({
		cwd: opts.cwd,
		agentDir,
		modelRuntime: opts.runtime,
		model: opts.model,
		noTools: 'builtin',
		customTools: opts.customTools,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager: SettingsManager.inMemory()
	});
	return session;
}

export interface PiProviderSessionOptions {
	cwd: string;
	model: PiModel;
	runtime: ModelRuntime;
	provider: string;
	providerLabel: string;
	conversationId: string;
	providerSessionId: string;
	userId: string;
	policy: import('$lib/types').PermissionPolicy;
	mode?: SessionMode;
	approvalMode?: ApprovalMode;
	disabledToolGroups?: string[];
	workspaceKey?: string;
	memoryMode?: import('$lib/types').MemoryMode;
	globalMemoryEnabled?: boolean;
	onEvent?: (e: PortalEvent) => void;
}

/** Build a `ProviderSession` wrapping a live pi `AgentSession`. */
export async function createPiProviderSession(
	opts: PiProviderSessionOptions
): Promise<ProviderSession> {
	// Live, mutable session state the getters below read (so a mid-turn PATCH
	// via setApprovalMode takes effect on the next tool call, not the next
	// session open).
	const state = {
		mode: opts.mode ?? 'interactive',
		approvalMode: opts.approvalMode ?? 'ask'
	};
	let activeQueue: AsyncQueue<PortalEvent> | null = null;
	// Shared emit: the permission tools and the permission gate push
	// `interactive.request` events into the active turn's stream.
	const emit = (ev: PortalEvent): void => {
		activeQueue?.push(ev);
	};
	const getWorkspaceRoots = (): string[] =>
		workspaceRootsFor(opts.conversationId, opts.userId, opts.cwd);

	const { customTools, portalToolsByName } = assemblePiTools({
		cwd: opts.cwd,
		userId: opts.userId,
		conversationId: opts.conversationId,
		policy: opts.policy,
		getMode: () => state.mode,
		getApprovalMode: () => state.approvalMode,
		emit,
		...(opts.workspaceKey !== undefined ? { workspaceKey: opts.workspaceKey } : {}),
		...(opts.disabledToolGroups !== undefined
			? { disabledToolGroups: opts.disabledToolGroups }
			: {}),
		...(opts.memoryMode !== undefined ? { memoryMode: opts.memoryMode } : {}),
		...(opts.globalMemoryEnabled !== undefined
			? { globalMemoryEnabled: opts.globalMemoryEnabled }
			: {})
	});
	const permissionResolver = createPiPermissionResolver({
		userId: opts.userId,
		conversationId: opts.conversationId,
		workingDirectory: opts.cwd,
		policy: opts.policy,
		portalToolsByName,
		getApprovalMode: () => state.approvalMode,
		getWorkspaceRoots,
		emit
	});

	const piSession = await createPiSession({
		cwd: opts.cwd,
		model: opts.model,
		runtime: opts.runtime,
		customTools,
		portalToolsByName,
		permissionResolver
	});
	return makePiProviderSession(piSession, opts, {
		state,
		getActiveQueue: () => activeQueue,
		setActiveQueue: (queue: AsyncQueue<PortalEvent> | null) => {
			activeQueue = queue;
		}
	});
}

interface ProviderSessionRuntime {
	state: { mode: SessionMode; approvalMode: ApprovalMode };
	getActiveQueue: () => AsyncQueue<PortalEvent> | null;
	setActiveQueue: (queue: AsyncQueue<PortalEvent> | null) => void;
}

function makePiProviderSession(
	piSession: AgentSession,
	opts: PiProviderSessionOptions,
	runtime: ProviderSessionRuntime
): ProviderSession {
	let active: { queue: AsyncQueue<PortalEvent>; unsub: () => void } | null = null;
	let disposed = false;

	const session: ProviderSession = {
		provider: opts.provider,
		conversationId: opts.conversationId,
		providerSessionId: opts.providerSessionId,
		workingDirectory: opts.cwd,
		model: opts.providerLabel,
		lastUsed: Date.now(),
		async *send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent> {
			if (active) throw new Error('session busy: a turn is already in progress');
			if (disposed) throw new Error('session disposed');
			const messageId = ulid();
			const queue = new AsyncQueue<PortalEvent>();
			const mapper = new PiEventMapper(messageId);
			const unsub = piSession.subscribe((ev) => {
				for (const portalEvent of mapper.map(ev)) queue.push(portalEvent);
				// `agent_end` terminates the run; end the stream here (runPrompt's
				// finally re-ends as a no-op safety net for aborted runs).
				if (ev.type === 'agent_end') queue.end();
			});
			active = { queue, unsub };
			runtime.setActiveQueue(queue);
			const onAbort = () => void piSession.abort().catch(() => {});
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
			void runPrompt(prompt, piSession, mapper, queue, messageId, opts.conversationId);
			try {
				for await (const ev of queue) {
					opts.onEvent?.(ev);
					yield ev;
				}
			} finally {
				signal.removeEventListener('abort', onAbort);
				unsub();
				active = null;
				runtime.setActiveQueue(null);
				session.lastUsed = Date.now();
			}
		},
		async abort() {
			void piSession.abort().catch(() => {});
		},
		async dispose() {
			disposed = true;
			active?.unsub();
			active?.queue.end();
			try {
				piSession.dispose();
			} catch (err) {
				log.warn('pi.session.dispose_failed', {
					conversationId: opts.conversationId,
					err: err instanceof Error ? err.message : String(err)
				});
			}
		},
		async setMode(mode: SessionMode) {
			runtime.state.mode = mode;
		},
		async setApprovalMode(mode: ApprovalMode) {
			runtime.state.approvalMode = mode;
		}
	};
	return session;
}

async function runPrompt(
	prompt: string,
	piSession: AgentSession,
	mapper: PiEventMapper,
	queue: AsyncQueue<PortalEvent>,
	messageId: string,
	conversationId: string
): Promise<void> {
	try {
		await piSession.prompt(prompt, { streamingBehavior: 'steer' });
	} catch (err) {
		if (!mapper.hasError) {
			log.warn('pi.session.prompt_failed', {
				conversationId,
				err: err instanceof Error ? err.message : String(err)
			});
			queue.push({
				type: 'error',
				code: 'pi_send_failed',
				message: err instanceof Error ? err.message : String(err)
			});
		}
	} finally {
		for (const ev of mapper.closeReasoning()) queue.push(ev);
		if (!mapper.ended) queue.push({ type: 'message.end', messageId });
		queue.end();
	}
}

// Portal permission bridge: a hidden inline extension intercepting pi tool
// calls before they execute. The resolver decides allow/block; `block` makes
// pi produce an immediate error tool result (never a thrown handler error,
// which would abort the turn).
function createPiPermissionBridge(onPermission: PiPermissionResolver): InlineExtension {
	return {
		name: 'portal-permission-bridge',
		hidden: true,
		factory: (pi) => {
			pi.on('tool_call', async (event) => {
				const decision = await onPermission(
					event.toolName,
					event.input as Record<string, unknown>,
					event.toolCallId
				);
				return decision.allow
					? undefined
					: { block: true, reason: decision.reason ?? 'Permission denied.' };
			});
		}
	};
}
