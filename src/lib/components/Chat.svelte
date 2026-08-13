<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import type {
		ApprovalMode,
		Conversation,
		ConversationUsage,
		MemoryMode,
		PortalEvent,
		InteractiveRequestView,
		InteractiveResponse,
		TranscriptProjection
	} from '$lib/types';
	import type { DisplayId, DisplayMessage } from '$lib/client/display-message';
	import type { TranscriptEntry, TranscriptState } from '$lib/client/transcript-store';
	import * as store from '$lib/client/transcript-store';
	import { TRANSCRIPT_BODY_CACHE_MAX, TRANSCRIPT_OLDER_PAGE_SIZE } from '$lib/payload-limits';
	import Message_ from './Message.svelte';
	import MessageIndexRow from './MessageIndexRow.svelte';
	import InteractiveRequestDialog from './InteractiveRequestDialog.svelte';
	import ChatHeader from './ChatHeader.svelte';
	import Composer from './Composer.svelte';
	import EmptyState from './ui/EmptyState.svelte';
	import { addInteractive, removeInteractive } from '$lib/client/interactive-queue';
	import { PORTAL_TOOL_GROUP_IDS, type PortalToolGroupId } from '$lib/tools/groups';
	import { isBlockingKind } from '$lib/interactive/request-registry';
	import { setAwaitingInput, clearAwaitingInput } from '$lib/client/awaiting-input';
	import { markConversationRead } from '$lib/client/conversation-activity';
	import { invalidateWorktreeStatus } from '$lib/client/worktree-status';
	import { findToolCallRecord } from '$lib/client/tool-call-record';
	import { resolveAssistantTarget } from '$lib/client/assistant-target';
	import {
		streamStallDelayMs,
		streamRefreshAction,
		streamIsLive,
		shouldResumeStream
	} from '$lib/client/chat-stream-recovery';
	import { decideArmedFlush, decideComposerAction } from '$lib/client/composer-arming';
	import { createConversationResetGate } from '$lib/client/conversation-reset';
	import { reviewStore } from '$lib/client/review.svelte';
	import {
		DEFAULT_STICKY_BOTTOM_THRESHOLD_PX,
		planStickyBottomContentUpdate,
		shouldShowJumpToLatest,
		updateStickyBottomFromScroll,
		type ScrollMetrics
	} from '$lib/client/sticky-bottom';

	const INTERACTIVE_REVEAL_DELAY_MS = 150;
	// Upper bound on how long a user-initiated Stop waits for the server's
	// abort flow (interactive.resolved per prompt, then a terminal `done`) to
	// drain over the still-open stream before we force-close locally. Kept
	// well under CHAT_STREAM_STALL_TIMEOUT_MS so a wedged server / dropped
	// stream can never leave Stop stuck showing dialogs or a stopping state.
	const STOP_FALLBACK_TIMEOUT_MS = 1500;

	let {
		conversation,
		initialTranscript,
		initialUsage = null,
		parent = null,
		initialActiveTurnId = null,
		initialPendingInteractive = [],
		initialComposer = '',
		defaultModelPlaceholder,
		effectiveModel,
		chatPlaceholder,
		modelOptions = []
	}: {
		conversation: Conversation;
		defaultModelPlaceholder: string;
		effectiveModel: string;
		chatPlaceholder: string;
		modelOptions?: string[];
		initialTranscript: TranscriptProjection;
		initialUsage?: ConversationUsage | null;
		parent?: {
			id: number;
			title: string;
			messageId: number | null;
			messageIndex: number | null;
		} | null;
		initialActiveTurnId?: string | null;
		initialPendingInteractive?: InteractiveRequestView[];
		initialComposer?: string;
	} = $props();

	// --- Backend-projected transcript state --------------------------------
	//
	// `entries` holds every message in order as an index entry (preview +
	// record descriptors); `bodies` holds hydrated `DisplayMessage`s, LRU-capped.
	// Older messages render as compact index rows until they scroll near the
	// viewport, at which point their body is fetched and they mount as full
	// cards — see `src/lib/client/transcript-store.ts` and the windowing below.
	let transcript = $state<TranscriptState>(store.emptyState());

	// Hydrated bodies in transcript order, for the event handlers and the
	// derived affordances that used to read the flat `messages` array.
	const hydratedMessages = $derived(
		transcript.entries
			.map((e) => transcript.bodies.get(e.id))
			.filter((m): m is DisplayMessage => m !== undefined)
	);

	// The full provider input is captured per turn and keyed to the user
	// message that triggered it, but the inspector affordance reads more
	// naturally on the assistant turn that input produced. Map each assistant
	// message to its triggering user message (the nearest preceding persisted
	// user message) so the assistant header can offer the "Input" button.
	const inputMessageIdByAssistant = $derived.by(() => {
		const map: Record<string, number> = {};
		let lastUserId: number | null = null;
		for (const m of hydratedMessages) {
			if (m.role === 'user') {
				lastUserId = typeof m.id === 'number' ? m.id : null;
			} else if (m.role === 'assistant' && lastUserId) {
				map[String(m.id)] = lastUserId;
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
	let globalMemoryEnabled = $state<boolean>(untrack(() => conversation.globalMemoryEnabled));
	let approvalMode = $state<ApprovalMode>(untrack(() => conversation.approvalMode));
	let disabledToolGroups = $state<PortalToolGroupId[]>(
		untrack(() => conversation.disabledToolGroups)
	);
	let usage = $state<ConversationUsage | null>(untrack(() => initialUsage));
	let recentCompaction = $state<{ tokensRemoved?: number; messagesRemoved?: number } | null>(null);
	let compactionTimer: ReturnType<typeof setTimeout> | null = null;

	// Child forks of this conversation, keyed by the source message id so
	// the corresponding <Message_> can render a "Forked → ..." badge.
	type ForkInfo = {
		id: number;
		title: string;
		sourceMessageId: number | null;
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
				(map[String(f.sourceMessageId)] ??= []).push(f);
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

	// Drop every outstanding prompt for this conversation (both the pending
	// queue and the revealed dialogs) plus their reveal timers. Mirrors the
	// server's `cancelConversation`, which cancels every pending request — used
	// by the Stop fallback so a wedged abort can't strand dialogs on screen.
	function clearAllPendingInteractive() {
		clearInteractiveRevealTimers();
		pendingInteractive = [];
		visibleInteractive = [];
	}

	function invalidateRefreshMessages() {
		refreshMessagesRun++;
	}

	// Gate that re-seeds local state only when the conversation *id value*
	// changes (a genuine switch), not when a new `conversation` prop object
	// arrives with the same id (a background refresh). Keeps an unsent composer
	// draft — and the rest of the local state — alive across refreshes.
	const resetGate = createConversationResetGate();

	$effect(() => {
		// Reset local state only when the conversation *id value* changes — a
		// genuine switch — not merely when a new `conversation` prop object
		// arrives. `invalidateAll()` / `load` re-runs (e.g. the tickets UI)
		// produce a fresh prop object with the *same* id; re-seeding then would
		// clobber user state, most visibly an unsent composer draft.
		const nextId = conversation.id;
		untrack(() => {
			if (!resetGate.shouldReset(nextId)) return;
			invalidateRefreshMessages();
			// Tear down any stream attached to the previous conversation
			// before we swap state — otherwise its events would land in
			// the new conversation's transcript store.
			closeStream();
			transcript = store.initState(initialTranscript);
			resetWindow();
			clearHydrationQueue();
			title = conversation.title;
			sessionModel = conversation.model ?? effectiveModel;
			sessionMode = conversation.mode;
			memoryMode = conversation.memoryMode;
			memoryExtractorModel = conversation.memoryExtractorModel;
			globalMemoryEnabled = conversation.globalMemoryEnabled;
			approvalMode = conversation.approvalMode;
			disabledToolGroups = conversation.disabledToolGroups;
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
			void scrollToBottom({ force: true });
			// Reattach the EventSource to any in-progress turn so a
			// refresh-mid-stream resumes seamlessly.
			if (initialActiveTurnId) {
				attachStream(initialActiveTurnId, { replay: false });
			}
			void refreshForks();
			void handlePermalinkOnLoad();
		});
	});

	// Destroy-only teardown. Kept in its own dependency-free effect so it runs
	// exactly once on unmount — NOT before every re-run of the reset effect
	// above. The reset effect re-fires on every same-id background refresh
	// (it subscribes to the `conversation` prop object), and tearing the stream
	// down there would close an in-progress turn's EventSource without
	// reattaching it. A genuine conversation switch already tears down the old
	// stream via `closeStream()` inside the reset body before reseeding.
	$effect(() => {
		return () => {
			closeStream();
			clearCompactionTimer();
			clearInteractiveRevealTimers();
			clearProgrammaticScrollGuard();
		};
	});

	// Mirror this (open) conversation's blocking-prompt state into the shared
	// awaiting-input store so the sidebar indicator updates live off the turn
	// stream — a prompt appearing or being resolved/cancelled — without a
	// server round-trip or layout reload. Derived straight from
	// `pendingInteractive` (filtered to blocking kinds) so the sidebar can never
	// disagree with the chat. The cleanup clears the override on unmount /
	// conversation switch so the sidebar falls back to the server `load` value.
	$effect(() => {
		const id = conversation.id;
		const awaiting = pendingInteractive.some((p) => isBlockingKind(p.kind));
		setAwaitingInput(id, awaiting);
		return () => clearAwaitingInput(id);
	});

	// Opening a conversation clears its sidebar "unseen response" flag. The page
	// `load` already marks it read server-side, but this also fires on a
	// client-side conversation switch that reuses the component, and it drops the
	// local indicator immediately rather than after the round-trip.
	$effect(() => {
		void markConversationRead(conversation.id);
	});

	// Foreground/network resume listeners. Registered once for the component's
	// lifetime (independent of which conversation is loaded) so a tab that was
	// frozen during a screen lock re-syncs the moment it comes back, instead of
	// stranding the user on stale content until they manually refresh.
	//
	// We listen on `visibilitychange` (not `focus`) deliberately: browsers only
	// freeze tabs that go *hidden*, and `visibilitychange` fires reliably on
	// screen lock/unlock and tab switch — exactly when recovery is needed. A
	// raw `focus` listener also fires when refocusing an already-visible window
	// (which was never frozen), which would churn a healthy stream by dropping
	// and reattaching it on every refocus. `online` covers network restoration.
	$effect(() => {
		if (typeof window === 'undefined') return;
		const onVisibility = () => {
			if (!document.hidden) handleStreamResume();
		};
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('online', handleStreamResume);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('online', handleStreamResume);
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
	// Bounded safety net armed by `stop()`: force-closes the stream and clears
	// pending prompts if the server's abort flow doesn't drain in time.
	let stopFallbackTimer: ReturnType<typeof setTimeout> | null = null;
	// True between a user Stop and the turn's terminal teardown. The server's
	// abort flow cancels every pending prompt, but it can emit the terminal
	// `done` BEFORE the per-prompt `interactive.resolved` events (turn.abort()
	// fires the provider abort — which drives `error`/`done` — before
	// `cancelConversation` emits the resolves). Since the `done` handler closes
	// the stream, those later resolves never arrive, so we clear the prompts
	// ourselves on the terminal event when a Stop is in flight.
	let stopping = false;
	let refreshMessagesRun = 0;
	let scrollEl: HTMLDivElement | undefined = $state();
	// Sticky-scroll: only auto-scroll if the user is pinned to the bottom.
	// Otherwise, surface a "New messages" pill (Slack-style) so we don't
	// yank them away from content they're reading.
	let pinnedToBottom = $state(true);
	let hasNewBelow = $state(false);
	let programmaticScrollGuardTimer: ReturnType<typeof setTimeout> | null = null;
	let programmaticScrollGuardUntil = 0;
	type TranscriptScrollBehavior = 'auto' | 'smooth';

	function scrollMetrics(el: HTMLElement): ScrollMetrics {
		return {
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
			scrollTop: el.scrollTop
		};
	}

	function clearProgrammaticScrollGuard() {
		if (programmaticScrollGuardTimer) {
			clearTimeout(programmaticScrollGuardTimer);
			programmaticScrollGuardTimer = null;
		}
		programmaticScrollGuardUntil = 0;
	}

	// A programmatic scroll fires the same `scroll` events a user drag does. If
	// we let those through, a smooth jump-to-latest would read as "user scrolled
	// away" mid-animation and immediately unpin. Suppress handling until the
	// animation has had time to settle, then re-sync from the real position.
	function setProgrammaticScrollGuard(durationMs: number) {
		clearProgrammaticScrollGuard();
		programmaticScrollGuardUntil = performance.now() + durationMs;
		programmaticScrollGuardTimer = setTimeout(() => {
			programmaticScrollGuardTimer = null;
			programmaticScrollGuardUntil = 0;
			const el = scrollEl;
			if (!el) return;
			const next = updateStickyBottomFromScroll(
				{ pinnedToBottom, hasNewBelow },
				scrollMetrics(el),
				{ thresholdPx: DEFAULT_STICKY_BOTTOM_THRESHOLD_PX }
			);
			pinnedToBottom = next.pinnedToBottom;
			hasNewBelow = next.hasNewBelow;
		}, durationMs);
	}

	function onMessagesScroll() {
		const el = scrollEl;
		if (!el) return;
		const next = updateStickyBottomFromScroll({ pinnedToBottom, hasNewBelow }, scrollMetrics(el), {
			programmatic: performance.now() < programmaticScrollGuardUntil,
			thresholdPx: DEFAULT_STICKY_BOTTOM_THRESHOLD_PX
		});
		pinnedToBottom = next.pinnedToBottom;
		hasNewBelow = next.hasNewBelow;
		// Keep the full-card window glued to the viewport while scrolling.
		scheduleWindowUpdate();
	}

	function setScrollToBottom(behavior: TranscriptScrollBehavior = 'auto') {
		const el = scrollEl;
		if (!el) return;
		setProgrammaticScrollGuard(behavior === 'smooth' ? 700 : 80);
		el.scrollTo({ top: el.scrollHeight, behavior });
		pinnedToBottom = true;
		hasNewBelow = false;
	}

	async function scrollToBottom(opts: { force?: boolean } = {}) {
		await tick();
		const el = scrollEl;
		if (!el) return;
		const update = planStickyBottomContentUpdate({ pinnedToBottom, hasNewBelow }, opts);
		pinnedToBottom = update.state.pinnedToBottom;
		hasNewBelow = update.state.hasNewBelow;
		if (update.shouldScroll) setScrollToBottom();
	}

	function jumpToLatest() {
		setScrollToBottom('smooth');
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
				const failed = turnErrored || ev.status === 'interrupted' || ev.status === 'error';
				// A user Stop cancels every pending prompt server-side, but the
				// matching `interactive.resolved` events may be emitted after
				// this terminal `done` (see `stopping`) — at which point the
				// stream is closed and they'd never arrive. Clear the dialogs
				// here so Stop removes them promptly without a reload.
				if (stopping) clearAllPendingInteractive();
				closeStream();
				// The response landed while the user was looking at it, so keep the
				// sidebar from flagging this conversation as unseen once they
				// navigate away. The server publishes `unread: true` at turn end
				// (it can't know who's watching); this is the correction.
				void markConversationRead(conversation.id);
				// A turn is the usual way work becomes unmerged (the agent
				// committed in its worktree) or stops being unmerged (it
				// merged). Tell the indicators to refetch instead of leaving
				// them stale until the sidebar's slow poll comes round.
				invalidateWorktreeStatus();
				flushArmed(failed);
			} else {
				scheduleStreamStallTimeout();
			}
		};
		// `sseResponse` emits its defensive catch-block error frame under a
		// named `event: stream_error` (its `data` keeps `type: 'error'`).
		// Native EventSource routes named events away from `onmessage`, so
		// forward it through the same handler to keep the inline error surfacing
		// (turnErrored + system message) that an unnamed frame used to trigger.
		es.addEventListener('stream_error', (msg) => es.onmessage?.(msg as MessageEvent));
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
		clearStopFallbackTimer();
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		activeTurnId = null;
		streaming = false;
		stopping = false;
	}

	// A `null` socket is obviously gone, but a non-null one is not
	// necessarily healthy: after a tab freeze (screen lock, backgrounded
	// tab) the browser can leave the EventSource in a CLOSED state without
	// ever firing `onerror`, or as a "zombie" that reports OPEN while no
	// data flows. `streamIsLive` (in chat-stream-recovery) treats a CLOSED
	// socket as dead so recovery reattaches instead of waiting out another
	// full stall window. Callers that want to force past a zombie close the
	// socket themselves before refetching.

	// Drop the current socket without tearing down `activeTurnId`/`streaming`
	// so a subsequent `refreshMessages()` reattaches a fresh stream when the
	// server still has the turn in flight.
	function dropZombieStream() {
		clearStreamStallTimeout();
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
	}

	// Re-sync when the page returns to the foreground (after a screen lock or
	// tab switch) or the network comes back. While a tab is frozen the
	// browser suspends our stall watchdog AND can silently kill or zombify
	// the EventSource, so neither auto-reconnect nor the stall timer reliably
	// recovers — the user would otherwise have to refresh by hand. If a turn
	// is in flight, drop the possibly-dead socket and refetch authoritative
	// state, which reattaches a fresh stream as needed.
	function handleStreamResume() {
		const documentHidden = typeof document !== 'undefined' && document.hidden;
		if (!shouldResumeStream({ documentHidden, activeTurnId })) return;
		dropZombieStream();
		void refreshMessages();
	}

	function clearStreamStallTimeout() {
		if (streamStallTimer) {
			clearTimeout(streamStallTimer);
			streamStallTimer = null;
		}
	}

	function clearStopFallbackTimer() {
		if (stopFallbackTimer) {
			clearTimeout(stopFallbackTimer);
			stopFallbackTimer = null;
		}
	}

	// Force-tear-down path for Stop: drop the stream and clear every pending
	// prompt locally. Idempotent with the `done`-driven `closeStream()`
	// (closeStream also clears the fallback timer), so it's safe whether it
	// fires first or the server's terminal event beats it.
	function forceStopCleanup() {
		closeStream();
		clearAllPendingInteractive();
	}

	function scheduleStreamStallTimeout() {
		clearStreamStallTimeout();
		const delay = streamStallDelayMs({
			hasEventSource: !!eventSource,
			activeTurnId,
			pendingInteractiveCount: pendingInteractive.length
		});
		if (delay === null) return;
		const turnId = activeTurnId;
		if (turnId === null) return;
		streamStallTimer = setTimeout(() => {
			void recoverStalledStream(turnId);
		}, delay);
	}

	async function recoverStalledStream(turnId: string) {
		if (turnId !== activeTurnId) {
			return;
		}
		// Re-sync from the server even when a prompt is outstanding: if the
		// interactive handler timed out or the stream died mid-permission
		// without an `interactive.resolved`, `refreshMessages()` snaps the
		// dialog queue back to the authoritative `pending` map (clearing a
		// prompt the server no longer holds) instead of deadlocking the UI.
		await refreshMessages();
		if (turnId !== activeTurnId) return;
		scheduleStreamStallTimeout();
	}

	// Pull the latest persisted projection (tail + index) for this conversation
	// and merge it into the sparse store. Used as a recovery path when the
	// EventSource closes without a `done` (e.g. 410 Gone after grace expiry)
	// so the UI doesn't strand mid-stream content forever. Tail-only: hydrated
	// older pages are immutable and stay cached (`mergeRefresh`).
	async function refreshMessages() {
		const run = ++refreshMessagesRun;
		try {
			const r = await fetch(`/api/conversations/${conversation.id}`);
			if (!r.ok) return;
			const data = (await r.json()) as {
				transcript: TranscriptProjection;
				activeTurnId: string | null;
				pendingInteractive?: InteractiveRequestView[];
			};
			if (run !== refreshMessagesRun) return;
			store.mergeRefresh(transcript, data.transcript);
			markOffsetsDirty();
			evictBodies();
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
				hasEventSource: streamIsLive(eventSource)
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

	function handleInlineEdited(messageId: number, content: string, turnId: string) {
		// Truncation race guard (D6): drop cached index/bodies past the cut
		// BEFORE the replacement turn streams in, so stale cards can't resurface.
		const body = transcript.bodies.get(messageId);
		store.truncateAfter(transcript, messageId);
		if (body) {
			body.content = content;
			body.status = 'complete';
			body.errorCode = null;
			store.syncEntry(transcript, messageId);
		} else {
			void refreshMessages();
		}
		markOffsetsDirty();
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
	function handleRegenerated(userMessageId: number, turnId: string) {
		const had = transcript.entries.some((e) => e.id === userMessageId);
		store.truncateAfter(transcript, userMessageId);
		markOffsetsDirty();
		if (!had) {
			void refreshMessages();
		}
		pendingInteractive = [];
		usage = null;
		streaming = true;
		attachStream(turnId);
	}

	function applyEvent(ev: PortalEvent) {
		// Resolve against the hydrated bodies (the streaming tail is always
		// hydrated, so this behaves like the old flat `messages` array). An
		// event targeting an unhydrated message — reconnect gap, demoted
		// history — updates nothing and never crashes; the entry stays correct
		// until its body is next fetched.
		const msgs = hydratedMessages;
		let touched: DisplayId | null = null;
		switch (ev.type) {
			case 'message.start': {
				// Dedupe: a replayed/re-delivered `message.start` for a bubble we
				// already hold (e.g. after a reconnect that re-sent it) would
				// otherwise push a ghost duplicate.
				if (transcript.entries.some((e) => e.id === ev.messageId)) break;
				store.appendMessage(transcript, {
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
				const m = transcript.bodies.get(ev.messageId);
				if (!m) {
					// A delta for a message this client has never seen — the
					// content was persisted server-side in a reconnect gap (or
					// the stream's `message.start` was dropped). Re-sync instead
					// of silently dropping the text.
					void refreshMessages();
					break;
				}
				if (ev.parentToolCallId && ev.segmentId) {
					// Sub-agent spoken content: accumulate into a threaded
					// 'content' block (rendered inside the SubagentCall card),
					// not the outer message body.
					const blocks = (m.reasoningBlocks ??= []);
					let seg = blocks.find((b) => b.id === ev.segmentId);
					if (!seg) {
						seg = {
							id: ev.segmentId,
							messageId: ev.messageId,
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
					seg.text = (seg.text ?? '') + ev.text;
				} else {
					m.content += ev.text;
				}
				touched = ev.messageId;
				break;
			}
			case 'message.reasoning': {
				let m = transcript.bodies.get(ev.messageId);
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
					store.appendMessage(transcript, m);
				}
				const blocks = (m.reasoningBlocks ??= []);
				let seg = blocks.find((b) => b.id === ev.segmentId);
				if (!seg) {
					const isChild = !!ev.parentToolCallId;
					seg = {
						id: ev.segmentId,
						messageId: ev.messageId,
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
				seg.text = (seg.text ?? '') + ev.text;
				touched = ev.messageId;
				break;
			}
			case 'message.reasoning.end': {
				const m = transcript.bodies.get(ev.messageId);
				const seg = m?.reasoningBlocks?.find((b) => b.id === ev.segmentId);
				if (seg) {
					seg.durationMs = ev.durationMs;
					touched = ev.messageId;
				}
				break;
			}
			case 'message.end': {
				const m = transcript.bodies.get(ev.messageId);
				if (m) {
					m.status = 'complete';
					touched = ev.messageId;
				} else {
					// Same reconnect-gap desync as `message.delta`: the terminal
					// marker arrived for a bubble we never saw. Re-sync rather
					// than silently dropping it.
					void refreshMessages();
				}
				break;
			}
			case 'tool.call': {
				const target = resolveAssistantTarget(msgs, ev.messageId);
				if (target.kind === 'refresh') {
					// Card arrived in a reconnect gap before its assistant message
					// was fetched — re-sync rather than silently dropping it.
					void refreshMessages();
					break;
				}
				const m = msgs[target.index];
				const isChild = !!ev.parentToolCallId;
				(m.toolCalls ??= []).push({
					id: ev.toolCallId,
					// Streaming cards only ever attach to server-persisted assistant
					// messages, whose id is always a number — the ephemeral string-id
					// bubbles (local-/err-/thinking-placeholder) never receive tool
					// calls. `ev.messageId` is absent for low-level SDK emitters, so
					// fall back to the resolved message's id.
					messageId: typeof m.id === 'number' ? m.id : (ev.messageId ?? 0),
					tool: ev.tool,
					argsJson: safeJson(ev.args),
					resultJson: null,
					status: 'pending',
					startedAt: Date.now(),
					endedAt: null,
					textOffset: isChild ? null : m.content.length,
					parentToolCallId: ev.parentToolCallId ?? null
				});
				touched = m.id;
				break;
			}
			case 'tool.result': {
				const tc = findToolCallRecord(msgs, ev.toolCallId);
				if (tc) {
					tc.status = ev.ok ? 'ok' : 'error';
					tc.resultJson = safeJson(ev.output ?? ev.summary);
					tc.endedAt = Date.now();
					// Drop ephemeral streaming state — final result supersedes it.
					delete tc.partialOutput;
					delete tc.progressMessage;
					if (ev.attachments && ev.attachments.length > 0) {
						tc.attachments = ev.attachments;
					}
					touched = tc.messageId;
				}
				break;
			}
			case 'subagent.lifecycle': {
				const tc = findToolCallRecord(msgs, ev.toolCallId);
				if (tc) {
					tc.backgroundAgentStatus = ev.status;
					tc.backgroundAgentId = ev.agentId;
					if (ev.status === 'running') {
						tc.backgroundAgentStartedAt ??= Date.now();
						tc.backgroundAgentEndedAt = null;
					} else {
						tc.backgroundAgentEndedAt = Date.now();
					}
					touched = tc.messageId;
				}
				break;
			}
			case 'tool.partial_output': {
				const tc = findToolCallRecord(msgs, ev.toolCallId);
				// The SDK emits cumulative snapshots of the tool's stdout/stderr
				// buffer (not deltas) so progress bars and carriage-return redraws
				// render correctly — each event already contains everything that
				// came before, so we replace rather than append.
				if (tc) tc.partialOutput = ev.output;
				break;
			}
			case 'tool.progress': {
				const tc = findToolCallRecord(msgs, ev.toolCallId);
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
				const target = resolveAssistantTarget(msgs, ev.messageId);
				if (target.kind === 'refresh') {
					// Edit card arrived in a reconnect gap before its assistant
					// message was fetched — re-sync rather than dropping it.
					void refreshMessages();
					break;
				}
				const m = msgs[target.index];
				const isChild = !!ev.parentToolCallId;
				(m.fileEdits ??= []).push({
					id: `${m.id}-${(m.fileEdits ?? []).length}`,
					// See the note on `tool.call`: streaming cards only attach to
					// number-id assistant messages.
					messageId: typeof m.id === 'number' ? m.id : (ev.messageId ?? 0),
					path: ev.path,
					diff: ev.diff,
					createdAt: Date.now(),
					textOffset: isChild ? null : m.content.length,
					parentToolCallId: ev.parentToolCallId ?? null
				});
				touched = m.id;
				break;
			}
			case 'error': {
				turnErrored = true;
				const last = msgs[msgs.length - 1];
				if (last && last.role === 'assistant') {
					last.status = 'error';
					last.errorCode = ev.code;
					touched = last.id;
				}
				// Always surface the error as a separate system message rather
				// than appending the server/agent-supplied text into the
				// assistant body, where adversarial Markdown (headings, tables,
				// HRs) could visually corrupt the thread.
				store.appendMessage(transcript, {
					id: `err-${Date.now()}`,
					conversationId: conversation.id,
					role: 'system',
					content: `Error: ${ev.message}`,
					status: 'error',
					errorCode: ev.code,
					createdAt: Date.now()
				});
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
				// Server-driven settings change (e.g. the runtime flipping approval
				// mode). Mirror it into
				// our local state so the header reflects reality without a
				// page refresh.
				if (ev.mode !== undefined) sessionMode = ev.mode;
				if (ev.memoryMode !== undefined) memoryMode = ev.memoryMode;
				if (ev.approvalMode !== undefined) approvalMode = ev.approvalMode;
				if (ev.disabledToolGroups !== undefined)
					disabledToolGroups = ev.disabledToolGroups.filter((g): g is PortalToolGroupId =>
						(PORTAL_TOOL_GROUP_IDS as readonly string[]).includes(g)
					);
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
					updatedAt: Date.now(),
					...(ev.percentage !== undefined ? { percentage: ev.percentage } : {}),
					...(ev.categories !== undefined ? { categories: ev.categories } : {}),
					...(ev.gridRows !== undefined ? { gridRows: ev.gridRows } : {}),
					...(ev.model !== undefined ? { model: ev.model } : {})
				};
				break;
			}
			case 'context.compaction': {
				if (ev.phase === 'complete') {
					recentCompaction = {
						...(ev.tokensRemoved !== undefined ? { tokensRemoved: ev.tokensRemoved } : {}),
						...(ev.messagesRemoved !== undefined ? { messagesRemoved: ev.messagesRemoved } : {})
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
		if (touched !== null) {
			store.syncEntry(transcript, touched);
			markOffsetsDirty();
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
			// Non-OK (e.g. the server rejected the response body): restore the
			// prompt below so the user can retry. Log the status so a wire-shape
			// mismatch is diagnosable rather than silently "doing nothing".
			console.warn(
				`interactive resolve failed: ${r.status} ${r.statusText} (request ${requestId})`
			);
		} catch (e) {
			console.warn('interactive resolve request errored', e);
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
		// Stable per-send key so a retried POST (after a client-side timeout)
		// dedupes server-side instead of creating a second user message/turn.
		const requestId = crypto.randomUUID();
		store.appendMessage(transcript, {
			id: localMessageId,
			conversationId: conversation.id,
			role: 'user',
			content: text,
			status: 'complete',
			errorCode: null,
			createdAt: Date.now()
		});
		markOffsetsDirty();
		scrollToBottom({ force: true });

		// Start the turn server-side, then attach an EventSource to its
		// stream. The POST is just a "create" — all event delivery flows
		// through the GET stream so reconnects (browser-driven) just work.
		streaming = true;
		// Roll back the optimistic send: restore the composer draft, surface the
		// failure, and drop the unpersisted `local-` bubble so it can't linger
		// as a duplicate of the next persisted message. Both failure paths below
		// funnel through here so they can't drift apart. Order matters: emit the
		// error event while the `local-` user bubble is still the last message so
		// `applyEvent`'s error case (which only touches a trailing *assistant*
		// message) can't accidentally mark a prior assistant reply as errored.
		const failSend = (code: string, message: string) => {
			streaming = false;
			if (!composer) composer = text;
			applyEvent({ type: 'error', code, message });
			store.removeMessage(transcript, localMessageId);
			markOffsetsDirty();
		};
		// POST the turn, reusing the same idempotency key across attempts so a
		// network/timeout failure that actually reached the server replays the
		// original turn instead of creating a duplicate user message. Only
		// transport failures (thrown fetch, abort timeout) are retried; an HTTP
		// response — even a non-2xx one — is returned to the caller as-is.
		const TURN_POST_TIMEOUT_MS = 30_000;
		const postTurn = async (): Promise<Response> => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), TURN_POST_TIMEOUT_MS);
			try {
				return await fetch(`/api/conversations/${conversation.id}/turns`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', 'idempotency-key': requestId },
					body: JSON.stringify({ content: text }),
					signal: controller.signal
				});
			} finally {
				clearTimeout(timer);
			}
		};
		try {
			let r: Response;
			try {
				r = await postTurn();
			} catch {
				// One bounded retry on a transport-level failure; the shared
				// idempotency key makes it safe even if the first attempt landed.
				r = await postTurn();
			}
			if (!r.ok) {
				let msg = `HTTP ${r.status}`;
				try {
					const body = (await r.json()) as { message?: string };
					if (body.message) msg = body.message;
				} catch {
					/* ignore */
				}
				failSend('start_failed', msg);
				return;
			}
			const {
				turnId,
				userMessageId,
				title: updatedTitle
			} = (await r.json()) as {
				turnId: string;
				userMessageId: number;
				title?: string | null;
			};
			store.replaceId(transcript, localMessageId, userMessageId);
			markOffsetsDirty();
			if (updatedTitle && updatedTitle !== title) {
				title = updatedTitle;
				void invalidateAll();
			}
			attachStream(turnId);
		} catch (e) {
			failSend('network', e instanceof Error ? e.message : String(e));
		}
	}

	async function stop() {
		// Tell the server to actually cancel the turn (just closing the
		// EventSource would only detach this client; the turn would keep
		// running). Crucially we keep the stream OPEN so the server's abort
		// flow can drain over it: it cancels every pending prompt and emits a
		// terminal `done` (status `interrupted`). The `done` handler then
		// clears any still-open prompt dialogs (see `stopping`) and closes the
		// stream. If we closed the stream synchronously here those terminal
		// events would never arrive and the dialogs would linger until reload.
		clearStreamStallTimeout();
		// A user-initiated stop is a "hold" path: disarm any armed follow-up
		// but keep the composer text so they can review and send manually.
		armed = false;
		const turnId = activeTurnId;
		if (!turnId) {
			// Nothing in flight to abort — just clear any lingering prompts.
			forceStopCleanup();
			return;
		}
		stopping = true;
		// Bounded safety net: if the server's abort flow doesn't drain in time
		// (wedged server, dropped stream) or the DELETE itself fails, force the
		// teardown so Stop is never stuck. The normal `done`-driven
		// `closeStream()` cancels this timer first on the happy path.
		clearStopFallbackTimer();
		stopFallbackTimer = setTimeout(() => {
			stopFallbackTimer = null;
			forceStopCleanup();
		}, STOP_FALLBACK_TIMEOUT_MS);
		const convId = conversation.id;
		// Only act on the settled DELETE if this stop is still current. The
		// await yields, during which a conversation switch (or the turn's own
		// terminal teardown) can run `closeStream()` — which resets `stopping`
		// and re-points state at a different conversation. Without this guard a
		// late non-OK/throwing DELETE would force-clear the *new* conversation's
		// stream and prompt dialogs.
		const stillCurrent = () => stopping && activeTurnId === turnId && conversation.id === convId;
		try {
			const r = await fetch(`/api/conversations/${convId}/turns/${turnId}`, {
				method: 'DELETE'
			});
			if (!r.ok && stillCurrent()) forceStopCleanup();
		} catch {
			if (stillCurrent()) forceStopCleanup();
		}
	}

	$effect(() => {
		void transcript.entries.length;
		scrollToBottom();
	});

	// Show a "thinking" indicator while we're awaiting the first token of the
	// next assistant message (i.e., streaming but no in-progress assistant
	// message exists yet, or it exists but has no content and no tool activity).
	const thinking = $derived.by(() => {
		if (!streaming || pendingInteractive.length > 0) return false;
		const lastEntry = transcript.entries[transcript.entries.length - 1];
		const last = lastEntry ? transcript.bodies.get(lastEntry.id) : undefined;
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

	// Keep the latest message visible when the messages container itself
	// resizes — most importantly when the mobile soft keyboard opens. The
	// app shell is sized from the VisualViewport (see +layout.svelte), so the
	// keyboard shrinks this container; the sticky-scroll effects above only
	// react to new content, so without this a pinned-to-bottom user would see
	// the last message slide up behind the keyboard. A ResizeObserver watches
	// the element's own box (which changes on viewport resize, not on content
	// growth), so this won't fight the content-driven scrolling.
	$effect(() => {
		const el = scrollEl;
		if (!el || typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(() => {
			if (pinnedToBottom) setScrollToBottom();
			scheduleWindowUpdate();
		});
		ro.observe(el);
		return () => ro.disconnect();
	});

	// While streaming, the in-progress assistant turn may not have produced a
	// message bubble yet (the first `message.start` event hasn't arrived). In
	// that window we append a synthetic placeholder assistant turn so the
	// thinking indicator (and the rest of the assistant-turn affordances)
	// render inside a normal bubble. Once a real assistant message exists it
	// takes over and the placeholder is dropped.
	const lastIsAssistant = $derived(
		transcript.entries[transcript.entries.length - 1]?.role === 'assistant'
	);
	// The latest persisted assistant message. Its memory-extractor card may show
	// a "Retry extraction" control — but only while the conversation is idle.
	const latestAssistantMessageId = $derived.by(() => {
		for (let i = transcript.entries.length - 1; i >= 0; i--) {
			if (transcript.entries[i].role === 'assistant') return transcript.entries[i].id;
		}
		return null;
	});
	// The user message that triggered the currently-streaming turn. Edit-fork
	// is hidden on it (you can't edit the live turn's boundary); every earlier
	// user message stays forkable even while this turn streams.
	const inFlightUserMessageId = $derived.by(() => {
		if (!streaming) return null;
		for (let i = transcript.entries.length - 1; i >= 0; i--) {
			if (transcript.entries[i].role === 'user') return transcript.entries[i].id;
		}
		return null;
	});
	const thinkingPlaceholder = $derived<DisplayMessage>({
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

	// --- Windowed rendering ----------------------------------------------
	//
	// Mounting every <Message_> at once is O(history): each one interleaves its
	// parts, runs `renderMarkdown` (marked + DOMPurify) and mounts a card per
	// tool call. On a 100-message / 600-tool-call thread that is most of the
	// time between "page loaded" and "page usable" — and on a phone it stays
	// frozen forever. So only a viewport ± margin window mounts full cards
	// (bounded by MAX_FULL_CARDS); every other message renders as a compact
	// index row (preview + record summaries). Index rows keep the scrollbar
	// honest — every entry stays in the DOM — while the heavy markdown/tool
	// cards stay bounded no matter how long the thread is.
	//
	// The window is recomputed from the rows' real `offsetTop`s on scroll
	// (rAF-throttled); because every entry renders a row, offsets are exact, so
	// windowing can't drift even when cards change height mid-stream.
	const OVERSCAN = 8;
	const MAX_FULL_CARDS = 40;
	const rowEls = new Map<string, HTMLElement>();
	let offsets: number[] = [];
	let offsetsDirty = true;
	let windowFrame = 0;

	let windowStart = $state(0);
	let windowEnd = $state(0);

	function markOffsetsDirty() {
		offsetsDirty = true;
		scheduleWindowUpdate();
	}

	function resetWindow() {
		windowStart = 0;
		windowEnd = 0;
		offsets = [];
		offsetsDirty = true;
	}

	// Captures each rendered row's element so the window can read real
	// offsets; the destroy hook keeps the map in sync as rows mount/unmount.
	function rowAction(node: HTMLElement, id: DisplayId) {
		rowEls.set(String(id), node);
		return {
			destroy() {
				rowEls.delete(String(id));
			}
		};
	}

	// First index whose offsetTop is >= target (all rows, in order).
	function lowerBoundIndex(arr: number[], target: number): number {
		let lo = 0;
		let hi = arr.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (arr[mid] < target) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	}

	function scheduleWindowUpdate() {
		if (windowFrame) return;
		windowFrame = requestAnimationFrame(() => {
			windowFrame = 0;
			computeWindow();
		});
	}

	function computeWindow() {
		const el = scrollEl;
		const n = transcript.entries.length;
		if (!el || n === 0) {
			windowStart = 0;
			windowEnd = 0;
			return;
		}
		if (offsetsDirty || offsets.length !== n) {
			offsets = new Array(n);
			for (let i = 0; i < n; i++) {
				const node = rowEls.get(String(transcript.entries[i].id));
				offsets[i] = node ? node.offsetTop : 0;
			}
			offsetsDirty = false;
		}
		const viewTop = el.scrollTop;
		const viewBottom = viewTop + el.clientHeight;
		let start = lowerBoundIndex(offsets, viewTop);
		if (start > 0) start -= 1; // a card may straddle the viewport top
		let end = lowerBoundIndex(offsets, viewBottom);
		start = Math.max(0, start - OVERSCAN);
		end = Math.min(n, end + OVERSCAN);
		if (end - start > MAX_FULL_CARDS) {
			const center = (start + end) >> 1;
			start = Math.max(0, center - (MAX_FULL_CARDS >> 1));
			end = Math.min(n, start + MAX_FULL_CARDS);
		}
		windowStart = start;
		windowEnd = end;
	}

	type RenderUnit =
		| { kind: 'message'; m: DisplayMessage; entry: TranscriptEntry }
		| { kind: 'index'; entry: TranscriptEntry };

	// The placeholder flows through the same render path as a real turn.
	const placeholderUnit = $derived<RenderUnit>({
		kind: 'message',
		m: thinkingPlaceholder,
		entry: {
			id: 'thinking-placeholder',
			role: 'assistant',
			status: 'streaming',
			errorCode: null,
			createdAt: Date.now(),
			preview: null,
			records: []
		}
	});

	const renderUnits = $derived.by<RenderUnit[]>(() => {
		const out: RenderUnit[] = [];
		const n = transcript.entries.length;
		for (let i = 0; i < n; i++) {
			const entry = transcript.entries[i];
			const body = i >= windowStart && i < windowEnd ? transcript.bodies.get(entry.id) : undefined;
			if (body) out.push({ kind: 'message', m: body, entry });
			else out.push({ kind: 'index', entry });
		}
		if (thinking && !lastIsAssistant) out.push(placeholderUnit);
		return out;
	});

	// --- Hydration (near-viewport, idled, LRU-capped) --------------------
	const hydrationQueue = new Set<number>();
	let hydrationTimer: ReturnType<typeof setTimeout> | null = null;
	let pumpingHydration = false;

	function clearHydrationQueue() {
		hydrationQueue.clear();
		if (hydrationTimer) {
			clearTimeout(hydrationTimer);
			hydrationTimer = null;
		}
	}

	function enqueueHydration(id: number) {
		hydrationQueue.add(id);
		if (hydrationTimer) return;
		const run = () => {
			hydrationTimer = null;
			void pumpHydration();
		};
		if (typeof requestIdleCallback === 'function') {
			// A timeout keeps a busy main thread from starving the queue.
			requestIdleCallback(run, { timeout: 600 });
		} else {
			hydrationTimer = setTimeout(run, 50);
		}
	}

	async function fetchHydration(id: number): Promise<void> {
		try {
			const r = await fetch(`/api/conversations/${conversation.id}/messages/${id}`);
			if (!r.ok) return;
			const data = (await r.json()) as { message: DisplayMessage | null };
			if (!data.message) return;
			store.hydrate(transcript, id, data.message);
			markOffsetsDirty();
			evictBodies();
		} catch {
			/* non-fatal */
		}
	}

	// Small serialized batches (2 at a time) — no burst of N fetches on a fast
	// scroll; the LRU cap bounds cached bodies regardless.
	async function pumpHydration() {
		if (pumpingHydration) return;
		pumpingHydration = true;
		try {
			while (hydrationQueue.size > 0) {
				const batch = [...hydrationQueue].slice(0, 2);
				for (const id of batch) hydrationQueue.delete(id);
				await Promise.all(batch.map((id) => fetchHydration(id)));
			}
		} finally {
			pumpingHydration = false;
		}
	}

	function evictBodies() {
		const pinned = new Set<DisplayId>();
		const n = transcript.entries.length;
		for (let i = Math.max(0, windowStart - OVERSCAN); i < Math.min(n, windowEnd + OVERSCAN); i++) {
			pinned.add(transcript.entries[i].id);
		}
		// Never evict the streaming tail.
		for (let i = Math.max(0, n - 5); i < n; i++) pinned.add(transcript.entries[i].id);
		store.evictLRU(transcript, TRANSCRIPT_BODY_CACHE_MAX, pinned);
	}

	$effect(() => {
		// Hydrate window entries that lack a body, during idle, coalesced.
		for (let i = windowStart; i < Math.min(windowEnd, transcript.entries.length); i++) {
			const e = transcript.entries[i];
			if (typeof e.id !== 'number') continue;
			if (transcript.bodies.has(e.id) || hydrationQueue.has(e.id)) continue;
			enqueueHydration(e.id);
		}
	});

	// --- Load older ------------------------------------------------------
	let loadingOlder = $state(false);

	async function loadOlderPage() {
		if (loadingOlder || !transcript.hasMoreOlder) return;
		const oldest = transcript.entries[0]?.id;
		if (typeof oldest !== 'number') return;
		loadingOlder = true;
		const el = scrollEl;
		// Prepend grows the document upward; hold the distance to the bottom
		// fixed so the reader's position doesn't slide.
		const distanceFromBottom = el ? el.scrollHeight - el.scrollTop : null;
		try {
			const r = await fetch(
				`/api/conversations/${conversation.id}/messages?beforeId=${oldest}&limit=${TRANSCRIPT_OLDER_PAGE_SIZE}`
			);
			if (!r.ok) return;
			const data = (await r.json()) as {
				entries: TranscriptEntry[];
				hasMore: boolean;
			};
			store.prependIndexPage(transcript, data.entries, data.hasMore);
			markOffsetsDirty();
			await tick();
			if (el && distanceFromBottom !== null) {
				setProgrammaticScrollGuard(120);
				el.scrollTop = el.scrollHeight - distanceFromBottom;
			}
		} catch {
			/* non-fatal */
		} finally {
			loadingOlder = false;
		}
	}

	$effect(() => {
		// Auto-load when the user reaches the top of a long conversation. After
		// a prepend the restored scroll position is past the top, so this can't
		// chain-load pages without further scrolling.
		if (!transcript.hasMoreOlder || loadingOlder) return;
		if (!scrollEl || scrollEl.scrollTop > 8) return;
		void loadOlderPage();
	});

	// --- Permalink + search jump ----------------------------------------
	let highlighted = $state<Set<DisplayId>>(new Set());
	let permalinkHandled = false;

	function highlightMessage(id: DisplayId) {
		const next = new Set(highlighted);
		next.add(id);
		highlighted = next;
		setTimeout(() => {
			const next2 = new Set(highlighted);
			next2.delete(id);
			highlighted = next2;
		}, 2500);
	}

	async function ensureMessageLoaded(id: number) {
		let guard = 0;
		while (
			!transcript.entries.some((e) => e.id === id) &&
			transcript.hasMoreOlder &&
			guard++ < 200
		) {
			await loadOlderPage();
		}
	}

	async function jumpToMessage(id: number) {
		await ensureMessageLoaded(id);
		if (!transcript.bodies.has(id)) await fetchHydration(id);
		await tick();
		const node = rowEls.get(String(id));
		const el = scrollEl;
		if (node && el) {
			const rect = node.getBoundingClientRect();
			const elRect = el.getBoundingClientRect();
			setProgrammaticScrollGuard(700);
			el.scrollTo({
				top: el.scrollTop + (rect.top - elRect.top) - el.clientHeight / 3,
				behavior: 'smooth'
			});
		}
		highlightMessage(id);
	}

	async function handlePermalinkOnLoad() {
		if (permalinkHandled || typeof window === 'undefined') return;
		const id = new URL(window.location.href).searchParams.get('message');
		if (!id || !/^\d+$/.test(id)) return;
		permalinkHandled = true;
		// Give the initial window a frame to mount, then fetch pages until the
		// target is loaded and scroll to it.
		setTimeout(() => void jumpToMessage(Number(id)), 50);
	}

	// --- In-conversation search -----------------------------------------
	type SearchResult = {
		messageId: number;
		role: string;
		status: string;
		createdAt: number;
		preview: string | null;
	};
	let searchOpen = $state(false);
	let searchQuery = $state('');
	let searching = $state(false);
	let searchResults = $state<SearchResult[] | null>(null);
	let searchError = $state<string | null>(null);
	let searchSeq = 0;

	async function runSearch() {
		const q = searchQuery.trim();
		if (!q) {
			searchResults = null;
			searchError = null;
			return;
		}
		const seq = ++searchSeq;
		searching = true;
		searchError = null;
		try {
			const r = await fetch(
				`/api/conversations/${conversation.id}/search?q=${encodeURIComponent(q)}&limit=20`
			);
			if (!r.ok) {
				if (seq === searchSeq) searchError = `Search failed (${r.status})`;
				return;
			}
			const data = (await r.json()) as { results: SearchResult[] };
			if (seq !== searchSeq) return;
			searchResults = data.results;
		} catch (e) {
			if (seq === searchSeq) searchError = e instanceof Error ? e.message : String(e);
		} finally {
			if (seq === searchSeq) searching = false;
		}
	}

	// Debounced search-as-you-type; the submit button shares the same path.
	$effect(() => {
		if (!searchOpen) return;
		const q = searchQuery.trim();
		if (!q) {
			searchResults = null;
			return;
		}
		const timer = setTimeout(() => void runSearch(), 300);
		return () => clearTimeout(timer);
	});

	function closeSearch() {
		searchOpen = false;
		searchResults = null;
		searchError = null;
	}
</script>

<div class="chat">
	<ChatHeader
		{title}
		{conversation}
		model={sessionModel}
		{defaultModelPlaceholder}
		{modelOptions}
		{parent}
		{usage}
		{recentCompaction}
		mode={sessionMode}
		{memoryMode}
		{memoryExtractorModel}
		{globalMemoryEnabled}
		{approvalMode}
		{disabledToolGroups}
		modelChangeDisabled={streaming}
		onSettingsChange={(patch) => {
			if (patch.model !== undefined) sessionModel = patch.model;
			if (patch.mode !== undefined) sessionMode = patch.mode;
			if (patch.memoryMode !== undefined) memoryMode = patch.memoryMode;
			if (patch.memoryExtractorModel !== undefined)
				memoryExtractorModel = patch.memoryExtractorModel;
			if (patch.globalMemoryEnabled !== undefined) globalMemoryEnabled = patch.globalMemoryEnabled;
			if (patch.approvalMode !== undefined) approvalMode = patch.approvalMode;
			if (patch.disabledToolGroups !== undefined) disabledToolGroups = patch.disabledToolGroups;
		}}
	/>

	<div class="chat-toolbar">
		{#if searchOpen}
			<form
				class="search-box"
				role="search"
				onsubmit={(e) => {
					e.preventDefault();
					void runSearch();
				}}
			>
				<input
					type="search"
					bind:value={searchQuery}
					placeholder="Search this conversation…"
					aria-label="Search this conversation"
				/>
				<button type="submit" class="btn sm" disabled={searching}>Search</button>
				<button type="button" class="btn sm" onclick={closeSearch} aria-label="Close search"
					>✕</button
				>
			</form>
			{#if searchResults !== null || searchError !== null}
				<div class="search-results" role="listbox" aria-label="Search results">
					{#if searching}
						<div class="search-status muted">Searching…</div>
					{:else if searchError !== null}
						<div class="search-status">Search failed: {searchError}</div>
					{:else if searchResults !== null && searchResults.length === 0}
						<div class="search-status muted">No matches for “{searchQuery}”</div>
					{:else if searchResults !== null}
						{#each searchResults as r (r.messageId)}
							<button
								type="button"
								class="search-result"
								role="option"
								aria-selected="false"
								onclick={() => void jumpToMessage(r.messageId)}
							>
								<span class="search-result-role">{r.role}</span>
								<span class="search-result-preview">{r.preview ?? 'Message'}</span>
							</button>
						{/each}
					{/if}
				</div>
			{/if}
		{:else}
			<button
				type="button"
				class="search-toggle"
				onclick={() => (searchOpen = true)}
				aria-label="Search this conversation"
			>
				<svg
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					stroke-width="1.6"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<circle cx="7" cy="7" r="4.5" />
					<path d="M10.5 10.5L14 14" />
				</svg>
				Search
			</button>
		{/if}
	</div>

	<div class="messages-wrap">
		<div class="messages" bind:this={scrollEl} onscroll={onMessagesScroll}>
			<div class="messages-inner" role="log" aria-live="polite" aria-label="Conversation messages">
				{#if transcript.entries.length === 0 && visibleInteractive.length === 0 && !thinking}
					<div class="empty-conversation">
						<EmptyState
							title="Start the conversation"
							description="Send a message below to begin. Your replies, tool calls, and edits will appear here."
							size="lg"
						/>
					</div>
				{/if}
				{#if transcript.hasMoreOlder}
					<div class="load-older-region">
						{#if loadingOlder}
							<span class="muted">Loading older messages…</span>
						{:else}
							<button
								type="button"
								class="load-older"
								onclick={() => void loadOlderPage()}
								aria-label="Load older messages"
							>
								Load older messages
							</button>
						{/if}
					</div>
				{/if}
				{#each renderUnits as u, i (u.entry.id)}
					{#if u.kind === 'message'}
						<div class:highlighted={highlighted.has(u.m.id)} use:rowAction={u.entry.id}>
							<Message_
								message={u.m}
								conversationId={conversation.id}
								inputMessageId={inputMessageIdByAssistant[String(u.m.id)] ?? null}
								forks={forksByMessage[String(u.m.id)] ?? []}
								isInFlightTurnUser={u.m.id === inFlightUserMessageId}
								thinking={thinking && i === renderUnits.length - 1}
								canRetryMemory={!streaming && u.m.id === latestAssistantMessageId}
								busy={streaming}
								onForked={refreshForks}
								onInlineEdited={handleInlineEdited}
								onRegenerated={handleRegenerated}
								onToolRerunStarted={handleToolRerunStarted}
								onMemoryRetryStarted={handleMemoryRetryStarted}
							/>
						</div>
					{:else}
						<div class:highlighted={highlighted.has(u.entry.id)} use:rowAction={u.entry.id}>
							<MessageIndexRow
								entry={u.entry}
								onHydrate={() => void fetchHydration(u.entry.id as number)}
							/>
						</div>
					{/if}
				{/each}
				{#each visibleInteractive as p (p.requestId)}
					<InteractiveRequestDialog
						request={p}
						onRespond={(r) => respondInteractive(p.requestId, r)}
					/>
				{/each}
				{#if transcript.entries.length > 0 || visibleInteractive.length > 0 || thinking}
					<div class="messages-bottom-spacer" aria-hidden="true"></div>
				{/if}
			</div>
		</div>
		<div class="jump-latest-region" role="status">
			{#if shouldShowJumpToLatest({ pinnedToBottom, hasNewBelow })}
				<button
					type="button"
					class="jump-latest"
					onclick={jumpToLatest}
					aria-label="Jump to latest messages"
				>
					Jump to latest
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
	/* --- Backend-projected transcript: toolbar / load-older / highlight --- */
	.chat-toolbar {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-5);
		border-bottom: 1px solid var(--border);
	}
	@media (max-width: 768px) {
		.chat-toolbar {
			padding: var(--space-1) var(--space-3);
		}
	}
	.search-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0.2rem 0.55rem;
		font: inherit;
		font-size: var(--fs-sm);
		color: var(--text-muted);
		background: transparent;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		cursor: pointer;
	}
	.search-toggle:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.search-box {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex: 1;
		max-width: 40rem;
	}
	.search-box input[type='search'] {
		flex: 1;
		min-width: 6rem;
		font: inherit;
		padding: 0.3rem 0.55rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--surface);
		color: inherit;
	}
	.search-box input[type='search']:focus {
		outline: none;
		border-color: var(--accent);
		box-shadow: var(--focus-ring);
	}
	.search-results {
		position: absolute;
		z-index: var(--z-overlay);
		top: 100%;
		left: var(--space-5);
		right: var(--space-5);
		max-width: 40rem;
		max-height: 18rem;
		overflow-y: auto;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		box-shadow: var(--shadow-2);
		padding: var(--space-1);
	}
	@media (max-width: 768px) {
		.search-results {
			left: var(--space-3);
			right: var(--space-3);
		}
	}
	.search-status {
		padding: 0.4rem 0.6rem;
		font-size: var(--fs-sm);
	}
	.search-result {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		width: 100%;
		text-align: left;
		padding: 0.4rem 0.6rem;
		font: inherit;
		font-size: var(--fs-sm);
		background: transparent;
		border: none;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	.search-result:hover,
	.search-result:focus-visible {
		background: var(--surface-hover);
	}
	.search-result-role {
		flex: none;
		font-weight: 600;
		color: var(--text-muted);
		text-transform: capitalize;
	}
	.search-result-preview {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.load-older-region {
		display: flex;
		justify-content: center;
		padding: var(--space-2) 0;
	}
	.load-older {
		padding: 0.35rem 0.8rem;
		font: inherit;
		font-size: var(--fs-sm);
		color: var(--text-muted);
		background: transparent;
		border: 1px dashed var(--border);
		border-radius: var(--radius-pill);
		cursor: pointer;
	}
	.load-older:hover {
		color: var(--text);
		background: var(--surface-hover);
	}
	.highlighted {
		animation: transcript-highlight 2.4s ease-out;
	}
	@keyframes transcript-highlight {
		0% {
			background: color-mix(in srgb, var(--accent) 22%, transparent);
			border-radius: var(--radius-lg);
		}
		100% {
			background: transparent;
		}
	}
</style>
