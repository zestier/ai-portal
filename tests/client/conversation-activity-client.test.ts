import { describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  clearConversationActivityOverrides,
  clearConversationUnread,
  conversationActivityOverrides,
  resolveConversationActivity,
  setConversationActivity,
} from "../../src/lib/client/conversation-activity";
import { conversationId } from "../../src/lib/ids";

const C1 = conversationId.encode(1);
const C2 = conversationId.encode(2);
const C3 = conversationId.encode(3);
const C4 = conversationId.encode(4);
const NONE = new Set<string>();

describe("resolveConversationActivity", () => {
  it("falls back to the server load sets when there is no override", () => {
    expect(
      resolveConversationActivity(C1, new Set([C1]), new Set([C1]), {}),
    ).toEqual({
      running: true,
      unread: true,
    });
    expect(
      resolveConversationActivity(C2, new Set([C1]), new Set([C1]), {}),
    ).toEqual({
      running: false,
      unread: false,
    });
  });

  it("lets a live override win over the server sets", () => {
    // The feed is fresher than the last `load`, so a finished turn must be
    // able to clear a `running` the server set still reports.
    const overrides = { [C1]: { running: false, unread: true } };
    expect(
      resolveConversationActivity(C1, new Set([C1]), NONE, overrides),
    ).toEqual({
      running: false,
      unread: true,
    });
  });

  it("scopes overrides to their own conversation", () => {
    const overrides = { [C1]: { running: true, unread: false } };
    expect(
      resolveConversationActivity(C2, NONE, new Set([C2]), overrides),
    ).toEqual({
      running: false,
      unread: true,
    });
  });
});

describe("conversationActivityOverrides", () => {
  it("keeps the same object identity when nothing changed", () => {
    setConversationActivity(C1, { running: true, unread: false });
    const first = get(conversationActivityOverrides);
    setConversationActivity(C1, { running: true, unread: false });
    // Identity stability matters: the sidebar re-derives every row from this
    // store, and an SSE reconnect replays events verbatim.
    expect(get(conversationActivityOverrides)).toBe(first);

    setConversationActivity(C1, { running: false, unread: true });
    expect(get(conversationActivityOverrides)).not.toBe(first);
  });

  it("clears unread without disturbing running", () => {
    setConversationActivity(C2, { running: true, unread: true });
    clearConversationUnread(C2);
    expect(get(conversationActivityOverrides)[C2]).toEqual({
      running: true,
      unread: false,
    });
  });

  it("records a read for a conversation it has never seen an event for", () => {
    clearConversationUnread(C3);
    expect(get(conversationActivityOverrides)[C3]).toEqual({
      running: false,
      unread: false,
    });
  });

  it("drops every override so the server load can win again", () => {
    setConversationActivity(C4, { running: true, unread: true });
    clearConversationActivityOverrides();
    expect(get(conversationActivityOverrides)).toEqual({});
    // With no override left, resolution falls back to the server sets.
    expect(
      resolveConversationActivity(
        C4,
        NONE,
        new Set([C4]),
        get(conversationActivityOverrides),
      ),
    ).toEqual({ running: false, unread: true });
  });
});
