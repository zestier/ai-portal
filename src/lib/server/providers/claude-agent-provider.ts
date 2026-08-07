import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ulid } from 'ulid';
import type { ApprovalMode, PortalEvent, SessionMode } from '$lib/types';
import { loadConfig } from '../config';
import { log } from '../log';
import { workspaceRootsFor } from '../leases';
import { AsyncQueue } from '../runtime/async-queue';
import { buildPortalSystemGuidance } from '../runtime/system-guidance';
import { createInteractiveCallbacks } from '../copilot/interactive-adapter';
import { buildPermissionRequestResolver } from '../tools/types';
import { buildToolArgsValidator } from '../tools/schema-error';
import { buildClaudePortalTools, createClaudePortalMcpServer } from './claude-agent-tools';
import type { ModelBackendProvider, ProviderOpenOptions, ProviderSession } from './provider';

const providerId = 'claude-agent' as const;
const displayName = 'Claude Agent SDK';
const BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent'] as const;

type ClaudeAgentConfig = {
	baseUrl?: string | undefined;
	apiKey?: string | undefined;
	maxTurns: number;
};

export const claudeAgentProvider: ModelBackendProvider = {
	id: providerId,
	displayName,
	ui: {
		chatPlaceholder: `Message ${displayName}...`,
		defaultModelPlaceholder: 'claude-sonnet-4-6',
		setupHint:
			'Configure CLAUDE_AGENT_API_KEY. Set CLAUDE_AGENT_BASE_URL for an Anthropic-compatible endpoint such as DeepSeek.',
		setupHintVisibility: 'always'
	},
	status: { probe: 'always' },
	capabilities: {
		authStatus: true,
		modelList: false,
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
				supported: false,
				behavior: 'unsupported',
				label: 'Context usage',
				description: 'Agent SDK context usage is not emitted by this initial provider slice.'
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
	},
	async fetchAuthStatus() {
		const cfg = providerConfig();
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
		return [];
	},
	async openSession(opts) {
		const cfg = providerConfig();
		if (!cfg.apiKey) throw new Error(`${displayName} requires CLAUDE_AGENT_API_KEY.`);
		return openClaudeAgentSession(cfg, opts);
	}
};

function providerConfig(): ClaudeAgentConfig {
	const cfg = loadConfig();
	return {
		baseUrl: cfg.CLAUDE_AGENT_BASE_URL,
		apiKey: cfg.CLAUDE_AGENT_API_KEY,
		maxTurns: cfg.CLAUDE_AGENT_MAX_TURNS
	};
}

function queryEnvironment(cfg: ClaudeAgentConfig): Record<string, string | undefined> {
	return {
		...process.env,
		CLAUDE_AGENT_SDK_CLIENT_APP: 'zap',
		...(cfg.baseUrl
			? {
					ANTHROPIC_BASE_URL: cfg.baseUrl,
					ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
					ANTHROPIC_API_KEY: undefined
				}
			: { ANTHROPIC_API_KEY: cfg.apiKey, ANTHROPIC_AUTH_TOKEN: undefined })
	};
}

function permissionMode(mode: SessionMode): NonNullable<Options['permissionMode']> {
	return mode === 'plan' ? 'plan' : 'default';
}

export function openClaudeAgentSession(
	cfg: ClaudeAgentConfig,
	opts: ProviderOpenOptions
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
	const portalTools = buildClaudePortalTools({
		opts,
		getMode: () => currentMode,
		getApprovalMode: () => approvalMode,
		emit,
		getSignal: () => activeAbortController?.signal ?? new AbortController().signal
	});
	const portalToolsBySdkName = new Map<string, (typeof portalTools)[number]>(
		portalTools.map((portalTool) => [`mcp__portal__${portalTool.name}`, portalTool] as const)
	);
	const portalMcpServer = createClaudePortalMcpServer(portalTools, {
		emit,
		getSignal: () => activeAbortController?.signal ?? new AbortController().signal
	});
	const validateCustomToolArgs = buildToolArgsValidator(portalTools);
	const derivePermissionRequest = buildPermissionRequestResolver(portalTools);
	const { onPermissionRequest } = createInteractiveCallbacks({
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
			portalToolsBySdkName.get(toolName)?.permissionBehavior ?? 'normal',
		getAgentModel: () => opts.model,
		getAgentBackend: () => providerId,
		getAdversaryModel: () => opts.adversaryModel ?? null,
		getAdversaryBackend: () => opts.adversaryBackend ?? null,
		validateCustomToolArgs: (toolName, toolArgs) =>
			validateCustomToolArgs(normalizePortalToolName(toolName), toolArgs),
		derivePermissionRequest: (toolName, toolArgs) =>
			derivePermissionRequest(normalizePortalToolName(toolName), toolArgs)
	});
	const session: ProviderSession = {
		provider: providerId,
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
		let reasoningSegmentId: string | null = null;
		let reasoningStartedAt = 0;
		let emittedError = false;
		const toolNames = new Map<string, string>();
		const toolParents = new Map<string, string | undefined>();
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
					maxTurns: cfg.maxTurns,
					mcpServers: { portal: portalMcpServer },
					model: opts.model,
					forwardSubagentText: true,
					permissionMode: permissionMode(currentMode),
					settingSources: [],
					strictMcpConfig: true,
					systemPrompt: {
						type: 'preset',
						preset: 'claude_code',
						append: buildPortalSystemGuidance([
							...BUILTIN_TOOLS,
							...portalTools.map((portalTool) => portalTool.name)
						])
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
							const parentToolCallId = message.parent_tool_use_id ?? undefined;
							toolNames.set(block.id, toolName);
							toolParents.set(block.id, parentToolCallId);
							queue.push({
								type: 'tool.call',
								toolCallId: block.id,
								tool: toolName,
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
					if (delta?.kind === 'reasoning') {
						if (!reasoningSegmentId) {
							reasoningSegmentId = ulid();
							reasoningStartedAt = Date.now();
						}
						queue.push({
							type: 'message.reasoning',
							messageId,
							segmentId: reasoningSegmentId,
							text: delta.text
						});
					} else if (delta?.kind === 'text') {
						if (reasoningSegmentId) {
							queue.push({
								type: 'message.reasoning.end',
								messageId,
								segmentId: reasoningSegmentId,
								durationMs: Date.now() - reasoningStartedAt
							});
							reasoningSegmentId = null;
						}
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
			if (reasoningSegmentId) {
				queue.push({
					type: 'message.reasoning.end',
					messageId,
					segmentId: reasoningSegmentId,
					durationMs: Date.now() - reasoningStartedAt
				});
			}
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
			: typeof input.notebook_path === 'string'
				? input.notebook_path
				: typeof input.path === 'string'
					? input.path
					: undefined;
	if (toolName === 'Bash') {
		const command = typeof input.command === 'string' ? input.command : undefined;
		return {
			kind: 'shell',
			toolName,
			toolCallId,
			...(command !== undefined ? { fullCommandText: command } : {}),
			args: input
		};
	}
	if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
		return {
			kind: 'read',
			toolName,
			toolCallId,
			...(path !== undefined ? { path } : {}),
			args: input
		};
	}
	if (toolName === 'Edit' || toolName === 'NotebookEdit') {
		return {
			kind: 'edit',
			toolName,
			toolCallId,
			...(path !== undefined ? { path } : {}),
			args: input
		};
	}
	if (toolName === 'Write') {
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
