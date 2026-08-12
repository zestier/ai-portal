import {
	query,
	type HookJSONOutput,
	type Options,
	type SDKMessage
} from '@anthropic-ai/claude-agent-sdk';
import { ulid } from 'ulid';
import type { ApprovalMode, PortalEvent, SessionMode, ProviderInstance } from '$lib/types';
import { isolatedChildEnv } from '../child-env';
import { loadConfig } from '../config';
import { log } from '../log';
import { workspaceRootsFor } from '../leases';
import { AsyncQueue } from '../runtime/async-queue';
import { buildPortalSystemGuidance } from '../runtime/system-guidance';
import { createInteractiveCallbacks } from '../copilot/interactive-adapter';
import { buildPermissionRequestResolver, type PortalTool } from '../tools/types';
import { buildToolArgsValidator } from '../tools/schema-error';
import { buildClaudePortalTools, createClaudePortalMcpServer } from './claude-agent-tools';
import { ensureClaudeAgentSkills } from './claude-agent-skills';
import { discoverRepoPlugins } from './claude-agent-repo-plugins';
import { pollContextUsage } from './claude-agent-context-usage';
import { fetchWithTimeout, parseJson } from './provider-utils';
import type {
	ModelBackendProvider,
	ProviderCapabilities,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderSession,
	ProviderStatusBehavior,
	ProviderUiInfo
} from './provider';

const providerId = 'claude-agent' as const;
const displayName = 'Claude Agent SDK';
// The only SDK built-in tool still exposed. The SDK coding built-ins
// (Read/Edit/Write/Glob/Grep/Bash) are stripped: the portal twins
// (`mcp__portal__read`/`edit`/`write`/`glob`/`grep`/`shell_exec`) carry those
// jobs, and exposing both duplicates their schemas in every context window.
const BUILTIN_TOOLS = ['Agent'] as const;
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;

type ClaudeAgentConfig = {
	baseUrl?: string | undefined;
	apiKey?: string | undefined;
	maxTurns: number;
};

interface AnthropicModelsResponse {
	data?: Array<{ id?: string; display_name?: string }>;
	error?: { message?: string };
}

const ui: ProviderUiInfo = {
	chatPlaceholder: `Message ${displayName}...`,
	defaultModelPlaceholder: 'claude-sonnet-4-6',
	setupHint:
		'Configure CLAUDE_AGENT_API_KEY. Set CLAUDE_AGENT_BASE_URL for an Anthropic-compatible endpoint such as DeepSeek.',
	setupHintVisibility: 'always'
};

const status: ProviderStatusBehavior = { probe: 'always' };

const capabilities: ProviderCapabilities = {
	authStatus: true,
	modelList: true,
	session: { open: true, resume: true, dispose: true, abort: true },
	stream: { send: true, contract: 'PortalEvent' },
	controls: { mode: true, approvalMode: true, resetSessionApprovals: false },
	features: {
		modes: {
			supported: true,
			behavior: 'supported',
			label: 'Runtime modes',
			description: 'Plan mode is forwarded to the Agent SDK on the next turn.'
		},
		approvalMode: {
			supported: true,
			behavior: 'portal-enforced',
			label: 'Approval mode',
			description: 'The portal enforces approval modes through the Agent SDK permission callback.'
		},
		contextUsage: {
			supported: true,
			behavior: 'supported',
			label: 'Context usage',
			description:
				'Context-window usage is polled from the Agent SDK after each turn via getContextUsage().'
		},
		subagents: {
			supported: true,
			behavior: 'supported',
			label: 'Subagents',
			description: 'The Agent SDK general-purpose subagent is available through its Agent tool.'
		},
		mcpInfoEvents: {
			supported: false,
			behavior: 'unsupported',
			label: 'MCP info events',
			description: 'Agent SDK MCP informational events are not yet exposed.'
		},
		planExit: {
			supported: false,
			behavior: 'unsupported',
			label: 'Plan exit',
			description: 'Plan-exit interaction is not yet bridged to the portal.'
		},
		elicitation: {
			supported: false,
			behavior: 'unsupported',
			label: 'Elicitation',
			description: 'Agent SDK elicitation is not yet bridged to the portal.'
		}
	},
	optionalRuntimeFeatures: {
		infiniteSessionMetadata: false,
		permissionCallbacks: true,
		userInputCallbacks: false,
		elicitationCallbacks: false,
		exitPlanModeCallbacks: false,
		autoModeSwitchCallbacks: false,
		contextWindowEvents: false,
		contextCompactionEvents: true,
		fileEditEvents: false,
		reasoningEvents: true,
		subagentLifecycleEvents: true
	},
	localModelLoad: { primeAfterModelSwap: false },
	sideCompletion: false
};

/**
 * Build a claude-agent provider for one configured instance. The built-in
 * instance (`id === 'claude-agent'`) is exported as `claudeAgentProvider`;
 * extra `ZAP_PROVIDERS_JSON` instances get a per-instance object whose config
 * (base URL, key, pinned models) is captured in the closure while everything
 * else stays shared.
 */
export function createClaudeAgentProvider(instance: ProviderInstance): ModelBackendProvider {
	return {
		id: instance.id,
		type: instance.type,
		displayName: instance.label ?? displayName,
		ui,
		status,
		capabilities,
		async fetchAuthStatus() {
			const cfg = providerConfig(instance);
			return cfg.apiKey
				? {
						isAuthenticated: true,
						authType: 'api-key',
						statusMessage: cfg.baseUrl ?? 'Anthropic API'
					}
				: {
						isAuthenticated: false,
						statusMessage: `${displayName} requires CLAUDE_AGENT_API_KEY.`
					};
		},
		async listModels() {
			const cfg = providerConfig(instance);
			// Pinned models win; then /models discovery on the instance's endpoint;
			// then the manual-entry fallback (empty list).
			if (instance.models && instance.models.length > 0) {
				return instance.models.map((id) => ({ id, name: id }));
			}
			if (cfg.baseUrl) {
				const discovered = await probeAnthropicModels(cfg);
				if (discovered.length > 0) return discovered;
			}
			return [];
		},
		async openSession(opts) {
			const cfg = providerConfig(instance);
			if (!cfg.apiKey) throw new Error(`${displayName} requires CLAUDE_AGENT_API_KEY.`);
			const [skillPluginPaths, repoPluginPaths] = await Promise.all([
				ensureClaudeAgentSkills(loadConfig().DATA_DIR),
				discoverRepoPlugins(opts.workingDirectory)
			]);
			return openClaudeAgentSession(cfg, opts, skillPluginPaths, repoPluginPaths);
		}
	};
}

export const claudeAgentProvider = createClaudeAgentProvider({
	id: providerId,
	type: providerId
});

function providerConfig(instance?: ProviderInstance): ClaudeAgentConfig {
	const cfg = loadConfig();
	return {
		// Configured instances carry their endpoint; built-ins fall back to env so
		// a config reset in tests (or a restarted process) is picked up fresh. A
		// JSON instance never inherits the env key — no key means no auth.
		baseUrl: instance?.baseUrl ?? cfg.CLAUDE_AGENT_BASE_URL,
		apiKey: instance && instance.id !== instance.type ? instance.apiKey : cfg.CLAUDE_AGENT_API_KEY,
		maxTurns: cfg.CLAUDE_AGENT_MAX_TURNS
	};
}

/** Best-effort model discovery against an Anthropic-compatible `/v1/models`. */
async function probeAnthropicModels(cfg: ClaudeAgentConfig): Promise<ProviderModelInfo[]> {
	try {
		const res = await fetchWithTimeout(
			`${cfg.baseUrl!.replace(/\/+$/, '')}/v1/models`,
			{
				headers: {
					...(cfg.apiKey ? { 'x-api-key': cfg.apiKey, authorization: `Bearer ${cfg.apiKey}` } : {}),
					'content-type': 'application/json'
				}
			},
			MODEL_DISCOVERY_TIMEOUT_MS
		);
		const body = (await parseJson(res)) as AnthropicModelsResponse;
		if (!res.ok) {
			log.warn('claude_agent.models_failed', {
				provider: cfg.baseUrl,
				status: res.status,
				err: body.error?.message ?? res.statusText
			});
			return [];
		}
		return (body.data ?? [])
			.filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string')
			.map((m) => ({ id: m.id, name: m.display_name ?? m.id }));
	} catch (e) {
		log.warn('claude_agent.models_failed', { provider: cfg.baseUrl, err: String(e) });
		return [];
	}
}

function queryEnvironment(cfg: ClaudeAgentConfig): Record<string, string | undefined> {
	return isolatedChildEnv(process.env, {
		CLAUDE_AGENT_SDK_CLIENT_APP: 'zap',
		...(cfg.baseUrl
			? {
					ANTHROPIC_BASE_URL: cfg.baseUrl,
					ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
					ANTHROPIC_API_KEY: undefined
				}
			: { ANTHROPIC_API_KEY: cfg.apiKey, ANTHROPIC_AUTH_TOKEN: undefined })
	});
}

function permissionMode(mode: SessionMode): NonNullable<Options['permissionMode']> {
	return mode === 'plan' ? 'plan' : 'default';
}

export function openClaudeAgentSession(
	cfg: ClaudeAgentConfig,
	opts: ProviderOpenOptions,
	skillPluginPaths: string[] = [],
	repoPluginPaths: string[] = []
): ProviderSession {
	let providerSessionId = opts.providerSessionId ?? opts.conversationId;
	let currentMode: SessionMode = opts.mode ?? 'interactive';
	let approvalMode: ApprovalMode = opts.approvalMode ?? 'ask';
	let activeAbortController: AbortController | null = null;
	let activeQueue: AsyncQueue<PortalEvent> | null = null;
	let disposed = false;
	function emit(event: PortalEvent) {
		activeQueue?.push(event);
	}
	// Every tool (except the SDK `Agent` subagent built-in) is a portal tool, and
	// the PreToolUse hook reports the normalized portal name (`shell_exec`, `read`,
	// …), so the force-retry resolver maps it straight to the portal tool that
	// owns the call — no SDK-alias map.
	// Populated after the tool set is assembled (the resolver is only consulted
	// at force-retry approval time, never during construction), so the resolver
	// can be threaded into `buildClaudePortalTools` before the names exist.
	const portalToolsByName = new Map<string, PortalTool>();
	const resolvePortalTool = (name: string): PortalTool | null =>
		portalToolsByName.get(normalizePortalToolName(name)) ?? null;
	const portalTools = buildClaudePortalTools({
		opts,
		getMode: () => currentMode,
		getApprovalMode: () => approvalMode,
		emit,
		getSignal: () => activeAbortController?.signal ?? new AbortController().signal,
		resolvePortalTool
	});
	for (const portalTool of portalTools) portalToolsByName.set(portalTool.name, portalTool);
	const portalMcpServer = createClaudePortalMcpServer(portalTools, {
		emit,
		getSignal: () => activeAbortController?.signal ?? new AbortController().signal
	});
	const validateCustomToolArgs = buildToolArgsValidator(portalTools);
	const derivePermissionRequest = buildPermissionRequestResolver(portalTools);
	const { onPermissionRequest, evaluatePermissionRequest } = createInteractiveCallbacks({
		conversationId: opts.conversationId,
		userId: opts.userId,
		workingDirectory: opts.workingDirectory,
		getWorkspaceRoots: () =>
			workspaceRootsFor(opts.conversationId, opts.userId, opts.workingDirectory),
		policy: opts.policy,
		emit,
		getApprovalMode: () => approvalMode,
		getSessionWorkspacePath: () => opts.workingDirectory,
		getPermissionBehavior: (toolName) =>
			portalToolsByName.get(toolName)?.permissionBehavior ?? 'normal',
		getAgentModel: () => opts.model,
		getAgentBackend: () => opts.provider ?? providerId,
		getAdversaryModel: () => opts.adversaryModel ?? null,
		getAdversaryBackend: () => opts.adversaryBackend ?? null,
		validateCustomToolArgs: (toolName, toolArgs) =>
			validateCustomToolArgs(normalizePortalToolName(toolName), toolArgs),
		derivePermissionRequest: (toolName, toolArgs) =>
			derivePermissionRequest(normalizePortalToolName(toolName), toolArgs)
	});
	const session: ProviderSession = {
		provider: opts.provider ?? providerId,
		conversationId: opts.conversationId,
		providerSessionId,
		workingDirectory: opts.workingDirectory,
		model: opts.model,
		lastUsed: Date.now(),
		async *send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent> {
			if (activeQueue) throw new Error('session busy: a turn is already in progress');
			if (disposed) throw new Error('session disposed');
			const messageId = ulid();
			const queue = new AsyncQueue<PortalEvent>();
			const abortController = new AbortController();
			activeQueue = queue;
			activeAbortController = abortController;
			const onAbort = () => abortController.abort();
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
			void runQuery(prompt, messageId, queue, abortController);
			try {
				for await (const event of queue) {
					opts.onEvent?.(event);
					yield event;
				}
			} finally {
				signal.removeEventListener('abort', onAbort);
				if (activeAbortController === abortController) activeAbortController = null;
				if (activeQueue === queue) activeQueue = null;
				session.lastUsed = Date.now();
			}
		},
		async abort() {
			activeAbortController?.abort();
		},
		async setMode(mode) {
			currentMode = mode;
		},
		async setApprovalMode(mode) {
			approvalMode = mode;
		},
		async dispose() {
			disposed = true;
			activeAbortController?.abort();
		}
	};

	async function runQuery(
		prompt: string,
		messageId: string,
		queue: AsyncQueue<PortalEvent>,
		abortController: AbortController
	) {
		let emittedError = false;
		// One open reasoning burst per emitting agent (top-level + each
		// subagent), keyed by the spawning tool call id ('' for top-level).
		// Closed at every burst boundary — a tool_use, a text delta, or the
		// turn's end — so think/tool interleaving survives per burst instead
		// of fusing the whole turn into one segment.
		const reasoningSegments = new Map<string, { segmentId: string; startedAt: number }>();
		const closeReasoningSegment = (parentToolCallId: string | undefined) => {
			const ownerKey = parentToolCallId ?? '';
			const seg = reasoningSegments.get(ownerKey);
			if (!seg) return;
			queue.push({
				type: 'message.reasoning.end',
				messageId,
				segmentId: seg.segmentId,
				durationMs: Date.now() - seg.startedAt,
				...(parentToolCallId !== undefined ? { parentToolCallId } : {})
			});
			reasoningSegments.delete(ownerKey);
		};
		const toolNames = new Map<string, string>();
		const toolParents = new Map<string, string | undefined>();
		// Pinned skills (downloaded into DATA_DIR) skip MCP discovery — they are
		// skill-only. Project `agent-plugins/` folders keep it enabled so plugins
		// can bring their own `.mcp.json` / manifest mcpServers, matching
		// `claude --plugin-dir` behavior.
		// No `skills` option is set: it is a filter, and omitting it loads every
		// discovered skill from the plugins (SDK docs, v0.3.224).
		const pluginEntries = [
			...skillPluginPaths.map((path) => ({
				type: 'local' as const,
				path,
				skipMcpDiscovery: true
			})),
			...repoPluginPaths.map((path) => ({ type: 'local' as const, path }))
		];
		queue.push({ type: 'message.start', messageId, role: 'assistant' });
		try {
			const response = query({
				prompt,
				options: {
					abortController,
					cwd: opts.workingDirectory,
					env: queryEnvironment(cfg),
					includePartialMessages: true,
					agentProgressSummaries: true,
					allowedTools: ['Agent'],
					canUseTool: async (toolName, input, permissionOptions) => {
						const decision = await onPermissionRequest(
							permissionRequest(
								normalizePortalToolName(toolName),
								input,
								permissionOptions.toolUseID
							)
						);
						if (decision.kind === 'approve-once') {
							return {
								behavior: 'allow',
								updatedInput: input,
								toolUseID: permissionOptions.toolUseID
							};
						}
						return {
							behavior: 'deny',
							message:
								'feedback' in decision && typeof decision.feedback === 'string'
									? decision.feedback
									: 'Permission denied.',
							interrupt: decision.kind === 'user-not-available',
							toolUseID: permissionOptions.toolUseID
						};
					},
					hooks: {
						// Hybrid gate. The PreToolUse hook fires for EVERY tool call
						// (portal MCP tools and subagent inner tool calls) and is the
						// *instant* gate: grants, policy, never-prompt, forced-retry,
						// and approval mode all settle here as a terminal allow/deny
						// with no human await — so the portal gateway stays
						// authoritative even for calls the CLI would auto-approve on
						// its own. On the human-prompt path the hook returns
						// `permissionDecision: 'ask'` and lets the CLI fall through to
						// its own permission flow, which consults `canUseTool` above —
						// the same `onPermissionRequest` → `decideCore` gateway, but
						// awaited through the SDK's unbounded permission prompt
						// instead of the CLI's 600s hook clock. A prompt that is
						// cancelled (turn abort, disconnect) still rejects the pending
						// deferred, so abort paths keep working.
						PreToolUse: [
							{
								hooks: [
									async (hookInput): Promise<HookJSONOutput> => {
										if (hookInput.hook_event_name !== 'PreToolUse') {
											return { continue: true };
										}
										const toolName = normalizePortalToolName(hookInput.tool_name);
										// Subagent spawn tools stay governed by
										// `allowedTools: ['Agent']` — the allowlist is
										// the portal's decision for delegation. Their
										// INNER tool calls fire this same hook and are
										// gated below, which is where the real
										// capability boundary lives.
										if (toolName === 'Agent' || toolName === 'Task') {
											return { continue: true };
										}
										const rawInput = isRecord(hookInput.tool_input) ? hookInput.tool_input : {};
										// Glob and Grep default their search root to the
										// provider cwd when `path` is omitted, so a bare
										// `{pattern}` call carries no path. The permission
										// gateway then derives a null scope key, no fs grant
										// (including the workspace read seed) can match, and
										// under `auto-deny` the call is rejected for a search
										// that would have been scoped to the workspace anyway.
										// Synthesize the path the SDK WILL use (the cwd), verify
										// against it, and hand the same input back via
										// `updatedInput` so the executed call matches what was
										// checked. `workingDirectory` is the deterministic
										// default, so the verified path is always the used one —
										// no ask-for-path fallback needed.
										let input = rawInput;
										if (
											(toolName === 'glob' || toolName === 'grep') &&
											typeof rawInput.path !== 'string'
										) {
											input = { ...rawInput, path: opts.workingDirectory };
										}
										const evaluation = await evaluatePermissionRequest(
											permissionRequest(toolName, input, hookInput.tool_use_id)
										);
										if (evaluation.kind === 'prompt') {
											return {
												hookSpecificOutput: {
													hookEventName: 'PreToolUse',
													permissionDecision: 'ask'
												}
											};
										}
										if (evaluation.kind === 'approve-once') {
											return {
												hookSpecificOutput: {
													hookEventName: 'PreToolUse',
													permissionDecision: 'allow',
													...(input !== rawInput ? { updatedInput: input } : {})
												}
											};
										}
										return {
											hookSpecificOutput: {
												hookEventName: 'PreToolUse',
												permissionDecision: 'deny',
												permissionDecisionReason: evaluation.feedback ?? 'Permission denied.'
											}
										};
									}
								]
							}
						]
					},
					maxTurns: cfg.maxTurns,
					mcpServers: { portal: portalMcpServer },
					model: opts.model,
					...(pluginEntries.length > 0 ? { plugins: pluginEntries } : {}),
					forwardSubagentText: true,
					permissionMode: permissionMode(currentMode),
					settingSources: [],
					strictMcpConfig: true,
					systemPrompt: {
						type: 'preset',
						preset: 'claude_code',
						append: buildPortalSystemGuidance(portalTools.map((portalTool) => portalTool.name))
					},
					tools: [...BUILTIN_TOOLS],
					...(providerSessionId !== opts.conversationId ? { resume: providerSessionId } : {})
				}
			});
			for await (const message of response) {
				if (message.type === 'system' && message.subtype === 'init') {
					if (message.session_id !== providerSessionId) {
						await opts.onProviderSessionIdChange?.(message.session_id);
						providerSessionId = message.session_id;
						session.providerSessionId = message.session_id;
					}
					continue;
				}
				if (message.type === 'system' && message.subtype === 'compact_boundary') {
					queue.push({ type: 'context.compaction', phase: 'complete' });
					continue;
				}
				if (
					message.type === 'system' &&
					message.subtype === 'status' &&
					message.status === 'compacting'
				) {
					queue.push({ type: 'context.compaction', phase: 'start' });
					continue;
				}
				if (message.type === 'assistant') {
					for (const block of message.message.content) {
						if (block.type === 'tool_use') {
							const toolName = normalizePortalToolName(block.name);
							// SDK subagent spawns keep the client-facing canonical name
							// `task` (matching the Copilot backend) so the existing
							// SubagentCall card, trim exemption, and child selection all
							// apply unchanged. Inner tool calls keep their real names.
							const portalToolName =
								toolName === 'Agent' || toolName === 'Task' ? 'task' : toolName;
							const parentToolCallId = message.parent_tool_use_id ?? undefined;
							// A tool_use ends this agent's current thinking burst.
							closeReasoningSegment(parentToolCallId);
							toolNames.set(block.id, toolName);
							toolParents.set(block.id, parentToolCallId);
							queue.push({
								type: 'tool.call',
								toolCallId: block.id,
								tool: portalToolName,
								args: block.input,
								...(parentToolCallId !== undefined ? { parentToolCallId } : {})
							});
							if (toolName === 'Agent' || toolName === 'Task') {
								queue.push({
									type: 'subagent.lifecycle',
									toolCallId: block.id,
									agentId: block.id,
									status: 'running'
								});
							}
						} else if (block.type === 'text' && message.parent_tool_use_id) {
							// A sub-agent's spoken output ends its current thinking burst.
							closeReasoningSegment(message.parent_tool_use_id);
							queue.push({
								type: 'message.delta',
								messageId,
								text: block.text,
								parentToolCallId: message.parent_tool_use_id,
								segmentId: message.uuid
							});
						}
					}
					continue;
				}
				if (message.type === 'user' && Array.isArray(message.message.content)) {
					for (const block of message.message.content) {
						if (block.type !== 'tool_result') continue;
						const output = toolResultText(block.content);
						const parentToolCallId = toolParents.get(block.tool_use_id);
						queue.push({
							type: 'tool.result',
							toolCallId: block.tool_use_id,
							ok: block.is_error !== true,
							summary: compactSummary(output),
							output,
							...(parentToolCallId !== undefined ? { parentToolCallId } : {})
						});
						const toolName = toolNames.get(block.tool_use_id);
						if (toolName === 'Agent' || toolName === 'Task') {
							queue.push({
								type: 'subagent.lifecycle',
								toolCallId: block.tool_use_id,
								agentId: block.tool_use_id,
								status: block.is_error === true ? 'failed' : 'completed'
							});
						}
					}
					continue;
				}
				if (message.type === 'tool_progress') {
					queue.push({
						type: 'tool.progress',
						toolCallId: message.tool_use_id,
						message:
							message.subagent_retry?.error_category ??
							`${message.tool_name} running for ${message.elapsed_time_seconds}s`,
						...(message.parent_tool_use_id !== null
							? { parentToolCallId: message.parent_tool_use_id }
							: {})
					});
					continue;
				}
				if (message.type === 'stream_event') {
					const delta = streamDelta(message);
					const parentToolCallId = message.parent_tool_use_id ?? undefined;
					if (delta?.kind === 'reasoning') {
						const ownerKey = parentToolCallId ?? '';
						let seg = reasoningSegments.get(ownerKey);
						if (!seg) {
							seg = { segmentId: ulid(), startedAt: Date.now() };
							reasoningSegments.set(ownerKey, seg);
						}
						queue.push({
							type: 'message.reasoning',
							messageId,
							segmentId: seg.segmentId,
							text: delta.text,
							...(parentToolCallId !== undefined ? { parentToolCallId } : {})
						});
					} else if (delta?.kind === 'text') {
						closeReasoningSegment(parentToolCallId);
						queue.push({ type: 'message.delta', messageId, text: delta.text });
					}
					continue;
				}
				if (message.type === 'result' && message.subtype !== 'success') {
					emittedError = true;
					queue.push({
						type: 'error',
						code: message.subtype,
						message: message.errors.join('\n') || 'Claude Agent SDK query failed.'
					});
				}
				// Poll the live context window once the turn succeeds. The control
				// request only works while the CLI subprocess is still running, so it
				// must happen inside this loop, right after `result`. Failures are
				// swallowed by the wrapper; the meter simply stays stale for that turn.
				if (message.type === 'result' && message.subtype === 'success') {
					const usageEvent = await pollContextUsage(response);
					if (usageEvent) queue.push(usageEvent);
				}
			}
		} catch (error) {
			if (!emittedError) {
				const aborted = abortController.signal.aborted;
				if (!aborted) {
					log.warn('claude_agent.session.send_failed', {
						conversationId: opts.conversationId,
						err: String(error)
					});
				}
				queue.push({
					type: 'error',
					code: aborted ? 'aborted' : 'send_failed',
					message: aborted
						? 'Aborted by client.'
						: error instanceof Error
							? error.message
							: String(error)
				});
			}
		} finally {
			for (const [parentToolCallId, seg] of reasoningSegments) {
				queue.push({
					type: 'message.reasoning.end',
					messageId,
					segmentId: seg.segmentId,
					durationMs: Date.now() - seg.startedAt,
					...(parentToolCallId ? { parentToolCallId } : {})
				});
			}
			reasoningSegments.clear();
			queue.push({ type: 'message.end', messageId });
			queue.push({ type: 'done' });
			queue.end();
		}
	}

	return session;
}

function normalizePortalToolName(toolName: string): string {
	return toolName.startsWith('mcp__portal__') ? toolName.slice('mcp__portal__'.length) : toolName;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolResultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return content === undefined ? '' : JSON.stringify(content);
	return content
		.map((part) => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object' && 'text' in part) {
				const text = (part as { text?: unknown }).text;
				return typeof text === 'string' ? text : JSON.stringify(part);
			}
			return JSON.stringify(part);
		})
		.join('\n');
}

function compactSummary(text: string): string {
	const summary = text.replace(/\s+/g, ' ').trim();
	if (!summary) return '(empty result)';
	return summary.length > 200 ? `${summary.slice(0, 197)}...` : summary;
}

function permissionRequest(toolName: string, input: Record<string, unknown>, toolCallId: string) {
	const path =
		typeof input.file_path === 'string'
			? input.file_path
			: typeof input.path === 'string'
				? input.path
				: undefined;
	// Portal tools key the permission kind directly by name: shell_exec → shell,
	// read/glob/grep → read, edit → edit, write → write. The SDK coding built-ins
	// are no longer exposed, so there are no alias names to map.
	if (toolName === 'shell_exec') {
		const command = typeof input.command === 'string' ? input.command : undefined;
		return {
			kind: 'shell',
			toolName,
			toolCallId,
			...(command !== undefined ? { fullCommandText: command } : {}),
			args: input
		};
	}
	if (toolName === 'read' || toolName === 'glob' || toolName === 'grep') {
		return {
			kind: 'read',
			toolName,
			toolCallId,
			...(path !== undefined ? { path } : {}),
			args: input
		};
	}
	if (toolName === 'edit') {
		return {
			kind: 'edit',
			toolName,
			toolCallId,
			...(path !== undefined ? { path } : {}),
			args: input
		};
	}
	if (toolName === 'write') {
		return {
			kind: 'write',
			toolName,
			toolCallId,
			...(path !== undefined ? { path } : {}),
			args: input
		};
	}
	return { kind: 'custom-tool', toolName, toolCallId, args: input };
}

function streamDelta(
	message: Extract<SDKMessage, { type: 'stream_event' }>
): { kind: 'text' | 'reasoning'; text: string } | null {
	const event = message.event;
	if (event.type !== 'content_block_delta') return null;
	if (event.delta.type === 'text_delta') return { kind: 'text', text: event.delta.text };
	if (event.delta.type === 'thinking_delta') {
		return { kind: 'reasoning', text: event.delta.thinking };
	}
	return null;
}
