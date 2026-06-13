<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type {
		Conversation,
		ConversationUsage,
		MemoryExtractorBackend,
		MemoryMode,
		Message,
		PortalEvent,
		InteractiveRequestView,
		InteractiveResponse,
		ProviderCapabilities
	} from '$lib/types';
	import Message_ from './Message.svelte';
	import InteractiveRequestDialog from './InteractiveRequestDialog.svelte';
	import ChatHeader from './ChatHeader.svelte';
	import Composer from './Composer.svelte';
	import EmptyState from './ui/EmptyState.svelte';
	import { addInteractive, removeInteractive } from '$lib/client/interactive-queue';
	import {
		findToolCallRecord,
		shouldRefreshTicketsAfterToolResult
	} from '$lib/client/ticket-tool-refresh';
	import {
		CHAT_STREAM_STALL_TIMEOUT_MS,
		streamRefreshAction
	} from '$lib/client/chat-stream-recovery';
	import { decideArmedFlush, decideComposerAction } from '$lib/client/composer-arming';
	import { reviewStore } from '$lib/client/review.svelte';

	const INTERACTIVE_REVEAL_DELAY_MS = 150;

	let {
		conversation,
		initialMessages,
		initialUsage = null,
		parent = null,
		initialActiveTurnId = null,
		initialPendingInteractive = [],
		initialComposer = '',
		providerCapabilities,
		providerDisplayName,
		providerModels,
		providerModelsError = null,
		defaultModelPlaceholder,
		effectiveModel,
		chatPlaceholder
	}: {
		conversation: Conversation;
		providerCapabilities: ProviderCapabilities;
		providerDisplayName: string;
		providerModels: { id: string; name: string; maxContextWindowTokens?: number }[];
		providerModelsError?: string | null;
		defaultModelPlaceholder: string;
		effectiveModel: string;
		chatPlaceholder: string;
		initialMessages: Message[];
		initialUsage?: ConversationUsage | null;
		parent?: {
			id: string;
			title: string;
			messageId: string | null;
			messageIndex: number | null;
		} | null;
		initialActiveTurnId?: string | null;
		initialPendingInteractive?: InteractiveRequestView[];
		initialComposer?: string;
	} = $props();

	let messages = $state<Message[]>([]);

	// The full provider input is captured per turn and keyed to the user
	// message that triggered it, but the inspector affordance reads more
	// naturally on the assistant turn that input produced. Map each assistant
	// message to its triggering user message (the nearest preceding persisted
	// user message) so the assistant header can offer the "Input" button.
	const inputMessageIdByAssistant = $derived.by(() => {
		const map: Record<string, string> = {};
		let lastUserId: string | null = null;
		for (const m of renderedMessages) {
			if (m.role === 'user') {
				lastUserId = !m.id.startsWith('local-') && !m.id.startsWith('err-') ? m.id : null;
			} else if (m.role === 'assistant' && lastUserId) {
				map[m.id] = lastUserId;
			}
		}
		return map;
	});
	let title = $state<string>(untrack(() => conversation.title));
	let sessionModel = $state<string>(untrack(() => conversation.model ?? effectiveModel));
	let sessionMode = $state<Conversation['mode']>(untrack(() => conversation.mode));
	let memoryMode = $state<MemoryMode>(untrack(() => conversation.memoryMode));
	let memoryExtractorModel = $state<string | null>(
		untrack(() => conversation.memoryExtractorModel)
	);
	let memoryExtractorBackend = $state<MemoryExtractorBackend | null>(
		untrack(() => conversation.memoryExtractorBackend)
	);
	let globalMemoryEnabled = $state<boolean>(untrack(() => conversation.globalMemoryEnabled));
	let approveAllTools = $state<boolean>(untrack(() => conversation.approveAllTools));
	let usage = $state<ConversationUsage | null>(untrack(() => initialUsage));
	let recentCompaction = $state<{ tokensRemoved?: number; messagesRemoved?: number } | null>(null);
	let compactionTimer: ReturnType<typeof setTimeout> | null = null;

	// Child forks of this conversation, keyed by the source message id so
	// the corresponding <Message_> can render a "Forked → ..." badge.
	type ForkInfo = {
		id: string;
		title: string;
		sourceMessageId: string | null;
		createdAt: number;
		archivedAt: number | null;
	};
	let forksByMessage = $state<Record<string, ForkInfo[]>>({});

	async function refreshForks() {
		try {
			const r = await fetch(`/api/conversations/${conversation.id}/forks`);
			if (!r.ok) return;
			const data = (await r.json()) as { forks: ForkInfo[] };
			const map: Record<string, ForkInfo[]> = {};
			for (const f of data.forks) {
				if (!f.sourceMessageId) continue;
				(map[f.sourceMessageId] ??= []).push(f);
			}
			forksByMessage = map;
		} catch {
			/* non-fatal */
		}
	}

	function clearCompactionTimer() {
		if (compactionTimer) {
			clearTimeout(compactionTimer);
			compactionTimer = null;
		}
	}

	function clearInteractiveRevealTimers() {
		for (const timer of interactiveRevealTimers.values()) clearTimeout(timer);
		interactiveRevealTimers.clear();
	}

	function invalidateRefreshMessages() {
		refreshMessagesRun++;
	}

	$effect(() => {
		// Reset local message list when the conversation prop changes.
		void conversation.id;
		untrack(() => {
			invalidateRefreshMessages();
			// Tear down any stream attached to the previous conversation
			// before we swap state — otherwise its events would land in
			// the new conversation's `messages` array.
			closeStream();
			messages = [...initialMessages];
			title = conversation.title;
			sessionModel = conversation.model ?? effectiveModel;
			sessionMode = conversation.mode;
			memoryMode = conversation.memoryMode;
			memoryExtractorModel = conversation.memoryExtractorModel;
			memoryExtractorBackend = conversation.memoryExtractorBackend;
			globalMemoryEnabled = conversation.globalMemoryEnabled;
			approveAllTools = conversation.approveAllTools;
			usage = initialUsage;
			composer = initialComposer;
			recentCompaction = null;
			pinnedToBottom = true;
			hasNewBelow = false;
			forksByMessage = {};
			pendingInteractive = [...initialPendingInteractive];
			visibleInteractive = [...initialPendingInteractive];
			clearInteractiveRevealTimers();
			clearCompactionTimer();
			// Reattach the EventSource to any in-progress turn so a
			// refresh-mid-stream resumes seamlessly.
			if (initialActiveTurnId) {
				attachStream(initialActiveTurnId, { replay: false });
			}
			void refreshForks();
		});
		return () => {
			closeStream();
			clearCompactionTimer();
			clearInteractiveRevealTimers();
		};
	});

	let composer = $state(untrack(() => initialComposer));

	// Pull in a code review assembled in the file browser. The review store is
	// the hand-off channel between the (sibling) FileBrowser and this composer,
	// which can't share component state because they mount/unmount per tab.
	$effect(() => {
		const pending = reviewStore.composerInsert;
		if (pending == null) return;
		untrack(() => {
			reviewStore.takeComposerInsert();
			const existing = composer.replace(/\s+$/u, '');
			composer = existing ? `${existing}\n\n${pending}` : pending;
		});
	});

	let streaming = $state(false);
	// "Armed" composer: while a turn streams the user can press Send/Enter to
	// hold the current buffer and auto-send it as a new turn the moment the
	// active turn finishes successfully. Purely client-side; lost on reload.
	let armed = $state(false);
	// Set when an `error` event arrives during the active stream. The server
	// always emits a terminal `done` even after an error/abort, so we use this
	// flag to distinguish a clean success (auto-flush) from a failure (hold).
	let turnErrored = false;
	// Queue of outstanding permission requests. The SDK can fire multiple
	// `onPermissionRequest` callbacks concurrently (parallel tool calls),
	// so we must surface them all — a single slot would let later events
	// clobber earlier ones, stranding the earlier requests on the server.
	let pendingInteractive = $state<InteractiveRequestView[]>(
		untrack(() => [...initialPendingInteractive])
	);
	let visibleInteractive = $state<InteractiveRequestView[]>(
		untrack(() => [...initialPendingInteractive])
	);
	const interactiveRevealTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Active EventSource for the in-flight turn (if any). null when idle.
	// Holding a reference here lets `stop()` close it on user-cancel and
	// lets the conversation-prop $effect tear it down on navigation.
	let eventSource: EventSource | null = null;
	// Id of the turn we're currently streaming. Tracked separately because
	// EventSource owns its own URL; we need the id for DELETE on cancel.
	let activeTurnId: string | null = null;
	let streamStallTimer: ReturnType<typeof setTimeout> | null = null;
	let refreshMessagesRun = 0;
	let scrollEl: HTMLDivElement | undefined;
	// Sticky-scroll: only auto-scroll if the user is pinned to the bottom.
	// Otherwise, surface a "New messages" pill (Slack-style) so we don't
	// yank them away from content they're reading.
	let pinnedToBottom = $state(true);
	let hasNewBelow = $state(false);
	const STICK_THRESHOLD_PX = 40;

	function isNearBottom(el: HTMLElement): boolean {
		return el.scrollHeight - el.clientHeight - el.scrollTop <= STICK_THRESHOLD_PX;
	}

	function onMessagesScroll() {
		const el = scrollEl;
		if (!el) return;
		const near = isNearBottom(el);
		pinnedToBottom = near;
		if (near) hasNewBelow = false;
	}

	async function scrollToBottom(opts: { force?: boolean } = {}) {
		await tick();
		const el = scrollEl;
		if (!el) return;
		if (opts.force || pinnedToBottom) {
			el.scrollTo({ top: el.scrollHeight });
			pinnedToBottom = true;
			hasNewBelow = false;
		} else {
			hasNewBelow = true;
		}
	}

	function jumpToLatest() {
		const el = scrollEl;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
		pinnedToBottom = true;
		hasNewBelow = false;
	}

	// Open an EventSource against an in-flight turn and route its events
	// through `applyEvent`. The browser owns the connection lifecycle:
	//   - Auto-reconnects on transient drops (locked phone, sleeping
	//     radio, proxy idle close).
	//   - Sends `Last-Event-ID` on reconnect so the server replays only
	//     events we haven't seen yet.
	// EventSource hides heartbeat comments from JS, so a live-but-stalled
	// proxy can leave us waiting forever if a terminal data event is lost.
	// We therefore also run an idle recovery timer keyed to visible stream
	// activity. Recovery only refetches persisted state; it does not cancel
	// a server-side turn that is still running.
	//
	// We only need to handle two terminal cases directly:
	//   1. `done` portal event → turn finished cleanly. Close the stream.
	//   2. Network error with `readyState === CLOSED` → server refused
	//      reconnect (typically 410 Gone: turn no longer in registry).
	//      Refetch persisted messages so the UI catches up, then stop.
	function attachStream(turnId: string, opts: { replay?: boolean } = {}) {
		closeStream();
		activeTurnId = turnId;
		streaming = true;
		turnErrored = false;

		const replayParam = opts.replay === false ? '?replay=0' : '';
		const es = new EventSource(
			`/api/conversations/${conversation.id}/turns/${turnId}/stream${replayParam}`
		);
		eventSource = es;

		es.onopen = () => {
			scheduleStreamStallTimeout();
		};
		es.onmessage = (msg) => {
			let ev: PortalEvent;
			try {
				ev = JSON.parse(msg.data) as PortalEvent;
			} catch {
				return;
			}
			applyEvent(ev);
			if (ev.type === 'done') {
				// `done` is the only success signal. The server emits it even
				// after errors/aborts, so consult `turnErrored` (an `error`
				// event was seen) and the terminal `status` (set to
				// 'interrupted' on a server-side abort that emits no `error`)
				// before flushing an armed follow-up. `closeStream()` flips
				// `streaming` to false first so the follow-up POST isn't
				// rejected by the 409 guard.
				const failed = turnErrored || ev.status === 'interrupted';
				closeStream();
				flushArmed(failed);
			} else {
				scheduleStreamStallTimeout();
			}
		};
		es.onerror = () => {
			// Browser closed the connection permanently (e.g. 410 from
			// our stream endpoint: turn id unknown because the grace
			// window expired during a long phone lock). We're then
			// authoritatively desynced from the DB — refetch and stop.
			// Transient errors keep `readyState === CONNECTING` and the
			// browser retries automatically; we leave those alone.
			if (es.readyState === EventSource.CLOSED) {
				closeStream();
				// Interrupted, not a clean finish: hold any armed follow-up
				// (disarm, keep the buffer for the user to review and send).
				armed = false;
				void refreshMessages();
			} else {
				scheduleStreamStallTimeout();
			}
		};
		scheduleStreamStallTimeout();
	}

	function closeStream() {
		clearStreamStallTimeout();
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		activeTurnId = null;
		streaming = false;
	}

	function clearStreamStallTimeout() {
		if (streamStallTimer) {
			clearTimeout(streamStallTimer);
			streamStallTimer = null;
		}
	}

	function scheduleStreamStallTimeout() {
		clearStreamStallTimeout();
		if (!eventSource || !activeTurnId || pendingInteractive.length > 0) return;
		const turnId = activeTurnId;
		streamStallTimer = setTimeout(() => {
			void recoverStalledStream(turnId);
		}, CHAT_STREAM_STALL_TIMEOUT_MS);
	}

	async function recoverStalledStream(turnId: string) {
		if (turnId !== activeTurnId || pendingInteractive.length > 0) {
			return;
		}
		await refreshMessages();
		if (turnId !== activeTurnId) return;
		scheduleStreamStallTimeout();
	}

	// Pull the latest persisted messages for this conversation and replace
	// local state. Used as a recovery path when the EventSource closes
	// without a `done` (e.g. 410 Gone after grace expiry) so the UI
	// doesn't strand mid-stream content forever.
	async function refreshMessages() {
		const run = ++refreshMessagesRun;
		try {
			const r = await fetch(`/api/conversations/${conversation.id}`);
			if (!r.ok) return;
			const data = (await r.json()) as {
				messages: Message[];
				activeTurnId: string | null;
				pendingInteractive?: InteractiveRequestView[];
			};
			if (run !== refreshMessagesRun) return;
			messages = data.messages;
			// Rehydrate outstanding prompts from the authoritative server
			// list. Previously we cleared this unconditionally, which meant
			// any transient SSE drop stranded the dialog even though the
			// server's `pending` map still held the request — and the agent
			// would only see a response after the (formerly 10-minute)
			// timeout fired. Now we just snap to whatever the server says.
			pendingInteractive = data.pendingInteractive ?? [];
			visibleInteractive = data.pendingInteractive ?? [];
			clearInteractiveRevealTimers();
			await scrollToBottom();
			if (run !== refreshMessagesRun) return;
			const action = streamRefreshAction({
				currentTurnId: activeTurnId,
				refreshedActiveTurnId: data.activeTurnId,
				hasEventSource: eventSource !== null
			});
			if (action === 'finish') {
				closeStream();
				// Recovery finish (e.g. 410 after grace expiry): treat like an
				// interrupt — disarm without clearing the composer buffer.
				armed = false;
			} else if (action === 'reattach' && data.activeTurnId) {
				// If a new turn became active between events (unlikely but
				// possible from another tab), attach to it. This also repairs
				// a locally closed stream when the server still has work.
				attachStream(data.activeTurnId, { replay: false });
			} else {
				scheduleStreamStallTimeout();
			}
		} catch {
			/* non-fatal */
		}
	}

	async function handleToolRerunStarted(turnId: string) {
		streaming = true;
		await refreshMessages();
		if (!eventSource) attachStream(turnId, { replay: false });
	}

	// Memory-extraction retry: the server re-runs extraction for the latest
	// turn under a fresh streaming turn (no new message). Attach to its stream
	// so the live extractor card + memory.status updates render in place.
	async function handleMemoryRetryStarted(turnId: string) {
		streaming = true;
		await refreshMessages();
		if (!eventSource) attachStream(turnId, { replay: false });
	}

	function handleInlineEdited(messageId: string, content: string, turnId: string) {
		const idx = messages.findIndex((m) => m.id === messageId);
		if (idx >= 0) {
			messages = messages.slice(0, idx + 1);
			messages[idx] = {
				...messages[idx],
				content,
				status: 'complete',
				errorCode: null
			};
		} else {
			void refreshMessages();
		}
		pendingInteractive = [];
		usage = null;
		streaming = true;
		attachStream(turnId);
	}

	// Regenerate: the server discarded the assistant reply (and anything after)
	// and re-ran the turn from the unchanged preceding user message. Truncate
	// the rendered thread to that user message and attach to the new turn's
	// stream so the fresh response renders in place. Mirrors handleInlineEdited
	// but the user message's content is unchanged.
	function handleRegenerated(userMessageId: string, turnId: string) {
		const idx = messages.findIndex((m) => m.id === userMessageId);
		if (idx >= 0) {
			messages = messages.slice(0, idx + 1);
		} else {
			void refreshMessages();
		}
		pendingInteractive = [];
		usage = null;
		streaming = true;
		attachStream(turnId);
	}

	function applyEvent(ev: PortalEvent) {
		switch (ev.type) {
			case 'message.start': {
				messages.push({
					id: ev.messageId,
					conversationId: conversation.id,
					role: 'assistant',
					content: '',
					status: 'streaming',
					errorCode: null,
					createdAt: Date.now(),
					toolCalls: [],
					fileEdits: [],
					reasoningBlocks: []
				});
				break;
			}
			case 'message.delta': {
				const m = messages.find((x) => x.id === ev.messageId);
				if (!m) break;
				if (ev.parentToolCallId && ev.segmentId) {
					// Sub-agent spoken content: accumulate into a threaded
					// 'content' block (rendered inside the SubagentCall card),
					// not the outer message body.
					const blocks = (m.reasoningBlocks ??= []);
					let seg = blocks.find((b) => b.id === ev.segmentId);
					if (!seg) {
						seg = {
							id: ev.segmentId,
							messageId: m.id,
							segmentIndex: blocks.length,
							text: '',
							kind: 'content',
							textOffset: null,
							startedAt: Date.now(),
							durationMs: null,
							parentToolCallId: ev.parentToolCallId
						};
						blocks.push(seg);
					}
					seg.text += ev.text;
				} else {
					m.content += ev.text;
				}
				break;
			}
			case 'message.reasoning': {
				let m = messages.find((x) => x.id === ev.messageId);
				if (!m) {
					// Reasoning can arrive before the first visible token. The
					// bridge opens a message.start in that case, but be defensive
					// in case events arrive out of order on resume/replay.
					m = {
						id: ev.messageId,
						conversationId: conversation.id,
						role: 'assistant',
						content: '',
						status: 'streaming',
						errorCode: null,
						createdAt: Date.now(),
						toolCalls: [],
						fileEdits: [],
						reasoningBlocks: []
					};
					messages.push(m);
				}
				const blocks = (m.reasoningBlocks ??= []);
				let seg = blocks.find((b) => b.id === ev.segmentId);
				if (!seg) {
					const isChild = !!ev.parentToolCallId;
					seg = {
						id: ev.segmentId,
						messageId: m.id,
						segmentIndex: blocks.length,
						text: '',
						kind: 'reasoning',
						textOffset: isChild ? null : m.content.length,
						startedAt: Date.now(),
						durationMs: null,
						parentToolCallId: ev.parentToolCallId ?? null
					};
					blocks.push(seg);
				}
				seg.text += ev.text;
				break;
			}
			case 'message.reasoning.end': {
				const m = messages.find((x) => x.id === ev.messageId);
				const seg = m?.reasoningBlocks?.find((b) => b.id === ev.segmentId);
				if (seg) seg.durationMs = ev.durationMs;
				break;
			}
			case 'message.end': {
				const m = messages.find((x) => x.id === ev.messageId);
				if (m) m.status = 'complete';
				break;
			}
			case 'tool.call': {
				const m = messages[messages.length - 1];
				if (m && m.role === 'assistant') {
					const isChild = !!ev.parentToolCallId;
					(m.toolCalls ??= []).push({
						id: ev.toolCallId,
						messageId: m.id,
						tool: ev.tool,
						argsJson: safeJson(ev.args),
						resultJson: null,
						status: 'pending',
						startedAt: Date.now(),
						endedAt: null,
						textOffset: isChild ? null : m.content.length,
						parentToolCallId: ev.parentToolCallId ?? null
					});
				}
				break;
			}
			case 'tool.result': {
				const tc = findToolCallRecord(messages, ev.toolCallId);
				if (tc) {
					tc.status = ev.ok ? 'ok' : 'error';
					tc.resultJson = safeJson(ev.output ?? ev.summary);
					tc.endedAt = Date.now();
					// Drop ephemeral streaming state — final result supersedes it.
					tc.partialOutput = undefined;
					tc.progressMessage = undefined;
				}
				if (shouldRefreshTicketsAfterToolResult(tc, ev)) {
					void invalidateAll();
				}
				break;
			}
			case 'subagent.lifecycle': {
				const tc = findToolCallRecord(messages, ev.toolCallId);
				if (tc) {
					tc.backgroundAgentStatus = ev.status;
					tc.backgroundAgentId = ev.agentId;
					if (ev.status === 'running') {
						tc.backgroundAgentStartedAt ??= Date.now();
						tc.backgroundAgentEndedAt = null;
					} else {
						tc.backgroundAgentEndedAt = Date.now();
					}
				}
				break;
			}
			case 'tool.partial_output': {
				const tc = findToolCallRecord(messages, ev.toolCallId);
				// The SDK emits cumulative snapshots of the tool's stdout/stderr
				// buffer (not deltas) so progress bars and carriage-return redraws
				// render correctly — each event already contains everything that
				// came before, so we replace rather than append.
				if (tc) tc.partialOutput = ev.output;
				break;
			}
			case 'tool.progress': {
				const tc = findToolCallRecord(messages, ev.toolCallId);
				if (tc) tc.progressMessage = ev.message;
				break;
			}
			case 'interactive.request': {
				addPendingInteractive(ev.request);
				break;
			}
			case 'interactive.resolved': {
				// Drop the matching prompt. Critical on replay: the original
				// `interactive.request` event lives forever in the turn's event
				// log, so without this signal a refresh or a visibility-driven
				// reconnect would resurrect a dialog the user already answered.
				removePendingInteractive(ev.requestId);
				break;
			}
			case 'file.edit': {
				const m = messages[messages.length - 1];
				if (m && m.role === 'assistant') {
					const isChild = !!ev.parentToolCallId;
					(m.fileEdits ??= []).push({
						id: `${m.id}-${(m.fileEdits ?? []).length}`,
						messageId: m.id,
						path: ev.path,
						diff: ev.diff,
						createdAt: Date.now(),
						textOffset: isChild ? null : m.content.length,
						parentToolCallId: ev.parentToolCallId ?? null
					});
				}
				break;
			}
			case 'error': {
				turnErrored = true;
				const m = messages[messages.length - 1];
				if (m && m.role === 'assistant') {
					m.status = 'error';
					m.errorCode = ev.code;
					m.content += `\n\n_Error: ${ev.message}_`;
				} else {
					messages.push({
						id: `err-${Date.now()}`,
						conversationId: conversation.id,
						role: 'system',
						content: `Error: ${ev.message}`,
						status: 'error',
						errorCode: ev.code,
						createdAt: Date.now()
					});
				}
				break;
			}
			case 'conversation.update': {
				if (ev.title && ev.title !== title) {
					title = ev.title;
					// Refresh the layout data so the sidebar reflects the new title.
					void invalidateAll();
				}
				break;
			}
			case 'session.settings': {
				// Server-driven settings change (typically the agent flipping
				// itself out of plan mode via exit-plan-mode). Mirror it into
				// our local state so the header reflects reality without a
				// page refresh.
				if (ev.mode !== undefined) sessionMode = ev.mode;
				if (ev.memoryMode !== undefined) memoryMode = ev.memoryMode;
				if (ev.approveAllTools !== undefined) approveAllTools = ev.approveAllTools;
				break;
			}
			case 'context.usage': {
				usage = {
					conversationId: conversation.id,
					currentTokens: ev.currentTokens,
					tokenLimit: ev.tokenLimit,
					messagesLength: ev.messagesLength,
					systemTokens: ev.systemTokens ?? null,
					conversationTokens: ev.conversationTokens ?? null,
					toolDefinitionsTokens: ev.toolDefinitionsTokens ?? null,
					updatedAt: Date.now()
				};
				break;
			}
			case 'context.compaction': {
				if (ev.phase === 'complete') {
					recentCompaction = {
						tokensRemoved: ev.tokensRemoved,
						messagesRemoved: ev.messagesRemoved
					};
					if (compactionTimer) clearTimeout(compactionTimer);
					compactionTimer = setTimeout(() => {
						recentCompaction = null;
						compactionTimer = null;
					}, 6000);
				}
				break;
			}
		}
		scrollToBottom();
	}

	function safeJson(v: unknown): string {
		try {
			return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	}

	function addPendingInteractive(
		request: InteractiveRequestView,
		opts: { revealImmediately?: boolean } = {}
	) {
		pendingInteractive = addInteractive(pendingInteractive, request);
		if (visibleInteractive.some((p) => p.requestId === request.requestId)) return;
		if (opts.revealImmediately) {
			visibleInteractive = addInteractive(visibleInteractive, request);
			return;
		}
		if (interactiveRevealTimers.has(request.requestId)) return;
		const timer = setTimeout(() => {
			interactiveRevealTimers.delete(request.requestId);
			if (!pendingInteractive.some((p) => p.requestId === request.requestId)) return;
			visibleInteractive = addInteractive(visibleInteractive, request);
			void scrollToBottom();
		}, INTERACTIVE_REVEAL_DELAY_MS);
		interactiveRevealTimers.set(request.requestId, timer);
	}

	function removePendingInteractive(requestId: string) {
		const timer = interactiveRevealTimers.get(requestId);
		if (timer) {
			clearTimeout(timer);
			interactiveRevealTimers.delete(requestId);
		}
		pendingInteractive = removeInteractive(pendingInteractive, requestId);
		visibleInteractive = removeInteractive(visibleInteractive, requestId);
	}

	async function respondInteractive(requestId: string, response: InteractiveResponse) {
		const request = pendingInteractive.find((p) => p.requestId === requestId);
		if (!request) return;
		// Optimistically drop the prompt; the server will also emit an
		// `interactive.resolved` which is a no-op once removed.
		removePendingInteractive(requestId);
		clearStreamStallTimeout();
		try {
			const r = await fetch(`/api/conversations/${conversation.id}/interactive/${requestId}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(response)
			});
			if (r.ok) {
				scheduleStreamStallTimeout();
				return;
			}
		} catch {
			/* restore below */
		}
		addPendingInteractive(request, { revealImmediately: true });
		scheduleStreamStallTimeout();
	}

	// Called once the active turn reaches a terminal `done`. If the composer
	// was armed and the turn succeeded with a non-empty composer buffer,
	// auto-send that buffer as a new turn (reusing the normal send path).
	// Otherwise disarm and leave the buffer untouched. Note "non-empty text"
	// here refers to the composer draft, not the assistant's reply. Runs after
	// `streaming === false`.
	function flushArmed(failed: boolean) {
		const decision = decideArmedFlush({
			armed,
			failed,
			hasText: composer.trim().length > 0
		});
		if (decision === 'flush') {
			void send();
		} else if (decision === 'disarm') {
			armed = false;
		}
	}

	async function send() {
		const text = composer.trim();
		const action = decideComposerAction({
			streaming,
			armed,
			hasText: text.length > 0
		});
		// While a turn streams, Send/Enter toggles the armed flag instead of
		// starting a concurrent turn (which the server would 409). When idle it
		// behaves exactly as before: send when there's text, otherwise no-op.
		if (action === 'noop') return;
		if (action === 'arm') {
			armed = true;
			return;
		}
		if (action === 'disarm') {
			armed = false;
			return;
		}
		// action === 'send' — only reachable when not streaming, so the POST
		// below won't hit the running-turn guard.
		armed = false;
		composer = '';
		const localMessageId = `local-${Date.now()}`;
		messages.push({
			id: localMessageId,
			conversationId: conversation.id,
			role: 'user',
			content: text,
			status: 'complete',
			errorCode: null,
			createdAt: Date.now()
		});
		scrollToBottom({ force: true });

		// Start the turn server-side, then attach an EventSource to its
		// stream. The POST is just a "create" — all event delivery flows
		// through the GET stream so reconnects (browser-driven) just work.
		streaming = true;
		try {
			const r = await fetch(`/api/conversations/${conversation.id}/turns`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ content: text })
			});
			if (!r.ok) {
				let msg = `HTTP ${r.status}`;
				try {
					const body = (await r.json()) as { message?: string };
					if (body.message) msg = body.message;
				} catch {
					/* ignore */
				}
				streaming = false;
				if (!composer) composer = text;
				applyEvent({ type: 'error', code: 'start_failed', message: msg });
				return;
			}
			const {
				turnId,
				userMessageId,
				title: updatedTitle
			} = (await r.json()) as {
				turnId: string;
				userMessageId: string;
				title?: string | null;
			};
			messages = messages.map((m) => (m.id === localMessageId ? { ...m, id: userMessageId } : m));
			if (updatedTitle && updatedTitle !== title) {
				title = updatedTitle;
				void invalidateAll();
			}
			attachStream(turnId);
		} catch (e) {
			streaming = false;
			if (!composer) composer = text;
			applyEvent({
				type: 'error',
				code: 'network',
				message: e instanceof Error ? e.message : String(e)
			});
		}
	}

	async function stop() {
		// Tell the server to actually cancel the turn (just closing the
		// EventSource would only detach this client; the turn would keep
		// running). Then close the stream locally.
		clearStreamStallTimeout();
		// A user-initiated stop is a "hold" path: disarm any armed follow-up
		// but keep the composer text so they can review and send manually.
		armed = false;
		const turnId = activeTurnId;
		if (turnId) {
			try {
				await fetch(`/api/conversations/${conversation.id}/turns/${turnId}`, { method: 'DELETE' });
			} catch {
				/* ignore */
			}
		}
		closeStream();
	}

	$effect(() => {
		scrollToBottom();
	});

	// Show a "thinking" indicator while we're awaiting the first token of the
	// next assistant message (i.e., streaming but no in-progress assistant
	// message exists yet, or it exists but has no content and no tool activity).
	const thinking = $derived.by(() => {
		if (!streaming || pendingInteractive.length > 0) return false;
		const last = messages[messages.length - 1];
		if (!last || last.role !== 'assistant') return true;
		const hasContent = last.content.length > 0;
		const hasTools = (last.toolCalls?.length ?? 0) > 0 || (last.fileEdits?.length ?? 0) > 0;
		const hasReasoning = (last.reasoningBlocks?.length ?? 0) > 0;
		return !hasContent && !hasTools && !hasReasoning;
	});

	$effect(() => {
		void thinking;
		scrollToBottom();
	});

	// While streaming, the in-progress assistant turn may not have produced a
	// message bubble yet (the first `message.start` event hasn't arrived). In
	// that window we append a synthetic placeholder assistant turn so the
	// thinking indicator (and the rest of the assistant-turn affordances)
	// render inside a normal bubble. Once a real assistant message exists it
	// takes over and the placeholder is dropped. Keeping the placeholder in
	// the same list the template iterates means it flows through the identical
	// <Message_> wiring (input inspector, forks, idle state) as a real turn —
	// no second rendering path to keep in sync.
	const lastIsAssistant = $derived(messages[messages.length - 1]?.role === 'assistant');
	// The latest persisted assistant message. Its memory-extractor card may show
	// a "Retry extraction" control — but only while the conversation is idle.
	const latestAssistantMessageId = $derived.by(() => {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'assistant') return messages[i].id;
		}
		return null;
	});
	// The user message that triggered the currently-streaming turn. Edit-fork
	// is hidden on it (you can't edit the live turn's boundary); every earlier
	// user message stays forkable even while this turn streams.
	const inFlightUserMessageId = $derived.by(() => {
		if (!streaming) return null;
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === 'user') return messages[i].id;
		}
		return null;
	});
	const thinkingPlaceholder = $derived<Message>({
		id: 'thinking-placeholder',
		conversationId: conversation.id,
		role: 'assistant',
		content: '',
		status: 'streaming',
		errorCode: null,
		createdAt: Date.now(),
		toolCalls: [],
		fileEdits: [],
		reasoningBlocks: []
	});
	const renderedMessages = $derived(
		thinking && !lastIsAssistant ? [...messages, thinkingPlaceholder] : messages
	);
</script>

<div class="chat">
	<ChatHeader
		{title}
		{conversation}
		{providerCapabilities}
		{providerDisplayName}
		model={sessionModel}
		{providerModels}
		{providerModelsError}
		{defaultModelPlaceholder}
		{parent}
		{usage}
		{recentCompaction}
		mode={sessionMode}
		{memoryMode}
		{memoryExtractorModel}
		{memoryExtractorBackend}
		{globalMemoryEnabled}
		{approveAllTools}
		modelChangeDisabled={streaming}
		onSettingsChange={(patch) => {
			if (patch.model !== undefined) sessionModel = patch.model;
			if (patch.mode !== undefined) sessionMode = patch.mode;
			if (patch.memoryMode !== undefined) memoryMode = patch.memoryMode;
			if (patch.memoryExtractorModel !== undefined)
				memoryExtractorModel = patch.memoryExtractorModel;
			if (patch.memoryExtractorBackend !== undefined)
				memoryExtractorBackend = patch.memoryExtractorBackend;
			if (patch.globalMemoryEnabled !== undefined) globalMemoryEnabled = patch.globalMemoryEnabled;
			if (patch.approveAllTools !== undefined) approveAllTools = patch.approveAllTools;
		}}
	/>

	<div class="messages-wrap">
		<div class="messages" bind:this={scrollEl} onscroll={onMessagesScroll}>
			<div class="messages-inner">
				{#if renderedMessages.length === 0 && visibleInteractive.length === 0}
					<div class="empty-conversation">
						<EmptyState
							title="Start the conversation"
							description="Send a message below to begin. Your replies, tool calls, and edits will appear here."
							size="lg"
						/>
					</div>
				{/if}
				{#each renderedMessages as m, i (m.id)}
					<Message_
						message={m}
						conversationId={conversation.id}
						inputMessageId={inputMessageIdByAssistant[m.id] ?? null}
						forks={forksByMessage[m.id] ?? []}
						isInFlightTurnUser={m.id === inFlightUserMessageId}
						thinking={thinking && i === renderedMessages.length - 1}
						canRetryMemory={!streaming && m.id === latestAssistantMessageId}
						busy={streaming}
						onForked={refreshForks}
						onInlineEdited={handleInlineEdited}
						onRegenerated={handleRegenerated}
						onToolRerunStarted={handleToolRerunStarted}
						onMemoryRetryStarted={handleMemoryRetryStarted}
					/>
				{/each}
				{#each visibleInteractive as p (p.requestId)}
					<InteractiveRequestDialog
						request={p}
						onRespond={(r) => respondInteractive(p.requestId, r)}
					/>
				{/each}
				{#if renderedMessages.length > 0 || visibleInteractive.length > 0}
					<div class="messages-bottom-spacer" aria-hidden="true"></div>
				{/if}
			</div>
		</div>
		{#if hasNewBelow && !pinnedToBottom}
			<button
				type="button"
				class="jump-latest"
				onclick={jumpToLatest}
				aria-label="Jump to latest messages"
			>
				New messages
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<path d="M4 6l4 4 4-4" />
				</svg>
			</button>
		{/if}
	</div>

	<Composer
		bind:value={composer}
		{streaming}
		{armed}
		placeholder={chatPlaceholder}
		onSend={send}
		onStop={stop}
	/>
</div>

<style>
	.chat {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.messages-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.messages {
		flex: 1;
		overflow-y: auto;
		padding: var(--space-4) var(--space-5);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.messages-inner {
		width: 100%;
		max-width: 52rem;
		margin: 0 auto;
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		min-height: 0;
	}
	@media (max-width: 768px) {
		.messages {
			padding: var(--space-4) var(--space-3);
		}
	}
	/* Keeps a consistent gap between the last message and the composer when the
	   conversation overflows and is scrolled to the bottom. A scroll
	   container's own padding-bottom (and a trailing margin on this flex item)
	   are dropped once content overflows, so the spacing must live inside the
	   scrolled content. The negative margin cancels the inherited row gap so
	   the net gap equals var(--space-4). */
	.messages-bottom-spacer {
		flex: none;
		height: var(--space-4);
		margin-top: calc(-1 * var(--space-3));
	}
	.empty-conversation {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
	}
	.jump-latest {
		position: absolute;
		left: 50%;
		bottom: var(--space-3);
		transform: translateX(-50%);
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0.35rem 0.7rem;
		font-size: var(--fs-sm);
		border-radius: var(--radius-pill);
		border: 1px solid var(--border);
		background: var(--accent);
		color: var(--accent-text);
		cursor: pointer;
		box-shadow: var(--shadow-2);
		transition:
			filter 0.12s ease,
			transform 0.08s ease;
	}
	.jump-latest:hover {
		filter: brightness(1.08);
	}
	.jump-latest:active {
		transform: translateX(-50%) scale(0.96);
	}
</style>
