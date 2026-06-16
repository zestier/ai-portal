import { ulid } from 'ulid';
import { loadConfig } from '../config';
import { log } from '../log';
import { ticketWorkspaceFromConversation } from '../ticket-workspace';
import { buildGitTools, type PortalTool, type ToolStreamContext } from '../tools/git';
import {
	err,
	deriveToolResultViews,
	parseEnvelopeJson,
	buildPermissionRequestResolver,
	type ToolResult
} from '../tools/types';
import { buildPermissionTools } from '../tools/permissions';
import { buildFilesystemTools } from '../tools/filesystem';
import { validatePortalToolArgs } from '../tools/schema-error';
import { buildTicketTools } from '../tools/tickets';
import { buildMemoryTools } from '../tools/memory';
import { fetchWithTimeout, jsonRequestHeaders, parseJson, streamSseData } from './provider-utils';
import type { BackendProviderId, PortalEvent, SessionMode, ToolCallRecord } from '$lib/types';
import { AsyncQueue } from '../runtime/async-queue';
import { createInteractiveCallbacks } from '../copilot/interactive-adapter';
import type {
	ModelBackendProvider,
	ProviderAuthStatus,
	ProviderConversationMessage,
	ProviderModelInfo,
	ProviderOpenOptions,
	ProviderSession
} from './provider';

export interface OpenAICompatibleConfig {
	id: BackendProviderId;
	displayName: string;
	baseUrl: string | null;
	apiKey: string | null;
	maxToolIterations: number;
	contextRestoreMessages: number;
	sampling: OpenAICompatibleSamplingOptions;
	contextTokenLimit?: number | null;
	includeUsage?: boolean;
}

export interface OpenAICompatibleSamplingOptions {
	temperature?: number;
	top_p?: number;
	presence_penalty?: number;
	frequency_penalty?: number;
}

interface ChatChoiceDelta {
	content?: unknown;
	tool_calls?: OpenAIToolCallDelta[];
}

interface ChatStreamChunk {
	choices?: Array<{
		delta?: ChatChoiceDelta;
		message?: {
			content?: unknown;
			tool_calls?: OpenAIToolCall[];
		};
		text?: unknown;
		finish_reason?: string | null;
	}>;
	error?: {
		message?: string;
	};
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
	};
}

interface OpenAIToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

interface OpenAIToolCallDelta {
	index?: number;
	id?: string;
	type?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

type ChatMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
	| { role: 'tool'; tool_call_id: string; content: string };

interface AssistantTurn {
	content: string;
	toolCalls: OpenAIToolCall[];
	usage?: ChatStreamChunk['usage'];
}

interface ToolExecutionResult {
	ok: boolean;
	summary: string;
	// Full serialized envelope persisted/streamed for the UI (`tool.result.output`).
	output: string;
	// Concise, RAW text fed back to the model as the tool message content.
	modelText: string;
}

interface ModelsResponse {
	data?: Array<{
		id?: string;
		name?: string;
	}>;
	error?: {
		message?: string;
	};
}

const providerId = 'openai-compatible' satisfies Extract<BackendProviderId, 'openai-compatible'>;
const displayName = 'OpenAI compatible';
const MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
const CHAT_RESPONSE_TIMEOUT_MS = 120_000;

export const openAICompatibleProvider: ModelBackendProvider = {
	id: providerId,
	displayName,
	ui: {
		chatPlaceholder: `Message ${displayName}...`,
		defaultModelPlaceholder: 'model-id',
		setupHint:
			'Configure OPENAI_COMPATIBLE_BASE_URL to a local or remote OpenAI-compatible /v1 endpoint. Add OPENAI_COMPATIBLE_API_KEY only if the backend requires bearer auth.',
		setupHintVisibility: 'always'
	},
	status: {
		probe: 'always'
	},
	capabilities: {
		authStatus: true,
		modelList: true,
		session: {
			open: true,
			resume: false,
			dispose: true,
			abort: true
		},
		stream: {
			send: true,
			contract: 'PortalEvent'
		},
		controls: {
			mode: false,
			approveAll: true,
			resetSessionApprovals: false
		},
		features: {
			modes: {
				supported: false,
				behavior: 'no-op',
				label: 'Runtime modes',
				description:
					'OpenAI-compatible backends do not expose Copilot runtime modes. The saved mode is retained for portal permission semantics; it is not sent to the model provider.'
			},
			approveAll: {
				supported: true,
				behavior: 'portal-enforced',
				label: 'Approve all',
				description:
					'Approve-all is enforced by the portal for portal-hosted tools. OpenAI-compatible backends do not receive a separate runtime approve-all signal.'
			},
			contextUsage: {
				supported: true,
				behavior: 'supported',
				label: 'Context usage',
				description:
					'OpenAI-compatible usage is shown when the backend streams token usage and a model context window is known.'
			},
			subagents: {
				supported: false,
				behavior: 'unsupported',
				label: 'Subagents',
				description:
					'The Copilot subagent/task runtime is unavailable; subagent tools and lifecycle events are not exposed.'
			},
			mcpInfoEvents: {
				supported: false,
				behavior: 'unsupported',
				label: 'MCP info events',
				description:
					'MCP sampling, OAuth, and external-tool info events are Copilot SDK events and are not emitted by OpenAI-compatible sessions.'
			},
			planExit: {
				supported: false,
				behavior: 'unsupported',
				label: 'Plan exit',
				description:
					'OpenAI-compatible sessions do not support Copilot plan-exit callbacks; there is no plan approval dialog to exit.'
			},
			elicitation: {
				supported: false,
				behavior: 'unsupported',
				label: 'Elicitation',
				description:
					'OpenAI-compatible sessions do not support Copilot elicitation callbacks; no elicitation dialogs are raised.'
			}
		},
		optionalRuntimeFeatures: {
			infiniteSessionMetadata: false,
			permissionCallbacks: true,
			userInputCallbacks: false,
			elicitationCallbacks: false,
			exitPlanModeCallbacks: false,
			autoModeSwitchCallbacks: false,
			contextWindowEvents: true,
			contextCompactionEvents: false,
			fileEditEvents: false,
			reasoningEvents: false,
			subagentLifecycleEvents: false
		}
	},
	async fetchAuthStatus(): Promise<ProviderAuthStatus> {
		const cfg = providerConfig();
		if (!cfg.baseUrl) {
			return {
				isAuthenticated: false,
				statusMessage: `${displayName} requires a base URL.`
			};
		}
		return {
			isAuthenticated: true,
			authType: cfg.apiKey ? 'api-key' : 'none',
			statusMessage: cfg.baseUrl
		};
	},
	async listModels(): Promise<ProviderModelInfo[]> {
		const cfg = providerConfig();
		if (!cfg.baseUrl) return [];
		try {
			const res = await fetchWithTimeout(
				endpoint(cfg.baseUrl, '/models'),
				{
					headers: requestHeaders(cfg)
				},
				MODEL_DISCOVERY_TIMEOUT_MS
			);
			const body = (await parseJson(res)) as ModelsResponse;
			if (!res.ok) {
				log.warn('openai_compatible.models_failed', {
					provider: cfg.id,
					status: res.status,
					err: body.error?.message ?? res.statusText
				});
				return [];
			}
			return (body.data ?? [])
				.filter((m): m is { id: string; name?: string } => typeof m.id === 'string')
				.map((m) => ({ id: m.id, name: m.name ?? m.id }));
		} catch (e) {
			log.warn('openai_compatible.models_failed', {
				provider: cfg.id,
				err: String(e)
			});
			return [];
		}
	},
	async openSession(opts: ProviderOpenOptions): Promise<ProviderSession> {
		const cfg = providerConfig();
		if (!cfg.baseUrl) throw new Error(`${displayName} requires a base URL.`);
		return openOpenAICompatibleSession(cfg, opts);
	}
};

function providerConfig(): OpenAICompatibleConfig {
	const cfg = loadConfig();
	return {
		id: providerId,
		displayName,
		baseUrl: cfg.OPENAI_COMPATIBLE_BASE_URL ?? null,
		apiKey: cfg.OPENAI_COMPATIBLE_API_KEY ?? null,
		maxToolIterations: cfg.OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS,
		contextRestoreMessages: cfg.OPENAI_COMPATIBLE_CONTEXT_RESTORE_MESSAGES,
		sampling: openAICompatibleSamplingOptions(cfg)
	};
}

export function openAICompatibleSamplingOptions(cfg: {
	OPENAI_COMPATIBLE_TEMPERATURE?: number;
	OPENAI_COMPATIBLE_TOP_P?: number;
	OPENAI_COMPATIBLE_PRESENCE_PENALTY?: number;
	OPENAI_COMPATIBLE_FREQUENCY_PENALTY?: number;
}): OpenAICompatibleSamplingOptions {
	return {
		...(cfg.OPENAI_COMPATIBLE_TEMPERATURE !== undefined
			? { temperature: cfg.OPENAI_COMPATIBLE_TEMPERATURE }
			: {}),
		...(cfg.OPENAI_COMPATIBLE_TOP_P !== undefined ? { top_p: cfg.OPENAI_COMPATIBLE_TOP_P } : {}),
		...(cfg.OPENAI_COMPATIBLE_PRESENCE_PENALTY !== undefined
			? { presence_penalty: cfg.OPENAI_COMPATIBLE_PRESENCE_PENALTY }
			: {}),
		...(cfg.OPENAI_COMPATIBLE_FREQUENCY_PENALTY !== undefined
			? { frequency_penalty: cfg.OPENAI_COMPATIBLE_FREQUENCY_PENALTY }
			: {})
	};
}

function requestHeaders(cfg: OpenAICompatibleConfig): HeadersInit {
	return jsonRequestHeaders(cfg.apiKey);
}

function endpoint(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, '');
	return `${base}${path}`;
}

function stringContent(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((part) => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object' && 'text' in part) {
				const text = (part as { text?: unknown }).text;
				return typeof text === 'string' ? text : '';
			}
			return '';
		})
		.join('');
}

function chunkText(chunk: ChatStreamChunk): string {
	const choice = chunk.choices?.[0];
	return (
		stringContent(choice?.delta?.content) ||
		stringContent(choice?.message?.content) ||
		stringContent(choice?.text)
	);
}

function backendErrorMessage(cfg: OpenAICompatibleConfig, e: unknown): string {
	if (e instanceof Error && e.name === 'TimeoutError') {
		return `Timed out connecting to ${cfg.displayName} backend at ${cfg.baseUrl}. Check that the server is reachable from the portal process.`;
	}
	if (e instanceof Error && e.name === 'AbortError') return 'Aborted by client.';
	if (e instanceof TypeError) {
		return `Unable to connect to ${cfg.displayName} backend at ${cfg.baseUrl}. Check that the server is running and OPENAI_COMPATIBLE_BASE_URL points at its /v1 endpoint.`;
	}
	return e instanceof Error ? e.message : String(e);
}

async function* streamChatCompletionTurn(
	cfg: OpenAICompatibleConfig,
	res: Response,
	messageId: string
): AsyncGenerator<PortalEvent, AssistantTurn, void> {
	if (!res.ok) {
		const body = (await parseJson(res)) as ChatStreamChunk;
		throw new Error(body.error?.message ?? `${cfg.displayName} chat failed: ${res.status}`);
	}
	if (!res.body) throw new Error(`${cfg.displayName} chat response did not include a body.`);

	let content = '';
	const toolCallParts: OpenAIToolCall[] = [];
	let lastToolCallIndex = -1;
	let usage: ChatStreamChunk['usage'];
	for await (const data of streamSseData(res.body)) {
		if (data === '[DONE]') break;
		const chunk = JSON.parse(data) as ChatStreamChunk;
		if (chunk.error?.message) throw new Error(chunk.error.message);
		if (chunk.usage) usage = chunk.usage;
		const text = chunkText(chunk);
		if (text) {
			content += text;
			yield { type: 'message.delta', messageId, text };
		}
		const choice = chunk.choices?.[0];
		for (const toolCall of choice?.message?.tool_calls ?? []) {
			toolCallParts.push(toolCall);
		}
		for (const delta of choice?.delta?.tool_calls ?? []) {
			lastToolCallIndex = applyToolCallDelta(toolCallParts, delta, lastToolCallIndex);
		}
	}
	return { content, toolCalls: finalizeToolCalls(toolCallParts), usage };
}

export function openOpenAICompatibleSession(
	cfg: OpenAICompatibleConfig,
	opts: ProviderOpenOptions
): ProviderSession {
	const providerSessionId = opts.providerSessionId ?? opts.conversationId;
	let aborted = false;
	let disposed = false;
	let activeAbortController: AbortController | null = null;
	let activeQueue: AsyncQueue<PortalEvent> | null = null;
	let approveAllTools = opts.approveAllTools === true;
	let currentMode: SessionMode = opts.mode ?? 'interactive';
	const messages: ChatMessage[] = restoreInitialMessages(cfg, opts);

	function emit(ev: PortalEvent) {
		activeQueue?.push(ev);
	}

	async function applyMode(mode: SessionMode): Promise<void> {
		currentMode = mode;
	}

	async function applyApproveAll(enabled: boolean): Promise<void> {
		approveAllTools = enabled;
	}

	const tools = buildOpenAITools({
		opts,
		getMode: () => currentMode
	});
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	const toolPermissionBehavior = new Map<string, 'normal' | 'always-prompt' | 'never-prompt'>(
		tools.map((tool) => [tool.name, tool.permissionBehavior ?? 'normal'] as const)
	);
	const { onPermissionRequest } = createInteractiveCallbacks({
		conversationId: opts.conversationId,
		userId: opts.userId,
		workingDirectory: opts.workingDirectory,
		policy: opts.policy,
		emit,
		getApproveAll: () => approveAllTools,
		getMode: () => currentMode,
		// An openai-compatible provider has no separate SDK session workspace;
		// its working directory IS the session workspace, so align it with the
		// root the fs-write seed matches (`session-workspace`).
		getSessionWorkspacePath: () => opts.workingDirectory,
		getPermissionBehavior: (tool) => toolPermissionBehavior.get(tool) ?? 'normal',
		derivePermissionRequest: buildPermissionRequestResolver(tools)
	});

	const openAITools = tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));

	async function runTurn(prompt: string, q: AsyncQueue<PortalEvent>, messageId: string) {
		q.push({ type: 'message.start', messageId, role: 'assistant' });
		if (disposed) {
			q.push({ type: 'error', code: 'session_disposed', message: 'Session disposed.' });
			return;
		}
		messages.push({ role: 'user', content: prompt });
		for (let iteration = 0; iteration < cfg.maxToolIterations; iteration += 1) {
			const messagesLength = messages.length;
			const res = await fetchWithTimeout(
				endpoint(cfg.baseUrl!, '/chat/completions'),
				{
					method: 'POST',
					headers: requestHeaders(cfg),
					body: JSON.stringify({
						model: opts.model,
						messages,
						tools: openAITools,
						tool_choice: 'auto',
						stream: true,
						...cfg.sampling,
						...(cfg.includeUsage ? { stream_options: { include_usage: true } } : {})
					}),
					signal: activeAbortController?.signal
				},
				CHAT_RESPONSE_TIMEOUT_MS
			);
			const turn = yieldFromQueue(streamChatCompletionTurn(cfg, res, messageId), q);
			const assistantTurn = await turn;
			if (aborted) return;
			emitContextUsage(q, cfg, assistantTurn.usage, messagesLength);
			messages.push({
				role: 'assistant',
				content: assistantTurn.content || null,
				...(assistantTurn.toolCalls.length > 0 ? { tool_calls: assistantTurn.toolCalls } : {})
			});
			if (assistantTurn.toolCalls.length === 0) return;
			for (const toolCall of assistantTurn.toolCalls) {
				if (aborted) return;
				const result = await executeToolCall(toolCall, q);
				messages.push({
					role: 'tool',
					tool_call_id: toolCall.id,
					content: toolMessageContent(result)
				});
			}
		}
		q.push({
			type: 'error',
			code: 'max_tool_iterations',
			message: `${cfg.displayName} stopped after ${cfg.maxToolIterations} tool-calling iterations without a final assistant response.`
		});
	}

	async function executeToolCall(
		toolCall: OpenAIToolCall,
		q: AsyncQueue<PortalEvent>
	): Promise<ToolExecutionResult> {
		// Project the handler's `ToolResult` envelope into its two views via the
		// shared derive step (same one the SDK edge uses). The model receives the
		// concise, RAW `modelText` as its tool-message content; the UI receives
		// the full serialized envelope as `output`. Splitting them here is what
		// stops multi-line payloads reaching the model JSON-escaped.
		const finish = (envelope: ToolResult): ToolExecutionResult => {
			const views = deriveToolResultViews(envelope);
			q.push({
				type: 'tool.result',
				toolCallId: toolCall.id,
				ok: views.ok,
				summary: views.summary,
				output: views.fullContent
			});
			return {
				ok: views.ok,
				summary: views.summary,
				output: views.fullContent,
				modelText: views.modelText
			};
		};

		const parsedArgs = parseToolArguments(toolCall.function.arguments);
		const args = parsedArgs.ok ? parsedArgs.args : toolCall.function.arguments;
		q.push({
			type: 'tool.call',
			toolCallId: toolCall.id,
			tool: toolCall.function.name || '(missing tool name)',
			args
		});
		if (!parsedArgs.ok) {
			return finish(err(parsedArgs.error));
		}
		const tool = toolsByName.get(toolCall.function.name);
		if (!tool) {
			return finish(
				err(
					toolCall.function.name
						? `Unknown portal tool requested: ${toolCall.function.name}`
						: 'Tool call did not include a function name.'
				)
			);
		}
		// Validate args against the tool's Zod schema *before* opening a
		// permission request. Misuse of a tool's argument schema is the
		// agent's bug, not something the user should be asked to
		// approve. Returning the schema in the rejection lets the agent
		// self-correct on the next turn without a permission round-trip.
		const validation = validatePortalToolArgs(tool, parsedArgs.args);
		if (!validation.ok) {
			return finish(err(validation.feedback));
		}
		// Per-call streaming channel bound to this tool call's id. Emits onto the
		// owned, single-consumer FIFO queue `q`; `tool.call` was already pushed
		// above and `tool.result` is pushed synchronously after the handler's
		// `await` returns, so partials always interleave between them. Gated on
		// `aborted` so a cancelled turn stops fanning out stale chunks.
		const ctx: ToolStreamContext = {
			partial(output) {
				if (!aborted) q.push({ type: 'tool.partial_output', toolCallId: toolCall.id, output });
			},
			progress(message) {
				if (!aborted) q.push({ type: 'tool.progress', toolCallId: toolCall.id, message });
			},
			signal: activeAbortController?.signal ?? new AbortController().signal
		};
		const runHandler = async (): Promise<ToolExecutionResult> => {
			try {
				return finish(await tool.handler(parsedArgs.args, ctx));
			} catch (e) {
				// Central try/catch normalizes thrown exceptions into the same
				// `{ ok: false, error }` envelope handlers may return directly.
				return finish(err(e instanceof Error ? e.message : String(e)));
			}
		};
		if (tool.permissionBehavior === 'never-prompt') {
			return runHandler();
		}
		const permission = await onPermissionRequest({
			kind: 'custom-tool',
			toolName: tool.name,
			toolCallId: toolCall.id,
			toolDescription: tool.description,
			intention: `Run portal tool ${tool.name}`,
			args: parsedArgs.args
		});
		// createInteractiveCallbacks returns SDK permission decisions, not the portal dialog shape.
		if (!permission || permission.kind !== 'approve-once') {
			const feedback =
				permission && 'feedback' in permission && typeof permission.feedback === 'string'
					? permission.feedback
					: 'Permission denied.';
			return finish(err(`Permission denied for ${tool.name}: ${feedback}`));
		}
		return runHandler();
	}

	return {
		provider: cfg.id,
		conversationId: opts.conversationId,
		providerSessionId,
		workingDirectory: opts.workingDirectory,
		model: opts.model,
		lastUsed: Date.now(),
		async *send(prompt: string, signal: AbortSignal): AsyncIterable<PortalEvent> {
			if (activeQueue) throw new Error('session busy: a turn is already in progress');
			aborted = false;
			const messageId = ulid();
			const q = new AsyncQueue<PortalEvent>();
			activeQueue = q;
			const abort = new AbortController();
			activeAbortController = abort;
			const onAbort = () => {
				aborted = true;
				abort.abort();
			};
			signal.addEventListener('abort', onAbort, { once: true });
			if (signal.aborted) onAbort();
			void (async () => {
				try {
					await runTurn(prompt, q, messageId);
				} catch (e) {
					if (aborted) {
						q.push({ type: 'error', code: 'aborted', message: 'Aborted by client.' });
					} else {
						log.warn('openai_compatible.session.send_failed', {
							provider: cfg.id,
							conversationId: opts.conversationId,
							err: String(e)
						});
						q.push({
							type: 'error',
							code: 'send_failed',
							message: backendErrorMessage(cfg, e)
						});
					}
				} finally {
					q.push({ type: 'message.end', messageId });
					q.push({ type: 'done' });
					q.end();
				}
			})();
			try {
				for await (const ev of q) {
					opts.onEvent?.(ev);
					yield ev;
				}
			} finally {
				signal.removeEventListener('abort', onAbort);
				if (activeAbortController === abort) activeAbortController = null;
				if (activeQueue === q) activeQueue = null;
				this.lastUsed = Date.now();
			}
		},
		async abort() {
			aborted = true;
			activeAbortController?.abort();
		},
		async setMode(mode: SessionMode) {
			await applyMode(mode);
		},
		async setApproveAll(enabled: boolean) {
			await applyApproveAll(enabled);
		},
		async dispose() {
			disposed = true;
			aborted = true;
			activeAbortController?.abort();
		}
	};
}

function emitContextUsage(
	q: AsyncQueue<PortalEvent>,
	cfg: OpenAICompatibleConfig,
	usage: ChatStreamChunk['usage'],
	messagesLength: number
) {
	if (!usage || !cfg.contextTokenLimit) return;
	const currentTokens =
		typeof usage.total_tokens === 'number'
			? usage.total_tokens
			: typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number'
				? usage.prompt_tokens + usage.completion_tokens
				: null;
	if (currentTokens === null) return;
	q.push({
		type: 'context.usage',
		currentTokens,
		tokenLimit: cfg.contextTokenLimit,
		messagesLength,
		conversationTokens: currentTokens
	});
}

function restoreInitialMessages(
	cfg: OpenAICompatibleConfig,
	opts: ProviderOpenOptions
): ChatMessage[] {
	return (opts.initialMessages ?? [])
		.slice(-cfg.contextRestoreMessages)
		.flatMap(messageToChatMessages);
}

function messageToChatMessages(message: ProviderConversationMessage): ChatMessage[] {
	const content = message.content.trim();
	if (message.role === 'system') {
		return content ? [{ role: 'system', content }] : [];
	}
	if (message.role === 'user') {
		return content ? [{ role: 'user', content }] : [];
	}

	const toolCalls = reconstructToolCalls(message.toolCalls ?? []);
	if (toolCalls.length > 0) {
		return [
			{
				role: 'assistant',
				content: content || null,
				tool_calls: toolCalls.map(({ toolCall }) => toolCall)
			},
			...toolCalls.map(({ tool, toolCall }) => ({
				role: 'tool' as const,
				tool_call_id: toolCall.id,
				content: restoredToolContent(tool)
			}))
		];
	}
	return content ? [{ role: 'assistant', content }] : [];
}

function reconstructToolCalls(
	toolCalls: ToolCallRecord[]
): Array<{ tool: ToolCallRecord; toolCall: OpenAIToolCall }> {
	return toolCalls
		.filter((tool) => tool.parentToolCallId === null && tool.resultJson !== null)
		.map((tool) => ({
			tool,
			toolCall: {
				id: tool.id,
				type: 'function',
				function: {
					name: tool.tool,
					arguments: tool.argsJson
				}
			}
		}));
}

function restoredToolContent(tool: ToolCallRecord): string {
	// `resultJson` is the persisted full envelope. Replay the SAME concise, RAW
	// model text the live boundary produced (not the JSON-escaped envelope) so a
	// resumed turn sees its prior tool results exactly as the model originally
	// did. Non-envelope persisted shapes (native tools) replay verbatim.
	const raw = tool.resultJson;
	if (!raw) return '';
	const envelope = parseEnvelopeJson(raw);
	return envelope ? deriveToolResultViews(envelope).modelText : raw;
}

async function yieldFromQueue<T>(
	iterable: AsyncGenerator<PortalEvent, T, void>,
	q: AsyncQueue<PortalEvent>
): Promise<T> {
	let next = await iterable.next();
	while (!next.done) {
		q.push(next.value);
		next = await iterable.next();
	}
	return next.value;
}

function applyToolCallDelta(
	toolCalls: OpenAIToolCall[],
	delta: OpenAIToolCallDelta,
	lastIndex: number
): number {
	const index = typeof delta.index === 'number' ? delta.index : lastIndex >= 0 ? lastIndex : 0;
	const existing = toolCalls[index] ?? {
		id: '',
		type: 'function' as const,
		function: { name: '', arguments: '' }
	};
	if (typeof delta.id === 'string') existing.id = delta.id;
	if (delta.type === 'function') existing.type = 'function';
	if (typeof delta.function?.name === 'string') existing.function.name += delta.function.name;
	if (typeof delta.function?.arguments === 'string') {
		existing.function.arguments += delta.function.arguments;
	}
	toolCalls[index] = existing;
	return index;
}

function finalizeToolCalls(toolCalls: OpenAIToolCall[]): OpenAIToolCall[] {
	return toolCalls.map((toolCall) => ({
		id: toolCall.id || `tool_${ulid()}`,
		type: 'function',
		function: {
			name: toolCall.function.name,
			arguments: toolCall.function.arguments
		}
	}));
}

function parseToolArguments(
	raw: string
): { ok: true; args: unknown } | { ok: false; error: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { ok: true, args: {} };
	try {
		return { ok: true, args: JSON.parse(trimmed) };
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		return { ok: false, error: `Invalid JSON arguments for tool call: ${detail}` };
	}
}

function toolMessageContent(result: ToolExecutionResult): string {
	// The model receives the concise, RAW model text (real newlines/tabs), NOT
	// the JSON-escaped envelope. The full envelope travels separately as
	// `output` for the UI/timeline.
	return result.modelText;
}

function buildOpenAITools(opts: {
	opts: ProviderOpenOptions;
	getMode: () => SessionMode;
}): PortalTool[] {
	return [
		...buildGitTools(opts.opts.workingDirectory),
		...buildFilesystemTools(opts.opts.workingDirectory),
		...buildTicketTools({
			userId: opts.opts.userId,
			workspaceKey: ticketWorkspaceFromConversation(opts.opts.workingDirectory),
			conversationId: opts.opts.conversationId
		}),
		...buildPermissionTools({
			userId: opts.opts.userId,
			conversationId: opts.opts.conversationId,
			policy: opts.opts.policy,
			getMode: opts.getMode
		}),
		...buildMemoryTools({
			userId: opts.opts.userId,
			conversationId: opts.opts.conversationId,
			mode: opts.opts.memoryMode ?? 'off',
			globalMemoryEnabled: opts.opts.globalMemoryEnabled === true
		})
	];
}
