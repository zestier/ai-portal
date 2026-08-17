import { describe, expect, it } from "vitest";
import {
  CHAT_STREAM_STALL_TIMEOUT_MS,
  CHAT_INTERACTIVE_STALL_TIMEOUT_MS,
  EVENT_SOURCE_CLOSED,
  shouldResumeStream,
  streamIsLive,
  streamRefreshAction,
  streamStallDelayMs,
} from "../../src/lib/client/chat-stream-recovery";

describe("chat stream recovery", () => {
  it("uses a conservative stall timeout", () => {
    expect(CHAT_STREAM_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
  });

  it("finishes a local stream when refresh shows no active turn", () => {
    expect(
      streamRefreshAction({
        currentTurnId: "turn-1",
        refreshedActiveTurnId: null,
        hasEventSource: true,
      }),
    ).toBe("finish");
  });

  it("finishes a dangling local stream even when no active turn id is tracked", () => {
    expect(
      streamRefreshAction({
        currentTurnId: null,
        refreshedActiveTurnId: null,
        hasEventSource: true,
      }),
    ).toBe("finish");
  });

  it("finishes a tracked turn even when the local EventSource is already gone", () => {
    expect(
      streamRefreshAction({
        currentTurnId: "turn-1",
        refreshedActiveTurnId: null,
        hasEventSource: false,
      }),
    ).toBe("finish");
  });

  it("stays idle when there is no local stream and refresh shows no active turn", () => {
    expect(
      streamRefreshAction({
        currentTurnId: null,
        refreshedActiveTurnId: null,
        hasEventSource: false,
      }),
    ).toBe("stay-attached");
  });

  it("reattaches when refresh shows an active turn but no local stream", () => {
    expect(
      streamRefreshAction({
        currentTurnId: null,
        refreshedActiveTurnId: "turn-1",
        hasEventSource: false,
      }),
    ).toBe("reattach");
  });

  it("reattaches when an EventSource exists without a tracked turn id", () => {
    expect(
      streamRefreshAction({
        currentTurnId: null,
        refreshedActiveTurnId: "turn-1",
        hasEventSource: true,
      }),
    ).toBe("reattach");
  });

  it("reattaches when the local stream is missing for the same active turn", () => {
    expect(
      streamRefreshAction({
        currentTurnId: "turn-1",
        refreshedActiveTurnId: "turn-1",
        hasEventSource: false,
      }),
    ).toBe("reattach");
  });

  it("reattaches when the authoritative active turn changed", () => {
    expect(
      streamRefreshAction({
        currentTurnId: "turn-1",
        refreshedActiveTurnId: "turn-2",
        hasEventSource: true,
      }),
    ).toBe("reattach");
  });

  it("keeps an attached stream when refresh agrees it is still active", () => {
    expect(
      streamRefreshAction({
        currentTurnId: "turn-1",
        refreshedActiveTurnId: "turn-1",
        hasEventSource: true,
      }),
    ).toBe("stay-attached");
  });
});

describe("streamIsLive", () => {
  it("treats a null handle as dead", () => {
    expect(streamIsLive(null)).toBe(false);
  });

  it("treats a CLOSED socket as dead so recovery reattaches", () => {
    // Regression guard: a frozen tab can leave the socket CLOSED without
    // ever firing `onerror`. Reporting it as live made recovery choose
    // `stay-attached` and strand the user until a manual refresh.
    expect(streamIsLive({ readyState: EVENT_SOURCE_CLOSED })).toBe(false);
  });

  it("treats a CONNECTING socket as live (browser is auto-reconnecting)", () => {
    expect(streamIsLive({ readyState: 0 })).toBe(true);
  });

  it("treats an OPEN socket as live", () => {
    expect(streamIsLive({ readyState: 1 })).toBe(true);
  });
});

describe("streamStallDelayMs", () => {
  it("does not arm without a live EventSource", () => {
    expect(
      streamStallDelayMs({
        hasEventSource: false,
        activeTurnId: "turn-1",
        pendingInteractiveCount: 0,
      }),
    ).toBeNull();
  });

  it("does not arm without an active turn", () => {
    expect(
      streamStallDelayMs({
        hasEventSource: true,
        activeTurnId: null,
        pendingInteractiveCount: 0,
      }),
    ).toBeNull();
  });

  it("uses the normal stall timeout when no prompt is pending", () => {
    expect(
      streamStallDelayMs({
        hasEventSource: true,
        activeTurnId: "turn-1",
        pendingInteractiveCount: 0,
      }),
    ).toBe(CHAT_STREAM_STALL_TIMEOUT_MS);
  });

  it("arms a longer fuse (not a no-op) while a prompt is pending so a wedged interactive recovers", () => {
    expect(
      streamStallDelayMs({
        hasEventSource: true,
        activeTurnId: "turn-1",
        pendingInteractiveCount: 1,
      }),
    ).toBe(CHAT_INTERACTIVE_STALL_TIMEOUT_MS);
    expect(CHAT_INTERACTIVE_STALL_TIMEOUT_MS).toBeGreaterThan(
      CHAT_STREAM_STALL_TIMEOUT_MS,
    );
  });
});

describe("shouldResumeStream", () => {
  it("resumes when visible with an active turn (the screen-lock case)", () => {
    expect(
      shouldResumeStream({ documentHidden: false, activeTurnId: "turn-1" }),
    ).toBe(true);
  });

  it("does not resume while the page is still hidden/frozen", () => {
    expect(
      shouldResumeStream({ documentHidden: true, activeTurnId: "turn-1" }),
    ).toBe(false);
  });

  it("does not resume when there is no active turn to recover", () => {
    expect(
      shouldResumeStream({ documentHidden: false, activeTurnId: null }),
    ).toBe(false);
  });
});
