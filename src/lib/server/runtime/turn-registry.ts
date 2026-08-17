import {
  appGlobalSymbols,
  getOrCreateGlobalSingleton,
} from "../global-singleton";
import * as pool from "./pool";
import type { AsyncQueue } from "./async-queue";
import type { PortalEvent } from "$lib/types";

export interface IdentifiedEvent {
  id: number;
  event: PortalEvent;
}

export interface SubscribeOptions {
  signal?: AbortSignal;
  // If provided, replay only events strictly after this id. Used by SSE
  // reconnects to skip what the client already received.
  sinceId?: number;
  // Used by fresh page loads that already rendered the persisted in-flight
  // message state from the DB. They only need future live events; replaying
  // buffered deltas would duplicate the already-rendered assistant content.
  skipReplay?: boolean;
}

export interface Turn {
  id: string;
  conversationId: number;
  startedAt: number;
  endedAt: number | null;
  status: "running" | "complete" | "interrupted" | "error";
  subscribe(opts?: SubscribeOptions): AsyncIterable<IdentifiedEvent>;
  abort(): Promise<void>;
}

export interface InternalTurn extends Turn {
  eventLog: PortalEvent[];
  subscribers: Set<AsyncQueue<IdentifiedEvent>>;
  finishedPromise: Promise<void>;
}

// The turn registry is stashed on globalThis so that Vite HMR re-importing
// this module in dev does NOT wipe out the in-flight turns. Without this,
// a code edit during a turn would orphan the running turn in the old module
// closure: the new module's empty map would make `getTurn` return null, the
// client's resume-on-reload would get 204, and the UI would appear "stuck"
// with no assistant response while the orphaned turn quietly persisted to
// the DB minutes later. Same rationale as keeping the DB handle pinned.
const TURNS_KEYS = appGlobalSymbols("turns");
type TurnRegistry = Map<number, InternalTurn>;
const turns: TurnRegistry = getOrCreateGlobalSingleton(
  TURNS_KEYS,
  () => new Map(),
);

// Tell the session pool that a conversation with a running turn is alive, so
// the idle reaper / capacity eviction don't dispose its SDK session mid-turn
// (e.g. while a long tool stream runs or while it's parked on a prompt — the
// pool also checks pending prompts directly). Registered by stable id so an
// HMR re-import replaces rather than duplicates the predicate. The optional
// call keeps partially-mocked `pool` modules (some unit tests) working.
pool.registerKeepAlive?.("turns.active", (conversationId) => {
  return turns.get(conversationId)?.status === "running";
});

// Synchronous reservations that bridge the gap between a caller's "is a turn
// running?" guard and the moment `startTurn` actually registers the turn.
//
// In memory mode `startTurnFromUserMessage` does `await pool.release(...)`
// BEFORE calling `startTurn`, so the turn is not registered until after an
// await. Two concurrent POSTs could both pass a `getTurn` guard, both persist a
// user message, then race into `startTurn` — the loser threw a bare Error
// (surfaced as a 500) and left an orphaned user message with no turn. A caller
// takes a reservation synchronously (no intervening await) before doing any
// async setup; the reservation occupies the slot so a concurrent caller is
// rejected immediately and deterministically. Stashed on globalThis for the
// same HMR-survival reason as the turn registry.
const RESERVATIONS_KEYS = appGlobalSymbols("turn-reservations");
const reservations: Set<number> = getOrCreateGlobalSingleton(
  RESERVATIONS_KEYS,
  () => new Set<number>(),
);

// Thrown when a turn is already running or reserved for a conversation. Typed
// so HTTP handlers can map it to a 409 (Conflict) instead of leaking a bare 500.
export class TurnAlreadyInProgressError extends Error {
  readonly conversationId: number;
  constructor(conversationId: number) {
    super("turn already in progress for this conversation");
    this.name = "TurnAlreadyInProgressError";
    this.conversationId = conversationId;
  }
}

// True when a turn is actively running OR a synchronous reservation is held for
// the conversation. A finished-but-still-cached turn (grace window) does not
// count as active.
function isTurnActiveOrReserved(conversationId: number): boolean {
  return (
    turns.get(conversationId)?.status === "running" ||
    reservations.has(conversationId)
  );
}

// Synchronously claim the turn slot for a conversation. MUST be called with no
// intervening await between the caller's decision to start a turn and any
// async setup that precedes `startTurn`. Throws `TurnAlreadyInProgressError` if
// a turn is already running or reserved. Pair every successful call with
// `releaseTurnReservation` in a `finally`.
export function reserveTurn(conversationId: number): void {
  if (isTurnActiveOrReserved(conversationId)) {
    throw new TurnAlreadyInProgressError(conversationId);
  }
  reservations.add(conversationId);
}

// Release a reservation taken by `reserveTurn`. Safe to call even if no
// reservation is held (idempotent), so it can live in a `finally`.
export function releaseTurnReservation(conversationId: number): void {
  reservations.delete(conversationId);
}

// How long a finished turn lingers in the registry so that a slightly-late
// subscriber (e.g., a page that reloaded just as the turn completed) can
// still replay the full event log instead of missing it.
export const FINISHED_GRACE_MS = 60_000;

export function registerTurn(conversationId: number, turn: InternalTurn): void {
  turns.set(conversationId, turn);
}

export function deleteTurn(conversationId: number): void {
  turns.delete(conversationId);
}

export function getTurn(conversationId: number): Turn | null {
  return turns.get(conversationId) ?? null;
}

/**
 * Conversation ids with a turn actively running — the "agent is working" half
 * of the sidebar's active indicator. Excludes finished-but-still-cached turns
 * (the {@link FINISHED_GRACE_MS} window) and synchronous reservations, which
 * are an internal concurrency detail rather than an observable running turn.
 *
 * SINGLE-INSTANCE, like every other consumer of this registry.
 */
export function runningConversationIds(): Set<number> {
  const out = new Set<number>();
  for (const [conversationId, turn] of turns) {
    if (turn.status === "running") out.add(conversationId);
  }
  return out;
}

// Look up a turn by its own id (the ulid in `turn.id`), scoped to a
// conversation. Used by the streaming endpoint, which keys URLs by
// `turnId` so reconnects always land on the same logical stream even
// if a new turn replaced the registry slot.
export function getTurnById(
  conversationId: number,
  turnId: string,
): Turn | null {
  const t = turns.get(conversationId);
  return t && t.id === turnId ? t : null;
}
