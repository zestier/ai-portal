// Pool of long-lived per-conversation sessions with idle reaping.

import { loadConfig } from "../config";
import {
  appGlobalSymbols,
  clearGlobalSingletonValues,
  getGlobalSingletonValue,
  getOrCreateGlobalSingleton,
  setGlobalSingletonValue,
} from "../global-singleton";
import { hasPending, expireConversation } from "./interactive-requests";
import { log } from "../log";
import { openPiSession } from "../pi";
import * as portalExtensions from "../extensions";
import type {
  ProviderOpenOptions,
  ProviderSession,
} from "../pi/session-contract";

interface Entry {
  session: ProviderSession;
  lastUsed: number;
}

// Stash on globalThis so Vite HMR re-imports of this module in dev don't
// orphan the live SDK sessions in the old module's closure. See the
// matching comment in turn-runner.ts.
const SESSIONS_KEYS = appGlobalSymbols("pool.sessions");
const REAPER_KEYS = appGlobalSymbols("pool.reaper");
type SessionsMap = Map<number, Entry>;
type InflightMap = Map<number, Promise<ProviderSession>>;
const sessions: SessionsMap = getOrCreateGlobalSingleton(
  SESSIONS_KEYS,
  () => new Map<number, Entry>(),
);
// In-flight `open()` promises, keyed by conversationId. Concurrent
// acquire() calls for the same conversation share one open(), avoiding
// the TOCTOU between `sessions.get` and `sessions.set` that would
// otherwise leak a second SDK subprocess.
const INFLIGHT_KEYS = appGlobalSymbols("pool.inflight");
const inflight: InflightMap = getOrCreateGlobalSingleton(
  INFLIGHT_KEYS,
  () => new Map<number, Promise<ProviderSession>>(),
);
function getReaperTimer(): NodeJS.Timeout | null {
  return getGlobalSingletonValue<NodeJS.Timeout>(REAPER_KEYS);
}
function setReaperTimer(t: NodeJS.Timeout | null) {
  setGlobalSingletonValue(REAPER_KEYS, t);
}

// Keep-alive predicates: external signals that a conversation's session has
// work outstanding and must not be silently disposed by the idle reaper or
// capacity eviction. `interactive-requests` is consulted directly (see
// `isProtected`); the turn registry registers itself here to avoid an import
// cycle (turn-runner already imports this module). Keyed by a stable id so a
// Vite HMR re-import re-registering its predicate replaces rather than
// duplicates the entry. Stashed on globalThis for the same HMR reason as the
// session map.
type KeepAlivePredicate = (conversationId: number) => boolean;
const KEEPALIVE_KEYS = appGlobalSymbols("pool.keepAlive");
const keepAlive: Map<string, KeepAlivePredicate> = getOrCreateGlobalSingleton(
  KEEPALIVE_KEYS,
  () => new Map<string, KeepAlivePredicate>(),
);

export function registerKeepAlive(id: string, fn: KeepAlivePredicate) {
  keepAlive.set(id, fn);
}

/**
 * True if the conversation's session has work outstanding (an open interactive
 * prompt or an active turn) and therefore must not be reaped/evicted silently.
 */
function isProtected(conversationId: number): boolean {
  if (hasPending(conversationId)) return true;
  for (const fn of keepAlive.values()) {
    try {
      if (fn(conversationId)) return true;
    } catch (err) {
      log.warn("pi.pool.keepalive_predicate_failed", {
        conversationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return false;
}

/**
 * True when a keep-alive predicate reports the conversation busy — i.e. the
 * session is mid-stream on an active turn (the turn registry registers
 * `turns.active` here). Distinct from `isProtected`, which also counts parked
 * interactive prompts: a prompt-parked session CAN be evicted safely by
 * expiring the prompt (a default denial unblocks the agent), whereas
 * disposing a session out from under an active turn ends its stream silently
 * and the turn-runner finalizes the turn as a false empty/partial `complete`.
 */
function isTurnBusy(conversationId: number): boolean {
  for (const fn of keepAlive.values()) {
    try {
      if (fn(conversationId)) return true;
    } catch (err) {
      log.warn("pi.pool.keepalive_predicate_failed", {
        conversationId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return false;
}

async function disposeSession(
  session: ProviderSession,
  context: { conversationId: number; reason: string },
): Promise<void> {
  try {
    await session.dispose();
  } catch (err) {
    log.warn("pi.pool.dispose_failed", {
      ...context,
      provider: session.provider,
      err: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  }
}

export async function acquire(
  opts: ProviderOpenOptions,
): Promise<ProviderSession> {
  // Coalesce concurrent acquires for the same conversation. Checked
  // before the `existing` branch (and before any `await`) so two racing
  // acquires for the same conversation — including a pair that both see a
  // session mismatch — can't both dispose the cached session and both
  // open a fresh one. Without this, the loser's session is orphaned (its
  // subprocess stays alive but nothing references it).
  const pending = inflight.get(opts.conversationId);
  if (pending) return pending;

  const requestedProvider = opts.provider ?? "pi";
  // Compare session ids in their string forms. `openPiSession` stores
  // `providerSessionId = String(conversationId)` ("7"), while the fallback
  // here is the numeric `conversationId` (7); a strict `===` on the raw
  // values would mismatch and force a pointless session recreate on every
  // follow-up turn. Normalizing both sides keeps the string/number forms of
  // the same conversation id equal.
  const requestedProviderSessionId = String(
    opts.providerSessionId ?? opts.conversationId,
  );

  // Sessions to tear down once the new open is in flight. Map mutations
  // (claiming the stale entry / eviction victim) happen synchronously
  // below so a concurrent acquire can never observe — and re-dispose —
  // something we've already claimed; the awaited disconnect runs inside
  // the coalesced open promise.
  const toDispose: Array<{
    session: ProviderSession;
    context: { conversationId: number; reason: string };
  }> = [];

  // Fingerprint the user's operator-managed extension set once per acquire:
  // the cached session is reused only when the extensions it was opened with
  // match the current set, so a Settings → Extensions change takes effect on
  // the next turn (this acquire) without a restart — the stale session is
  // disposed below and a fresh one opened.
  const extensionFingerprint = await portalExtensions.fingerprint(opts.userId);
  // Re-coalesce after the await: a racing acquire may have set the in-flight
  // entry while this one was fingerprinting, so a concurrent pair can never
  // both pass the session check below and open two sessions for one
  // conversation. Everything from here to `inflight.set` is synchronous.
  const coalesced = inflight.get(opts.conversationId);
  if (coalesced) return coalesced;

  const existing = sessions.get(opts.conversationId);
  if (existing) {
    const cachedProvider = existing.session.provider ?? "pi";
    const cachedProviderSessionId = String(
      existing.session.providerSessionId ?? existing.session.conversationId,
    );
    if (
      existing.session.workingDirectory === opts.workingDirectory &&
      existing.session.model === opts.model &&
      (existing.session.agentArchitecture ?? "standard") ===
        (opts.agentArchitecture ?? "standard") &&
      (existing.session.semanticWorkerModel ?? null) ===
        (opts.semanticWorkerModel ?? null) &&
      cachedProviderSessionId === requestedProviderSessionId &&
      cachedProvider === requestedProvider &&
      existing.session.extensionFingerprint === extensionFingerprint
    ) {
      existing.lastUsed = Date.now();
      return existing.session;
    }
    log.warn("pi.pool.session_mismatch_recreate", {
      conversationId: opts.conversationId,
      cachedProvider,
      requestedProvider,
      cachedWorkdir: existing.session.workingDirectory,
      requestedWorkdir: opts.workingDirectory,
      cachedModel: existing.session.model,
      requestedModel: opts.model,
      cachedProviderSessionId,
      requestedProviderSessionId,
      cachedExtensionFingerprint: existing.session.extensionFingerprint ?? null,
      requestedExtensionFingerprint: extensionFingerprint,
    });
    // Claim the stale entry synchronously, then dispose it inside the
    // coalesced open below.
    sessions.delete(opts.conversationId);
    toDispose.push({
      session: existing.session,
      context: {
        conversationId: opts.conversationId,
        reason: "session_mismatch",
      },
    });
  }

  const cfg = loadConfig();
  // Count in-flight opens alongside live sessions: each pending open will
  // become a live session, so ignoring them lets N concurrent opens for N
  // new conversations all pass the guard and blow past the cap.
  if (sessions.size + inflight.size >= cfg.MAX_CONCURRENT_SESSIONS) {
    // Evict to make room. Prefer the oldest session with NO work
    // outstanding so we never strand an open prompt / active turn.
    // Under capacity pressure a session parked on an interactive prompt
    // is still evictable — expiring its pending prompts with a distinct
    // "session expired — re-issue" outcome unblocks the parked agent
    // instead of hanging it on a deferred whose executor we disposed.
    // A session with an ACTIVE TURN is never disposed out from under its
    // stream: that ends the send queue and the turn-runner finalizes the
    // turn as a silent (empty/partial) `complete` — the "disappeared
    // reply" bug. If every live session is mid-turn, defer the eviction:
    // turns are transient, so the cap overrun is bounded and the next
    // acquire can evict.
    const sorted = [...sessions.entries()].sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    );
    const unprotected = sorted.find(([cid]) => !isProtected(cid));
    const promptParked = unprotected
      ? null
      : sorted.find(([cid]) => isProtected(cid) && !isTurnBusy(cid));
    const picked = unprotected ?? promptParked;
    // `picked` can be undefined when every slot is consumed by in-flight
    // opens (nothing live left to evict), or every live session has an
    // active turn; there's nothing safe to dispose, so let this open
    // proceed (the overrun is bounded by turn duration).
    if (picked) {
      const [oldestId, oldest] = picked;
      // Claim the victim synchronously so a concurrent eviction can't
      // pick the same oldest session and double-dispose it.
      sessions.delete(oldestId);
      if (promptParked) {
        log.warn("pi.pool.evict_forced", { conversationId: oldestId });
        // Settle the parked deferreds BEFORE disposing so the resolved
        // event lands and the SDK callback's promise can't leak.
        expireConversation(oldestId, "capacity_evict");
      } else {
        log.info("pi.pool.evict", { conversationId: oldestId });
      }
      toDispose.push({
        session: oldest.session,
        context: {
          conversationId: oldestId,
          reason: promptParked ? "capacity_evict_forced" : "capacity_evict",
        },
      });
    } else if (sorted.length > 0) {
      log.warn("pi.pool.evict_deferred_active_turn", {
        conversationId: sorted[0][0],
        live: sorted.length,
      });
    }
  }

  const openPromise = (async () => {
    try {
      // Disconnect the claimed sessions before opening, preserving the
      // original ordering (stale session first, then eviction victim).
      for (const { session, context } of toDispose) {
        await disposeSession(session, context);
      }
      const session = await openPiSession(opts);
      sessions.set(opts.conversationId, { session, lastUsed: Date.now() });
      return session;
    } finally {
      inflight.delete(opts.conversationId);
    }
  })();
  inflight.set(opts.conversationId, openPromise);
  return openPromise;
}

/**
 * Return the live session for a conversation iff one is currently cached.
 * Used by the /session PATCH endpoint to push mode/approve-all changes to a
 * running SDK session without spinning a fresh one (which would require
 * an auth token, working directory, etc. the endpoint doesn't have at hand).
 */
export function getActive(conversationId: number): ProviderSession | null {
  return sessions.get(conversationId)?.session ?? null;
}

export function touch(conversationId: number) {
  const e = sessions.get(conversationId);
  if (e) e.lastUsed = Date.now();
}

export async function release(conversationId: number) {
  const e = sessions.get(conversationId);
  if (!e) return;
  // D4: never dispose a session with work outstanding (an active turn
  // streaming on it, or a parked interactive prompt). Disposing it now would
  // end the send queue mid-turn and the turn-runner would finalize the turn
  // as a silent (empty/partial) `complete` — the "disappeared reply" bug.
  // Leave it pooled; the idle reaper (or a later release) disposes it once
  // the work settles. Idle releases (the documented DELETE/archive flow,
  // memory-mode session rebuilds) are unaffected — `isProtected` is false.
  if (isProtected(conversationId)) {
    log.info("pi.pool.release_skip_busy", { conversationId });
    return;
  }
  sessions.delete(conversationId);
  await disposeSession(e.session, { conversationId, reason: "release" });
}

export function startIdleReaper() {
  if (getReaperTimer()) return;
  const cfg = loadConfig();
  const idleMs = cfg.IDLE_TIMEOUT_MIN * 60_000;
  const timer = setInterval(async () => {
    const now = Date.now();
    // Iterates the live map and awaits dispose inline, so if a dispose
    // outlasts the 60s interval a second tick can overlap. That's safe:
    // each entry is `sessions.delete`d synchronously before its await, so
    // neither tick can re-dispose a claimed entry, and entries added mid-
    // iteration are visited per the Map spec (never skipped). Worst case is
    // a few concurrent dispose() calls — exactly what shutdown() does on
    // purpose — so a snapshot/re-entrancy guard would add state for no gain.
    for (const [id, entry] of sessions) {
      if (now - entry.lastUsed > idleMs) {
        // Never reap a session with work outstanding (an open prompt
        // or an active turn). A forgotten prompt pins its session
        // indefinitely — an accepted trade-off, mirroring the
        // deliberate DEFAULT_TIMEOUT_MS=0 ("a leak is better than a
        // silent deny"). Capacity pressure still has an escape hatch
        // via the forced eviction in `acquire`.
        if (isProtected(id)) {
          log.info("pi.pool.reap_skip_busy", { conversationId: id });
          continue;
        }
        log.info("pi.pool.reap", { conversationId: id });
        sessions.delete(id);
        await disposeSession(entry.session, {
          conversationId: id,
          reason: "idle_reap",
        });
      }
    }
  }, 60_000);
  timer.unref?.();
  setReaperTimer(timer);
}

/** Snapshot of session-pool counters for observability. */
export function getPoolStats(): {
  active: number;
  inflight: number;
  max: number;
} {
  const cfg = loadConfig();
  return {
    active: sessions.size,
    inflight: inflight.size,
    max: cfg.MAX_CONCURRENT_SESSIONS,
  };
}

export async function shutdown() {
  const timer = getReaperTimer();
  if (timer) {
    clearInterval(timer);
    clearGlobalSingletonValues(REAPER_KEYS);
  }
  // Wait for any in-flight open() calls to settle (then dispose them
  // like any other live session) so shutdown doesn't race a half-built
  // session into a zombie subprocess.
  const pending = [...inflight.values()];
  inflight.clear();
  const built = await Promise.allSettled(pending);
  for (const r of built) {
    if (r.status === "fulfilled") {
      await disposeSession(r.value, {
        conversationId: r.value.conversationId,
        reason: "shutdown_inflight",
      });
    }
  }
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(
    all.map((e) =>
      disposeSession(e.session, {
        conversationId: e.session.conversationId,
        reason: "shutdown",
      }),
    ),
  );
}
