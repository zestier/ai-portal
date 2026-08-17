// In-process notifier for ticket mutations.
//
// A deliberately tiny pub-sub on its own channel, separate from the app-event /
// user-feed bus (`runtime/app-events.ts`). The ticket repo emits here on every
// mutation; an upstream bridge (`runtime/ticket-events.ts`) is the *single*
// place that translates these into `AppEvent`s on the per-user feed. Keeping the
// repo free of any app-event import avoids a layering cycle (db → runtime) — the
// repo only announces "a ticket changed for this user" and knows nothing about
// who, if anyone, is listening.
//
// SINGLE-INSTANCE ONLY, same caveat as the app-event bus it ultimately feeds:
// emitters and subscribers live in one process. The notifier is stashed on
// `globalThis` so a Vite SSR HMR re-import doesn't orphan the live bridge
// subscription in the old module's closure.

import { EventEmitter } from "node:events";
import {
  appGlobalSymbols,
  getOrCreateGlobalSingleton,
} from "../global-singleton";

/**
 * Announced when a ticket changes. `userId` is always present (every repo
 * mutation is user-scoped); `workspaceKey`/`ticketId` are included when cheaply
 * available so a future consumer can filter without a re-query. Today the bridge
 * only needs `userId`.
 */
export interface TicketMutation {
  userId: number;
  workspaceKey?: string | undefined;
  ticketId?: number | undefined;
}

export type TicketMutationListener = (mutation: TicketMutation) => void;

const EVENT = "ticket.mutated";

const TICKET_MUTATIONS_KEYS = appGlobalSymbols("db.ticket-mutations");

function getEmitter(): EventEmitter {
  return getOrCreateGlobalSingleton(TICKET_MUTATIONS_KEYS, () => {
    const emitter = new EventEmitter();
    // The bridge plus any tests can each attach a listener; the default cap of
    // 10 is plenty but the warning is noise here, so lift it.
    emitter.setMaxListeners(0);
    return emitter;
  });
}

/**
 * Announce a ticket mutation to in-process subscribers. Never throws: a notifier
 * hiccup must not break the repo mutation that triggered it (the sidebar still
 * reconciles from the next layout `load`).
 */
export function notifyTicketMutation(mutation: TicketMutation): void {
  try {
    getEmitter().emit(EVENT, mutation);
  } catch {
    /* non-fatal */
  }
}

/** Subscribe to ticket mutations. Returns an unsubscribe function. */
export function onTicketMutation(listener: TicketMutationListener): () => void {
  const emitter = getEmitter();
  emitter.on(EVENT, listener);
  return () => {
    emitter.off(EVENT, listener);
  };
}
