// Pure decision logic for resetting `Chat.svelte`'s per-conversation local
// state.
//
// The chat component seeds a pile of local `$state` (message list, usage,
// composer draft, interactive queue, scroll pin, stream reattach) from its
// server-`load` props. When the user switches to a *different* conversation
// those locals must be re-seeded from the new conversation's props.
//
// The trap: the conversation page passes a fresh `data.conversation` object on
// every `invalidateAll()` / `load` re-run (e.g. the tickets UI refreshing),
// even when the user never left the conversation. Keying the reset on the prop
// *object identity* therefore re-fires on routine background refreshes and
// clobbers user state — most painfully a half-typed, unsent composer draft.
//
// The fix is to key the reset on the conversation `id` *value*. This module
// captures that decision so it can be unit tested without a DOM; `Chat.svelte`
// translates the result into the actual state writes.
//
// Capturing both halves of the decision — "did the id change?" and "remember
// the id we just seeded from" — in one tested unit means the component can't
// reintroduce the bug by reading the id but forgetting to record it.

export interface ConversationResetGate {
  // Returns true (and records `nextId`) only when `nextId` differs from the
  // last id this gate seeded from — i.e. a genuine conversation switch or the
  // very first mount. A repeat of the same id (a background refresh handing a
  // new prop object) returns false, so local state such as an in-progress
  // composer draft survives untouched.
  shouldReset(nextId: string): boolean;
}

export function createConversationResetGate(): ConversationResetGate {
  let lastId: string | undefined = undefined;
  return {
    shouldReset(nextId: string): boolean {
      if (lastId === nextId) return false;
      lastId = nextId;
      return true;
    },
  };
}
