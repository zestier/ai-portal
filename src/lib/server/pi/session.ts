// pi session plumbing: wraps `createAgentSession` (the pi SDK) in the portal's
// `ProviderSession` interface so the turn-runner's existing dispatch /
// persistence / SSE pipeline drives a pi agent unchanged.
//
// Design:
//  - a shared `ModelRuntime` (created once in index.ts) supplies the model and
//    auth; each turn builds a fresh pi session with `SessionManager.inMemory()`
//    (no session files) and `noTools: 'all'` (the tool/permission surface is
//    wired in a later ticket).
//  - the portal permission bridge is registered as an inline extension via
//    `DefaultResourceLoader.extensionFactories`; with no tools enabled the
//    `tool_call` handler never fires, so for now it blocks every call with a
//    fixed reason (the real portal gateway slots in behind `onPermission`).
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
	type ModelRuntime
} from '@earendil-works/pi-coding-agent';
import type { PortalEvent } from '$lib/types';
import type { ProviderSession } from '../providers';
import { AsyncQueue } from '../runtime/async-queue';
import { log } from '../log';
import { PiEventMapper } from './events';

export type PiModel = NonNullable<CreateAgentSessionOptions['model']>;

/**
 * Decides whether a pi tool call may run. `allow: true` lets it through;
 * otherwise the call is blocked with `reason`. T1's resolver blocks everything
 * (no tools are enabled anyway); the portal permission gateway is the T2 seam.
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
	onPermission: PiPermissionResolver;
}

/** Create a pi `AgentSession` over the shared runtime with in-memory session state. */
export async function createPiSession(opts: CreatePiSessionOptions): Promise<AgentSession> {
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir,
		extensionFactories: [createPiPermissionBridge(opts.onPermission)],
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
		noTools: 'all',
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(opts.cwd),
		settingsManager: SettingsManager.inMemory()
	});
	return session;
}

export interface PiProviderSessionOptions extends CreatePiSessionOptions {
	provider: string;
	providerLabel: string;
	conversationId: string;
	providerSessionId: string;
	onEvent?: (e: PortalEvent) => void;
}

/** Build a `ProviderSession` wrapping a live pi `AgentSession`. */
export async function createPiProviderSession(
	opts: PiProviderSessionOptions
): Promise<ProviderSession> {
	const piSession = await createPiSession(opts);
	return makePiProviderSession(piSession, opts);
}

function makePiProviderSession(
	piSession: AgentSession,
	opts: PiProviderSessionOptions
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
// calls before they execute. With `noTools: 'all'` no call ever reaches it in
// T1; the resolver is the seam the portal interactive-request gateway plugs
// into (block/allow + reason, mirroring the claude-agent canUseTool flow).
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
