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

import { join } from "node:path";
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
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ApprovalMode, PortalEvent, SessionMode } from "$lib/types";
import type { PortalTool } from "../tools/types";
import { assemblePiTools } from "../tools/assemble";
import { createPiPermissionResolver } from "./permission-gate";
import { piContextUsageToEvent } from "./context-usage";
import { workspaceRootsFor } from "../leases";
import type { ProviderSession } from "./session-contract";
import { AsyncQueue } from "../runtime/async-queue";
import { log } from "../log";
import { PiEventMapper, type ToolCallIdMap } from "./events";
import { loadConfig } from "../config";
import * as messagesRepo from "../db/repos/messages";
import { PORTAL_SYSTEM_GUIDANCE } from "../runtime/system-guidance";

export type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

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
    toolCallId: string,
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
  /**
   * Conversation whose portal messages seed a freshly-created session tree.
   * Only used when a new persistent session file is created (no history in
   * the tree yet) so fork/legacy conversations keep their context and the
   * edit/regenerate rewind stays ordinal-aligned with SQLite.
   */
  conversationId?: number;
  /**
   * Durable session file to resume, or `null` to create a new persistent one.
   * `undefined` keeps the session in-memory (no file) — used by one-shot opens
   * and memory-mode turns.
   */
  sessionFilePath?: string | null;
  /**
   * Operator-managed extension paths/specs (see `extensions.enabledExtensionPaths`).
   * Loaded via the SDK's `additionalExtensionPaths` even with `noExtensions:true`;
   * load failures are non-fatal (the session still opens with the valid ones).
   */
  additionalExtensionPaths?: string[];
  /** Optional system-prompt override (pi ResourceLoader `systemPrompt`). */
  systemPrompt?: string;
  /** Optional system-prompt suffix (pi ResourceLoader `appendSystemPrompt`). */
  appendSystemPrompt?: string;
}

/**
 * Build the `SessionManager` for a conversation: resume its durable session
 * file, create a new one, or stay in-memory. `undefined` path (no persistence
 * requested) maps to in-memory; `null` creates a file under DATA_DIR/sessions
 * and seeds it from the conversation's portal history; a path resumes it.
 */
function buildPiSessionManager(opts: CreatePiSessionOptions): SessionManager {
  if (opts.sessionFilePath === undefined) {
    return SessionManager.inMemory(opts.cwd);
  }
  const sessionDir = join(loadConfig().DATA_DIR, "sessions");
  if (opts.sessionFilePath) {
    return SessionManager.open(opts.sessionFilePath, sessionDir, opts.cwd);
  }
  const manager = SessionManager.create(opts.cwd, sessionDir);
  if (opts.conversationId) {
    seedSessionFromMessages(manager, opts.conversationId, opts.model);
  }
  return manager;
}

/**
 * Replay a conversation's complete portal messages into a fresh session tree as
 * user/assistant text entries. Used only when a new session file is created for
 * a conversation that already has SQLite history (a fork, or a legacy
 * conversation first resumed under persistence): it gives the resumed agent the
 * prior context and keeps the tree's user-message ordinals aligned with SQLite
 * so edit/regenerate rewind targets the right entry. Tool calls are not
 * replayed — the transcript text is enough as prior context.
 */
function seedSessionFromMessages(
  manager: SessionManager,
  conversationId: number,
  model: PiModel,
): void {
  const modelId = model.id ?? "pi";
  const all = messagesRepo.listByConversation(conversationId);
  // The current user prompt is the last row (the route appends it before the
  // turn starts) and has no assistant reply yet — the turn appends it itself,
  // so seeding it too would duplicate it on the tree and desync the rewind
  // ordinals. Skip only that trailing user message; prior history stays.
  const tail = all[all.length - 1];
  const rows = tail && tail.role === "user" ? all.slice(0, -1) : all;
  for (const m of rows) {
    if (m.status !== "complete") continue;
    const text = m.content.trim();
    if (!text) continue;
    if (m.role === "user") {
      manager.appendMessage({
        role: "user",
        content: [{ type: "text", text }],
        timestamp: m.createdAt,
      });
    } else if (m.role === "assistant") {
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        api: "pi",
        provider: "pi",
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: m.createdAt,
      });
    }
  }
}

/** Create a pi `AgentSession` over the shared runtime with session state. */
export async function createPiSession(
  opts: CreatePiSessionOptions,
): Promise<AgentSession> {
  const agentDir = getAgentDir();
  const loaderOptions: ConstructorParameters<typeof DefaultResourceLoader>[0] =
    {
      cwd: opts.cwd,
      agentDir,
      extensionFactories: [createPiPermissionBridge(opts.permissionResolver)],
      additionalExtensionPaths: opts.additionalExtensionPaths ?? [],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: false,
      // Global portal guidance rides the loader's `appendSystemPrompt` channel
      // so pi appends it to the system prompt once at session setup (system
      // tokens, cache-friendly). Per-tool caveats come from each tool's
      // `promptGuidelines` instead — nothing tool-specific belongs here.
      appendSystemPrompt: [PORTAL_SYSTEM_GUIDANCE],
    };
  // Template system-prompt overrides (ticket #41). `systemPrompt` replaces the
  // default coding-assistant block; `appendSystemPrompt` is appended UNDER the
  // portal guidance. Both absent → today's path, byte-for-byte.
  if (opts.systemPrompt !== undefined) {
    loaderOptions.systemPrompt = opts.systemPrompt;
  }
  if (opts.appendSystemPrompt !== undefined) {
    loaderOptions.appendSystemPrompt = [
      ...(loaderOptions.appendSystemPrompt ?? []),
      opts.appendSystemPrompt,
    ];
  }
  const loader = new DefaultResourceLoader(loaderOptions);
  await loader.reload();
  const sessionManager = buildPiSessionManager(opts);
  const { session } = await createAgentSession({
    cwd: opts.cwd,
    agentDir,
    modelRuntime: opts.runtime,
    model: opts.model,
    noTools: "builtin",
    customTools: opts.customTools,
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
  });
  return session;
}

export interface PiProviderSessionOptions {
  cwd: string;
  model: PiModel;
  runtime: ModelRuntime;
  provider: string;
  providerLabel: string;
  conversationId: number;
  providerSessionId: string;
  userId: number;
  policy: import("$lib/types").PermissionPolicy;
  mode?: SessionMode;
  approvalMode?: ApprovalMode;
  disabledToolGroups?: string[];
  /**
   * Optional system-prompt override seeded from the launching prompt template
   * (pi ResourceLoader `systemPrompt`). Absent = default coding identity.
   */
  systemPrompt?: string;
  /** Optional system-prompt suffix from the launching prompt template. */
  appendSystemPrompt?: string;
  workspaceKey?: string;
  memoryMode?: import("$lib/types").MemoryMode;
  globalMemoryEnabled?: boolean;
  /** Durable session file to resume, or `null` to create one; see `CreatePiSessionOptions`. */
  sessionFilePath?: string | null;
  /** Operator-managed extension paths/specs to load (see `CreatePiSessionOptions`). */
  additionalExtensionPaths?: string[];
  /** sha1 over the extension set this session is opened with (pool re-match). */
  extensionFingerprint?: string;
  onEvent?: (e: PortalEvent) => void;
}

/** Build a `ProviderSession` wrapping a live pi `AgentSession`. */
export async function createPiProviderSession(
  opts: PiProviderSessionOptions,
): Promise<ProviderSession> {
  // Live, mutable session state the getters below read (so a mid-turn PATCH
  // via setApprovalMode takes effect on the next tool call, not the next
  // session open).
  const state = {
    mode: opts.mode ?? "interactive",
    approvalMode: opts.approvalMode ?? "ask",
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
    ...(opts.workspaceKey !== undefined
      ? { workspaceKey: opts.workspaceKey }
      : {}),
    ...(opts.disabledToolGroups !== undefined
      ? { disabledToolGroups: opts.disabledToolGroups }
      : {}),
    ...(opts.memoryMode !== undefined ? { memoryMode: opts.memoryMode } : {}),
    ...(opts.globalMemoryEnabled !== undefined
      ? { globalMemoryEnabled: opts.globalMemoryEnabled }
      : {}),
  });
  const permissionResolver = createPiPermissionResolver({
    userId: opts.userId,
    conversationId: opts.conversationId,
    workingDirectory: opts.cwd,
    policy: opts.policy,
    portalToolsByName,
    getApprovalMode: () => state.approvalMode,
    getWorkspaceRoots,
    emit,
  });

  const piSession = await createPiSession({
    cwd: opts.cwd,
    model: opts.model,
    runtime: opts.runtime,
    customTools,
    portalToolsByName,
    permissionResolver,
    conversationId: opts.conversationId,
    ...(opts.sessionFilePath !== undefined
      ? { sessionFilePath: opts.sessionFilePath }
      : {}),
    ...(opts.additionalExtensionPaths !== undefined
      ? { additionalExtensionPaths: opts.additionalExtensionPaths }
      : {}),
    ...(opts.systemPrompt !== undefined
      ? { systemPrompt: opts.systemPrompt }
      : {}),
    ...(opts.appendSystemPrompt !== undefined
      ? { appendSystemPrompt: opts.appendSystemPrompt }
      : {}),
  });
  return makePiProviderSession(piSession, opts, {
    state,
    getActiveQueue: () => activeQueue,
    setActiveQueue: (queue: AsyncQueue<PortalEvent> | null) => {
      activeQueue = queue;
    },
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
  runtime: ProviderSessionRuntime,
): ProviderSession {
  let active: { queue: AsyncQueue<PortalEvent>; unsub: () => void } | null =
    null;
  let disposed = false;

  const sessionFile = piSession.sessionManager.getSessionFile();
  // Session-stable SDK→portal tool-id map: shared by every send() of this turn
  // so one SDK tool id maps to one portal numeric id (the root-cause fix for
  // a second send minting a fresh id and stranding the persisted tool.call
  // row: see ToolCallIdMap in events.ts).
  const sharedToolCallIds: ToolCallIdMap = new Map();
  const session: ProviderSession = {
    provider: opts.provider,
    conversationId: opts.conversationId,
    providerSessionId: opts.providerSessionId,
    workingDirectory: opts.cwd,
    model: opts.providerLabel,
    ...(sessionFile ? { sessionFile } : {}),
    ...(opts.extensionFingerprint !== undefined
      ? { extensionFingerprint: opts.extensionFingerprint }
      : {}),
    lastUsed: Date.now(),
    async rewindToUserMessageOrdinal(ordinal: number) {
      // The portal stream ends on `agent_end`, but pi clears its streaming
      // flag in the run's settle a tick later — a rewind issued right after a
      // turn can still land mid-teardown. Wait for idle so `navigateTree`
      // never throws "current response not finished".
      await piSession.waitForIdle();
      // Rewind to the ordinal-th user message on the session's active path.
      // `navigateTree` on a user entry sets the leaf to its parent — exactly
      // the "reply to this user message again" position the turn-runner then
      // prompts from, appending a fresh branch (the edit/regenerate flow).
      let seen = -1;
      for (const entry of piSession.sessionManager.buildContextEntries()) {
        if (entry.type !== "message" || entry.message.role !== "user") continue;
        seen++;
        if (seen === ordinal) {
          await piSession.navigateTree(entry.id);
          return;
        }
      }
      log.warn("pi.session.rewind_target_missing", {
        conversationId: opts.conversationId,
        ordinal,
        userEntries: seen + 1,
      });
    },
    async *send(
      prompt: string,
      signal: AbortSignal,
    ): AsyncIterable<PortalEvent> {
      if (active)
        throw new Error("session busy: a turn is already in progress");
      if (disposed) throw new Error("session disposed");
      const messageId = ""; // sentinel — the turn-runner overwrites it via `ensurePersistedAssistant`
      const queue = new AsyncQueue<PortalEvent>();
      const mapper = new PiEventMapper(messageId, sharedToolCallIds);
      const unsub = piSession.subscribe((ev) => {
        for (const portalEvent of mapper.map(ev)) queue.push(portalEvent);
        // `agent_end` terminates the run: snapshot this turn's context
        // usage and emit it before the stream closes (one per turn), then
        // end the stream here (runPrompt's finally re-ends as a no-op
        // safety net for aborted runs).
        if (ev.type === "agent_end") {
          const portalUsage = piSession.getContextUsage();
          if (portalUsage) {
            const mapped = piContextUsageToEvent(portalUsage);
            if (mapped) queue.push(mapped);
          }
          queue.end();
        }
      });
      active = { queue, unsub };
      runtime.setActiveQueue(queue);
      const onAbort = () => void piSession.abort().catch(() => {});
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      void runPrompt(
        prompt,
        piSession,
        mapper,
        queue,
        messageId,
        opts.conversationId,
      );
      try {
        for await (const ev of queue) {
          opts.onEvent?.(ev);
          yield ev;
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
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
        log.warn("pi.session.dispose_failed", {
          conversationId: opts.conversationId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async setMode(mode: SessionMode) {
      runtime.state.mode = mode;
    },
    async setApprovalMode(mode: ApprovalMode) {
      runtime.state.approvalMode = mode;
    },
  };
  return session;
}

async function runPrompt(
  prompt: string,
  piSession: AgentSession,
  mapper: PiEventMapper,
  queue: AsyncQueue<PortalEvent>,
  messageId: string,
  conversationId: number,
): Promise<void> {
  try {
    await piSession.prompt(prompt, { streamingBehavior: "steer" });
  } catch (err) {
    if (!mapper.hasError) {
      log.warn("pi.session.prompt_failed", {
        conversationId,
        err: err instanceof Error ? err.message : String(err),
      });
      queue.push({
        type: "error",
        code: "pi_send_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    for (const ev of mapper.closeReasoning()) queue.push(ev);
    if (!mapper.ended) queue.push({ type: "message.end", messageId });
    queue.end();
  }
}

// Portal permission bridge: a hidden inline extension intercepting pi tool
// calls before they execute. The resolver decides allow/block; `block` makes
// pi produce an immediate error tool result (never a thrown handler error,
// which would abort the turn).
function createPiPermissionBridge(
  onPermission: PiPermissionResolver,
): InlineExtension {
  return {
    name: "portal-permission-bridge",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", async (event) => {
        const decision = await onPermission(
          event.toolName,
          event.input as Record<string, unknown>,
          event.toolCallId,
        );
        return decision.allow
          ? undefined
          : { block: true, reason: decision.reason ?? "Permission denied." };
      });
    },
  };
}
