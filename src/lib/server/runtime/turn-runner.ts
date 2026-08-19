import { ulid } from "ulid";
import { log } from "../log";
import { messageId as msgCodec, toolCallId as toolCodec } from "$lib/ids";
import * as messages from "../db/repos/messages";
import * as convs from "../db/repos/conversations";
import * as usageRepo from "../db/repos/usage";
import * as turnInputs from "../db/repos/turn-inputs";
import * as memory from "../db/repos/memory";
import * as pool from "./pool";
import * as interactiveRequests from "./interactive-requests";
import { publishConversationActivity } from "./conversation-activity";
import { PORTAL_PRELUDE } from "./portal-prelude";
import { AsyncQueue } from "./async-queue";
import { snapshot as takeSnapshot } from "../snapshots";
import { isEnabled } from "../memory/engine";
import { loadConfig } from "../config";
import { mintReasoningBlockId } from "../db/repos/messages";
import type {
  ProviderOpenOptions,
  ProviderSession,
} from "../pi/session-contract";
import { isPiMode } from "../pi";
import type { MemoryMode, PortalEvent } from "$lib/types";
import {
  FINISHED_GRACE_MS,
  getTurn,
  deleteTurn,
  registerTurn,
  TurnAlreadyInProgressError,
  type IdentifiedEvent,
  type InternalTurn,
  type SubscribeOptions,
  type Turn,
} from "./turn-registry";
import {
  MEMORY_CONTINUATION_NUDGE,
  isMemoryOnlyEmptyTurn,
  makeExtractorCardDispatch,
  runMemoryExtractionCard,
  safeJson,
  type PendingReasoning,
  type PendingTool,
} from "./turn-memory-extraction";

export * from "./turn-registry";
export * from "./turn-memory-extraction";

// Shown when a turn finalizes with no content, no tool calls, and no
// reasoning — the provider effectively returned nothing. Surfaced as a
// visible system message (via an `error` event) so the user is never left
// staring at a dead empty bubble that survives refresh: the exact artifact
// the empty-turn guard exists to prevent. The client prefixes it with
// "Error: " when rendering.
const EMPTY_RESPONSE_MESSAGE =
  "The model returned an empty response. Retry to try again.";

// Shown when a turn executed tool calls but produced no final text answer even
// after the continuation nudge — the model stopped mid-task. Surfaced as a
// visible `error` event so the user gets Alert + Retry, not a dead tool-card bubble.
const INCOMPLETE_RESPONSE_MESSAGE =
  "The model stopped after tool work without replying. Retry to try again.";

// Nudge used by the general tool-call-without-answer guard (distinct from
// MEMORY_CONTINUATION_NUDGE, which targets memory-only recall turns).
export const CONTINUATION_NUDGE =
  "You made tool call(s) but have not yet replied. I never see tool output directly; using the results you have, finish the task and respond to me now. Do not end your turn without a substantive reply.";

// True when the turn yielded no assistant text. Used by the general
// tool-call-without-answer guard to detect a model that stopped after tool
// work without producing a final text answer.
function isTextEmpty(text: string): boolean {
  return text.trim().length === 0;
}

export interface StartTurnOptions {
  bridge: ProviderOpenOptions;
  prompt: string;
  conversationId: number;
  // The user message that triggered this turn. When provided, the full
  // assembled provider input (prelude + prompt) is captured against it so the
  // UI can inspect "the guts" of the turn later.
  userMessageId?: string | undefined;
  beforeSend?: (() => Promise<void>) | undefined;
  initialEvents?: PortalEvent[] | undefined;
  memory?:
    | {
        mode: MemoryMode;
        userMessageId: string;
        userContent: string;
        extractorModel?: string | null | undefined;
      }
    | undefined;
}

// Tear down a session in response to a user Stop. `abort()` asks the SDK to
// unwind its active stream gracefully, but a subprocess wedged in I/O can leave
// that promise pending forever. We race it against TURN_ABORT_FINALIZE_DEADLINE_MS
// and, on timeout, escalate to `dispose()` (force kill the subprocess) so a
// wedged session can't be orphaned. Fire-and-forget by design: the turn already
// finalizes off the abort signal regardless of how this settles, so all failure
// paths only log.
async function abortSessionWithDeadline(
  session: Pick<ProviderSession, "abort" | "dispose">,
  conversationId: number,
): Promise<void> {
  const deadlineMs = loadConfig().TURN_ABORT_FINALIZE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
    (timer as { unref?: () => void }).unref?.();
  });
  const aborted = session.abort().then(
    () => "aborted" as const,
    (err) => {
      log.warn("turn.session.abort_failed", {
        conversationId,
        err: err instanceof Error ? err.message : String(err),
      });
      return "aborted" as const;
    },
  );
  try {
    const outcome = await Promise.race([aborted, timedOut]);
    if (outcome === "timeout") {
      log.warn("turn.session.abort_timeout", { conversationId, deadlineMs });
      try {
        await session.dispose();
        log.info("turn.session.force_disposed", { conversationId });
      } catch (err) {
        log.warn("turn.session.dispose_failed", {
          conversationId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function startTurn(opts: StartTurnOptions): Promise<Turn> {
  const existing = getTurn(opts.conversationId);
  if (existing && existing.status === "running") {
    throw new TurnAlreadyInProgressError(opts.conversationId);
  }
  if (existing) {
    // Replace a finished-but-still-cached turn with the new one.
    deleteTurn(opts.conversationId);
  }

  const eventLog: PortalEvent[] = [];
  const subscribers = new Set<AsyncQueue<IdentifiedEvent>>();
  const turnAc = new AbortController();
  let session: Awaited<ReturnType<typeof pool.acquire>> | null = null;

  // Append an event to the log and fan it out to live subscribers with
  // its monotonic id (= index in `eventLog`). All paths that need to
  // surface an event MUST go through here so that ids stay contiguous
  // and aligned with the replay buffer.
  function emit(ev: PortalEvent) {
    // Live-only events (per-tool partial output, progress messages):
    // fan out to active subscribers but do NOT append to the event log.
    // Reconnects don't replay them; the authoritative final state comes
    // from `tool.result`.
    if (ev.type === "tool.partial_output" || ev.type === "tool.progress") {
      const wrapped: IdentifiedEvent = { id: -1, event: ev };
      for (const q of subscribers) q.push(wrapped);
      return;
    }
    const id = eventLog.length;
    eventLog.push(ev);
    const wrapped: IdentifiedEvent = { id, event: ev };
    for (const q of subscribers) q.push(wrapped);
  }

  const turn: InternalTurn = {
    id: ulid(),
    conversationId: opts.conversationId,
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    eventLog,
    subscribers,
    finishedPromise: undefined as unknown as Promise<void>,
    subscribe(subOpts?: SubscribeOptions) {
      return subscribe(turn, subOpts);
    },
    async abort() {
      turnAc.abort();
      interactiveRequests.cancelConversation(
        opts.conversationId,
        "turn_aborted",
      );
      // Do NOT await session.abort(): if the underlying session is wedged,
      // awaiting here would block the DELETE handler (and any caller) until
      // it unwinds. Aborting the turn signal already tears down the active
      // stream and arms the extraction watchdog, so the turn is guaranteed
      // to finalize regardless of how long the session takes to settle.
      // The fire-and-forget teardown races abort() against a deadline and
      // escalates to a force-dispose if abort() hangs, so a wedged SDK
      // subprocess can't be orphaned (leaking fds/memory) while the turn
      // finalizes as if it had succeeded.
      const sessionToAbort = session;
      if (sessionToAbort) {
        void abortSessionWithDeadline(sessionToAbort, opts.conversationId);
      }
    },
  };

  registerTurn(opts.conversationId, turn);
  publishConversationActivity(opts.bridge.userId, opts.conversationId, true);
  for (const ev of opts.initialEvents ?? []) emit(ev);

  // Accumulators for persistence.
  let assistantBuf = "";
  let assistantId: string | null = null;
  let persistedAssistantId: string | null = null;
  // Set once a `message.start` has been dispatched this turn. Distinct from
  // `assistantId`/`persistedAssistantId`: content-bearing events (deltas,
  // tool calls, reasoning) can persist an assistant row even when the SDK
  // never emitted `message_start`. The client only renders a bubble it saw a
  // `message.start` for, so the empty-turn finalizer uses this to decide
  // whether to synthesize one.
  let sawMessageStart = false;
  // Set to an error code when the stream fails for a non-abort reason
  // (network drop, SDK crash, rate-limit). Drives the terminal `status` to
  // `'error'` so the failed turn is persisted and reported as such rather
  // than a false `'complete'`. `null` means no stream failure.
  let streamErrorCode: string | null = null;
  const pendingTools = new Map<number, PendingTool>();
  // Reasoning segments keyed by the segmentId minted in the bridge. Order
  // of insertion matches stream order, which is what we persist.
  const pendingReasoning = new Map<string, PendingReasoning>();
  const persistedFileEditKeys = new Set<string>();
  let nextReasoningIndex = 0;

  function ensurePersistedAssistant(): string {
    if (persistedAssistantId) return persistedAssistantId;
    const persisted = messages.append(opts.conversationId, {
      role: "assistant",
      content: assistantBuf,
      status: "streaming",
    });
    persistedAssistantId = persisted.id;
    return persisted.id;
  }

  function dispatch(ev: PortalEvent) {
    // Suppress the SDK's `done` event: we always emit our own terminal
    // `done` in the finally block after persistence work completes.
    if (ev.type === "done") return;
    // A stream-level `error` event (pi_stream_error from the mapper,
    // pi_send_failed from runPrompt's catch, …) is a terminal failure even
    // though the stream itself ends "normally" afterwards. Drive the
    // finalizer to `status: 'error'` so the turn is never persisted as a
    // false `complete` (the first error is the root cause). The turn's own
    // catch overwrites with `stream_failed` on a hard throw.
    if (ev.type === "error") {
      streamErrorCode ??= ev.code;
    }

    if (ev.type === "message.start") {
      sawMessageStart = true;
      assistantId = ev.messageId;
      emit({ ...ev, messageId: ensurePersistedAssistant() });
    } else if (ev.type === "message.delta") {
      const persistedId = ensurePersistedAssistant();
      if (ev.parentToolCallId && ev.segmentId) {
        // Sub-agent content: thread it into the spawning card as a
        // 'content' block instead of appending to the outer message body,
        // so a nested agent renders its output interleaved with its
        // tools/reasoning. Accumulated by segmentId like reasoning.
        let seg = pendingReasoning.get(ev.segmentId);
        if (!seg) {
          seg = {
            id: mintReasoningBlockId(),
            segmentIndex: nextReasoningIndex++,
            text: "",
            kind: "content",
            textOffset: null,
            startedAt: Date.now(),
            durationMs: null,
            parentToolCallId: toolCodec.parse(ev.parentToolCallId),
          };
          pendingReasoning.set(ev.segmentId, seg);
        }
        seg.text += ev.text;
        messages.upsertReasoningBlock(msgCodec.parse(persistedId), seg);
        emit({ ...ev, messageId: persistedId });
      } else {
        assistantBuf += ev.text;
        messages.updateContentOnly(msgCodec.parse(persistedId), assistantBuf);
        emit({ ...ev, messageId: persistedId });
      }
    } else if (ev.type === "message.reasoning") {
      const persistedId = ensurePersistedAssistant();
      let seg = pendingReasoning.get(ev.segmentId);
      if (!seg) {
        const isChild = !!ev.parentToolCallId;
        seg = {
          id: mintReasoningBlockId(),
          segmentIndex: nextReasoningIndex++,
          text: "",
          kind: "reasoning",
          // Child reasoning isn't anchored to the outer assistant text;
          // it's rendered inside the SubagentCall card instead.
          textOffset: isChild ? null : assistantBuf.length,
          startedAt: Date.now(),
          durationMs: null,
          parentToolCallId: ev.parentToolCallId
            ? toolCodec.parse(ev.parentToolCallId)
            : null,
        };
        pendingReasoning.set(ev.segmentId, seg);
      }
      seg.text += ev.text;
      messages.upsertReasoningBlock(msgCodec.parse(persistedId), seg);
      emit({ ...ev, messageId: persistedId });
    } else if (ev.type === "message.reasoning.end") {
      const seg = pendingReasoning.get(ev.segmentId);
      const persistedId = ensurePersistedAssistant();
      if (seg) {
        seg.durationMs = ev.durationMs;
        messages.upsertReasoningBlock(msgCodec.parse(persistedId), seg);
      }
      emit({ ...ev, messageId: persistedId });
    } else if (ev.type === "message.end") {
      // D3: never create the assistant message from `message.end` alone.
      // runPrompt's finally synthesizes a `message.end` whenever the SDK
      // produced no real `message_end` (a silently-empty or
      // error-swallowed response, or a prompt that yielded nothing).
      // Creating the persisted row here — bypassing the turn finalizer's
      // own empty-turn guard — is exactly how an empty, `complete`,
      // no-error assistant message was born. Only ensure-persist when a
      // `message.start` (or content/tool activity) already anchored the
      // message this turn; otherwise pass the event through untouched so
      // the client no-ops on the unknown id.
      if (persistedAssistantId) {
        emit({ ...ev, messageId: ensurePersistedAssistant() });
      } else {
        emit(ev);
      }
    } else if (ev.type === "tool.call") {
      const isChild = !!ev.parentToolCallId;
      const persistedId = ensurePersistedAssistant();
      emit({ ...ev, messageId: persistedId });
      const toolCallId = toolCodec.parse(ev.toolCallId);
      const tool: PendingTool = {
        toolCallId,
        tool: ev.tool,
        argsJson: safeJson(ev.args),
        resultJson: null,
        status: "pending",
        startedAt: Date.now(),
        endedAt: null,
        textOffset: isChild ? null : assistantBuf.length,
        parentToolCallId: ev.parentToolCallId
          ? toolCodec.parse(ev.parentToolCallId)
          : null,
      };
      pendingTools.set(toolCallId, tool);
      messages.upsertToolCall(msgCodec.parse(persistedId), {
        id: tool.toolCallId,
        tool: tool.tool,
        argsJson: tool.argsJson,
        resultJson: tool.resultJson,
        status: tool.status,
        startedAt: tool.startedAt,
        endedAt: tool.endedAt,
        textOffset: tool.textOffset,
        parentToolCallId: tool.parentToolCallId,
      });
    } else if (ev.type === "tool.result") {
      emit(ev);
      const tc = pendingTools.get(toolCodec.parse(ev.toolCallId));
      if (tc) {
        tc.status = ev.ok ? "ok" : "error";
        tc.resultJson = safeJson(ev.output ?? ev.summary);
        tc.endedAt = Date.now();
        messages.updateToolCall(toolCodec.parse(ev.toolCallId), {
          status: tc.status,
          resultJson: tc.resultJson,
          endedAt: tc.endedAt,
        });
      }
    } else if (ev.type === "subagent.lifecycle") {
      emit(ev);
      messages.updateBackgroundAgentLifecycle(
        toolCodec.parse(ev.toolCallId),
        ev.agentId,
        ev.status,
      );
    } else if (ev.type === "file.edit") {
      const isChild = !!ev.parentToolCallId;
      const persistedId = ensurePersistedAssistant();
      emit({ ...ev, messageId: persistedId });
      const textOffset = isChild ? null : assistantBuf.length;
      const parentToolCallId = ev.parentToolCallId
        ? toolCodec.parse(ev.parentToolCallId)
        : null;
      const key = JSON.stringify([
        ev.path,
        ev.diff,
        textOffset,
        parentToolCallId,
      ]);
      if (!persistedFileEditKeys.has(key)) {
        persistedFileEditKeys.add(key);
        messages.insertFileEdit(
          msgCodec.parse(ensurePersistedAssistant()),
          ev.path,
          ev.diff,
          textOffset,
          parentToolCallId,
        );
      }
    } else if (ev.type === "context.usage") {
      emit(ev);
      try {
        usageRepo.upsert(opts.conversationId, {
          currentTokens: ev.currentTokens,
          tokenLimit: ev.tokenLimit,
        });
      } catch (usageErr) {
        log.warn("turn.usage.persist_failed", {
          conversationId: opts.conversationId,
          err: String(usageErr),
        });
      }
    } else {
      emit(ev);
    }
  }

  // Prepend a portal-context block telling the agent it's running through
  // a permission gateway and that reject `feedback` is authoritative.
  // The user's message itself is preserved verbatim after the block;
  // this only changes what the agent sees, not what we persist (the raw
  // user content was already stored by the turns route before we got
  // here).
  //
  // Skip in stub mode: the deterministic test stub echoes whatever it
  // receives, so dumping the prelude into its reply breaks tests that
  // assert on the literal user prompt and wastes tokens against a
  // fixed-string responder that wouldn't act on the guidance anyway.
  const prelude = isPiMode() ? "" : PORTAL_PRELUDE;
  const promptToSend = prelude ? `${prelude}\n\n${opts.prompt}` : opts.prompt;

  // Capture the exact provider input for this turn so the UI can surface it
  // read-only (portal prelude + memory/prior-message context + user content).
  // Best-effort: never let an observability write break the turn.
  if (opts.userMessageId) {
    try {
      turnInputs.record({
        messageId: msgCodec.parse(opts.userMessageId),
        conversationId: opts.conversationId,
        turnId: turn.id,
        fullInput: promptToSend,
        promptBody: opts.prompt,
        prelude,
        model: opts.bridge.model ?? null,
        mode: opts.bridge.mode ?? null,
        memoryMode: opts.bridge.memoryMode ?? null,
        initialMessages:
          opts.bridge.initialMessages?.map((m) => ({
            role: m.role,
            content: m.content,
          })) ?? null,
      });
    } catch (recordErr) {
      log.warn("turn.input.record_failed", {
        conversationId: opts.conversationId,
        err: String(recordErr),
      });
    }
  }

  turn.finishedPromise = (async () => {
    try {
      await opts.beforeSend?.();
      session = await pool.acquire(opts.bridge);
      // First time this conversation runs with persistence, record the
      // created session file so later acquires resume the same tree.
      const sessionFile = session.sessionFile;
      if (sessionFile && sessionFile !== opts.bridge.sessionFilePath) {
        try {
          convs.setSessionFile(
            opts.conversationId,
            opts.bridge.userId,
            sessionFile,
          );
        } catch (err) {
          log.warn("turn.session_file_persist_failed", {
            conversationId: opts.conversationId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Edit/regenerate rewind: rewind the persistent tree to the target user
      // message before prompting so the turn starts a fresh branch (matching
      // the SQLite truncation) instead of appending to the tail.
      if (opts.bridge.rewindToUserMessageOrdinal !== undefined) {
        await session.rewindToUserMessageOrdinal?.(
          opts.bridge.rewindToUserMessageOrdinal,
        );
      }
      if (turnAc.signal.aborted) {
        // Same wedge hazard as turn.abort(): a bare `await session.abort()`
        // would hang `finishedPromise` (and thus turn cleanup) forever if the
        // SDK subprocess is stuck in I/O. Bound it with the deadline helper so a
        // stuck abort escalates to a force-dispose instead of orphaning the turn.
        await abortSessionWithDeadline(session, opts.conversationId);
        return;
      }
      for await (const ev of session.send(promptToSend, turnAc.signal)) {
        dispatch(ev);
      }
      // Memory-mode "tool call then nothing" guard: if the model only
      // fired recall tools and produced no user-facing text, nudge it
      // once to answer using what it retrieved. The provider session
      // retains the prior tool calls/results, so this continues in
      // context. Bounded to a single retry to avoid loops.
      if (
        !turnAc.signal.aborted &&
        opts.memory &&
        isEnabled(opts.memory.mode) &&
        isMemoryOnlyEmptyTurn(assistantBuf, pendingTools)
      ) {
        log.info("turn.memory.continuation_nudge", {
          conversationId: opts.conversationId,
          toolCalls: pendingTools.size,
        });
        for await (const ev of session.send(
          MEMORY_CONTINUATION_NUDGE,
          turnAc.signal,
        )) {
          dispatch(ev);
        }
        // The nudge is bounded to one retry. If the continuation still
        // produced no user-facing text, the turn finalizes without an
        // answer — surface that so the failure mode is observable
        // rather than silently swallowed.
        if (
          !turnAc.signal.aborted &&
          isMemoryOnlyEmptyTurn(assistantBuf, pendingTools)
        ) {
          log.warn("turn.memory.continuation_nudge_unanswered", {
            conversationId: opts.conversationId,
            toolCalls: pendingTools.size,
          });
        }
      }
      // Tool-call-without-answer guard: ≥1 tool call executed but no user-facing
      // text — the model stopped mid-task. Nudge once to finish; if still empty,
      // classify as `error`/`incomplete_response` instead of a silent `complete`.
      if (
        !turnAc.signal.aborted &&
        !streamErrorCode &&
        pendingTools.size > 0 &&
        isTextEmpty(assistantBuf)
      ) {
        log.info("turn.continuation_nudge", {
          conversationId: opts.conversationId,
          toolCalls: pendingTools.size,
        });
        for await (const ev of session.send(
          CONTINUATION_NUDGE,
          turnAc.signal,
        )) {
          dispatch(ev);
        }
        // Bounded to one retry. Re-check covers the whole turn since
        // `pendingTools` accumulates across both sends.
        if (
          !turnAc.signal.aborted &&
          pendingTools.size > 0 &&
          isTextEmpty(assistantBuf)
        ) {
          streamErrorCode = "incomplete_response";
          log.warn("turn.incomplete_response", {
            conversationId: opts.conversationId,
            toolCalls: pendingTools.size,
          });
        }
      }
    } catch (e) {
      if (turnAc.signal.aborted) return;
      streamErrorCode = "stream_failed";
      log.warn("turn.stream.failed", {
        conversationId: opts.conversationId,
        err: String(e),
      });
      dispatch({
        type: "error",
        code: "stream_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      let status: "interrupted" | "complete" | "error" = turnAc.signal.aborted
        ? "interrupted"
        : streamErrorCode
          ? "error"
          : "complete";
      let errorCode: string | null = streamErrorCode;

      // D2: never leave a silent empty `complete` message. If the turn
      // finished cleanly but produced no assistant text, no tool calls,
      // and no reasoning, the provider effectively returned nothing (a
      // silently-empty or error-swallowed response, or a prompt that
      // yielded nothing). Persisting that as `complete` is exactly the
      // "dead empty bubble that survives refresh" artifact. Surface it as
      // an explicit `empty_response` error instead, so the UI shows an
      // Alert + Retry. Real provider failures already land here as
      // `status === 'error'` (and a Stop as `interrupted`), so this only
      // touches turns that would otherwise be a silent empty `complete`.
      const emptyResponse =
        status === "complete" &&
        assistantBuf.trim().length === 0 &&
        pendingTools.size === 0 &&
        pendingReasoning.size === 0;
      if (emptyResponse) {
        status = "error";
        errorCode = "empty_response";
        log.warn("turn.empty_response", {
          conversationId: opts.conversationId,
          turnId: turn.id,
        });
      }

      try {
        if (
          persistedAssistantId ||
          assistantBuf ||
          assistantId ||
          pendingTools.size ||
          emptyResponse ||
          // A stream-level error (pi_send_failed / pi_stream_error /
          // stream_failed) with no message row yet still deserves a
          // durable error trace + Retry affordance, rather than
          // vanishing after refresh.
          streamErrorCode !== null
        ) {
          const id = ensurePersistedAssistant();
          messages.updateContent(
            msgCodec.parse(id),
            assistantBuf,
            status,
            errorCode,
          );
          for (const t of pendingTools.values()) {
            if (t.status === "pending") {
              t.status = "error";
              t.endedAt = Date.now();
              messages.updateToolCall(t.toolCallId, {
                resultJson: t.resultJson,
                status: t.status,
                endedAt: t.endedAt,
              });
            }
          }
          // The client only renders bubbles it saw a `message.start`
          // for. When the turn produced no stream events at all
          // (runPrompt's synthetic `message.end`), no bubble exists
          // yet — emit start/end so the errored bubble renders, then
          // the `error` event below marks it and surfaces the visible
          // system message + Retry affordance.
          if (emptyResponse && !sawMessageStart) {
            dispatch({
              type: "message.start",
              messageId: id,
              role: "assistant",
            });
            dispatch({ type: "message.end", messageId: id });
          }
        }
        convs.touch(opts.conversationId);
      } catch (persistErr) {
        log.error("turn.persist.failed", {
          conversationId: opts.conversationId,
          err: String(persistErr),
        });
      }

      // Surface the empty response to live subscribers (and the event
      // log, so a reconnect replays it): the client turns `error` into a
      // visible system message and marks the trailing assistant bubble.
      if (emptyResponse) {
        dispatch({
          type: "error",
          code: "empty_response",
          message: EMPTY_RESPONSE_MESSAGE,
        });
      }

      // Surface the incomplete response (tool calls but no answer, even after
      // the continuation nudge) the same way: a visible `error` event so the
      // UI shows Alert + Retry rather than a dead tool-card-only bubble.
      if (streamErrorCode === "incomplete_response") {
        dispatch({
          type: "error",
          code: "incomplete_response",
          message: INCOMPLETE_RESPONSE_MESSAGE,
        });
      }

      // Post-turn workdir snapshot, bound to the assistant message
      // id. Used by "fork after this reply" affordances and for
      // post-turn diff views. Non-fatal on failure.
      if (persistedAssistantId) {
        try {
          await takeSnapshot(
            opts.bridge.workingDirectory,
            msgCodec.parse(persistedAssistantId),
            "post",
          );
        } catch (snapErr) {
          log.warn("snapshot.post.failed", {
            conversationId: opts.conversationId,
            messageId: persistedAssistantId,
            err: String(snapErr),
          });
        }
      }

      if (
        persistedAssistantId &&
        status === "complete" &&
        opts.memory &&
        isEnabled(opts.memory.mode)
      ) {
        const cfg = loadConfig();
        await runMemoryExtractionCard({
          emit,
          dispatch,
          turnAc,
          cfg,
          conversationId: opts.conversationId,
          userId: opts.bridge.userId,
          assistantMessageId: persistedAssistantId,
          assistantContent: assistantBuf,
          userMessageId: opts.memory.userMessageId,
          userContent: opts.memory.userContent,
          mode: opts.memory.mode,
          extractorModel: opts.memory.extractorModel,
          turnId: turn.id,
          cardDescription: "Memory extraction",
          extractingSummary: "Extracting durable memory updates.",
          logPrefix: "turn.memory",
          cancelOutput: "Cancelled by user.",
        });
      }

      // A Stop issued while the post-turn extractor was still running aborts
      // the turn signal after `status` was computed as `complete`; reflect
      // that late interrupt so the turn ends `interrupted`.
      turn.status = turnAc.signal.aborted ? "interrupted" : status;
      turn.endedAt = Date.now();
      // The turn is no longer running; the assistant message (if any) is
      // persisted by now, so `unread` resolves correctly for the sidebar.
      publishConversationActivity(
        opts.bridge.userId,
        opts.conversationId,
        false,
      );
      // We always emit our own terminal `done` here: `dispatch` suppresses
      // the SDK's `done` so this runs after persistence work completes. We
      // carry the terminal status so clients can distinguish a clean finish
      // from an interrupt/abort or a hard stream failure (`'error'`, which
      // also emits an `error` event). The `some` check is a defensive guard
      // against a double terminal event in case a future change ever
      // re-emits the SDK `done` into the log.
      if (!eventLog.some((e) => e.type === "done")) {
        emit({ type: "done", status: turn.status });
      }
      for (const q of subscribers) q.end();
      subscribers.clear();

      // Keep the finished turn around briefly so that a subscriber that
      // races with completion still gets the full replay.
      const t = setTimeout(() => {
        if (getTurn(opts.conversationId) === turn) {
          deleteTurn(opts.conversationId);
        }
      }, FINISHED_GRACE_MS);
      (t as { unref?: () => void }).unref?.();
    }
  })();

  return turn;
}

async function* subscribe(
  turn: InternalTurn,
  opts: SubscribeOptions = {},
): AsyncIterable<IdentifiedEvent> {
  const { signal, sinceId } = opts;

  // Replay buffered events from (sinceId, end]. `sinceId` is the last id
  // the client successfully received — we resume from sinceId+1. If
  // undefined, send everything from the start.
  // Note: the for-loop reads turn.eventLog.length each iteration, so any
  // events appended by dispatch between yields are picked up before we
  // fall through to the live subscription. No gap, no duplicates.
  const startIdx = opts.skipReplay
    ? turn.eventLog.length
    : sinceId === undefined
      ? 0
      : sinceId + 1;
  for (let i = startIdx; i < turn.eventLog.length; i++) {
    if (signal?.aborted) return;
    yield { id: i, event: turn.eventLog[i] };
  }

  // If the turn already finished, we're done after the replay.
  if (turn.status !== "running") {
    // `skipReplay` starts at the end of the log, so on an already-finished
    // turn the loop above yields nothing and the subscriber would otherwise
    // receive no events — forcing it to infer completion from silence.
    // Replay the terminal `done` (always the last log entry once a turn
    // finishes) so every subscriber gets an explicit terminal signal
    // regardless of attach timing.
    if (opts.skipReplay && !signal?.aborted) {
      const lastIdx = turn.eventLog.length - 1;
      if (lastIdx >= 0 && turn.eventLog[lastIdx].type === "done") {
        yield { id: lastIdx, event: turn.eventLog[lastIdx] };
      }
    }
    return;
  }

  // Subscribe to live events. Adding q to `subscribers` is synchronous
  // with the loop exit above (no awaits between them), so dispatch can't
  // slip an event in unobserved.
  const q = new AsyncQueue<IdentifiedEvent>();
  turn.subscribers.add(q);

  const onAbort = () => {
    // Unsubscribe only; do NOT cancel the turn.
    turn.subscribers.delete(q);
    q.end();
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    for await (const ev of q) {
      yield ev;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    turn.subscribers.delete(q);
  }
}

export interface StartExtractionRetryOptions {
  conversationId: number;
  userId: number;
  // The existing assistant message whose extraction is being re-run. Its
  // content is reused verbatim — the assistant response is NOT regenerated.
  assistantMessageId: string;
  assistantContent: string;
  memory: {
    mode: MemoryMode;
    userMessageId: string;
    userContent: string;
    extractorModel?: string | null;
    // Stable turn id used for the committed patch so repeated retries of the
    // same logical turn keep grouping under one turn id (the prior-patch
    // lookup keys off it). Defaults to the retry turn's own id when absent.
    patchTurnId?: string | null;
    // The prior committed patch to undo as part of this retry. The undo is
    // deferred until extraction succeeds (see `beforeCommit`), so a
    // failed/timed-out/aborted retry preserves the existing memory. Null
    // when the prior turn committed nothing to undo.
    priorPatchId?: number | null;
  };
}

/**
 * Re-run *only* the memory-extraction step for the latest assistant turn,
 * reusing the stored user + assistant messages. No provider session is opened,
 * the model is not re-prompted, and no new message is appended. The extractor's
 * subagent card and `memory.status` events are emitted through the same turn /
 * SSE machinery as a normal post-turn extraction, so the live card and inspector
 * update identically.
 *
 * Undoing the prior patch (`memory.priorPatchId`) is deferred until the
 * extraction has produced a committable patch — it runs immediately before the
 * new commit. A failed, timed-out, or aborted retry therefore leaves the
 * previously committed memory intact instead of destroying it.
 */
export async function startExtractionRetryTurn(
  opts: StartExtractionRetryOptions,
): Promise<Turn> {
  const existing = getTurn(opts.conversationId);
  if (existing && existing.status === "running") {
    throw new TurnAlreadyInProgressError(opts.conversationId);
  }
  if (existing) deleteTurn(opts.conversationId);

  const eventLog: PortalEvent[] = [];
  const subscribers = new Set<AsyncQueue<IdentifiedEvent>>();
  const turnAc = new AbortController();

  function emit(ev: PortalEvent) {
    if (ev.type === "tool.partial_output" || ev.type === "tool.progress") {
      const wrapped: IdentifiedEvent = { id: -1, event: ev };
      for (const q of subscribers) q.push(wrapped);
      return;
    }
    const id = eventLog.length;
    eventLog.push(ev);
    const wrapped: IdentifiedEvent = { id, event: ev };
    for (const q of subscribers) q.push(wrapped);
  }

  const turn: InternalTurn = {
    id: ulid(),
    conversationId: opts.conversationId,
    startedAt: Date.now(),
    endedAt: null,
    status: "running",
    eventLog,
    subscribers,
    finishedPromise: undefined as unknown as Promise<void>,
    subscribe(subOpts?: SubscribeOptions) {
      return subscribe(turn, subOpts);
    },
    async abort() {
      turnAc.abort();
    },
  };

  registerTurn(opts.conversationId, turn);
  publishConversationActivity(opts.userId, opts.conversationId, true);

  const dispatch = makeExtractorCardDispatch(emit, opts.assistantMessageId);
  const cfg = loadConfig();

  turn.finishedPromise = (async () => {
    // Undo the prior committed patch only once a replacement patch has
    // validated and is about to be applied (invoked by `commitPatch`, which
    // `extractAndCommitMemory` forwards `beforeCommit` to). If extraction
    // fails, times out, aborts, or yields a `needs_review` patch, this never
    // runs and the existing committed memory is preserved.
    //
    // `revertCommittedPatch` deletes what the patch created, reopens the loops
    // it resolved, restores the facts it forgot, then rebuilds the projection
    // so the active set — including supersede/dedupe — is re-derived from the
    // event log rather than hand-maintained. The patch row itself is left
    // intact, preserving history. (The re-extraction's pre-run packet view is
    // produced separately, by replaying the log forward to the turn's
    // branch-point head — see `readMemoryAtTurnStart`.)
    const priorPatchId = opts.memory.priorPatchId;
    const beforeCommit = priorPatchId
      ? () => memory.revertCommittedPatch(opts.conversationId, priorPatchId)
      : undefined;

    try {
      await runMemoryExtractionCard({
        emit,
        dispatch,
        turnAc,
        cfg,
        conversationId: opts.conversationId,
        userId: opts.userId,
        assistantMessageId: opts.assistantMessageId,
        assistantContent: opts.assistantContent,
        userMessageId: opts.memory.userMessageId,
        userContent: opts.memory.userContent,
        mode: opts.memory.mode,
        extractorModel: opts.memory.extractorModel,
        turnId: opts.memory.patchTurnId ?? turn.id,
        cardDescription: "Memory extraction (retry)",
        extractingSummary: "Re-extracting durable memory updates.",
        logPrefix: "memory.retry",
        cancelOutput: "Cancelled.",
        beforeCommit,
        priorPatchId,
      });
    } finally {
      try {
        convs.touch(opts.conversationId);
      } catch (touchErr) {
        log.warn("memory.retry.touch_failed", {
          conversationId: opts.conversationId,
          err: String(touchErr),
        });
      }
      turn.status = turnAc.signal.aborted ? "interrupted" : "complete";
      turn.endedAt = Date.now();
      publishConversationActivity(opts.userId, opts.conversationId, false);
      if (!eventLog.some((e) => e.type === "done")) {
        emit({
          type: "done",
          status: turn.status === "interrupted" ? "interrupted" : "complete",
        });
      }
      for (const q of subscribers) q.end();
      subscribers.clear();
      const t = setTimeout(() => {
        if (getTurn(opts.conversationId) === turn)
          deleteTurn(opts.conversationId);
      }, FINISHED_GRACE_MS);
      (t as { unref?: () => void }).unref?.();
    }
  })();

  return turn;
}
