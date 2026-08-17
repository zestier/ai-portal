// Bridge: ticket-mutation notifier → per-user app-event feed.
//
// This is the *single* integration point between the db-layer ticket notifier
// (`db/ticket-mutations.ts`) and the cross-conversation app-event bus
// (`app-events.ts`). The repo announces "a ticket changed for this user" on its
// own decoupled channel; here we translate that into a `tickets.changed`
// `AppEvent` so every tab the user has open re-fetches the sidebar ticket list.
//
// Wired once at boot (`hooks.server.ts`). Idempotent: the subscription is
// tracked on `globalThis` so an HMR re-import or a duplicate boot doesn't stack
// multiple bridges (which would publish the same event N times).

import { onTicketMutation } from "../db/ticket-mutations";
import { publishAppEvent } from "./app-events";
import {
  appGlobalSymbols,
  getGlobalSingletonValue,
  setGlobalSingletonValue,
} from "../global-singleton";

const TICKET_BRIDGE_KEYS = appGlobalSymbols("runtime.ticket-event-bridge");

/**
 * Subscribe the app-event feed to ticket mutations. Safe to call repeatedly:
 * the first call installs the bridge and stashes its unsubscribe handle on
 * `globalThis`; later calls are no-ops until the existing bridge is torn down.
 */
export function startTicketEventBridge(): void {
  if (getGlobalSingletonValue<() => void>(TICKET_BRIDGE_KEYS)) return;

  const unsubscribe = onTicketMutation(({ userId }) => {
    // Non-fatal: a feed hiccup must never propagate back into the repo
    // mutation that triggered this. The sidebar still reconciles on the next
    // layout `load`.
    try {
      publishAppEvent(userId, { type: "tickets.changed" });
    } catch {
      /* non-fatal */
    }
  });

  setGlobalSingletonValue(TICKET_BRIDGE_KEYS, unsubscribe);
}
