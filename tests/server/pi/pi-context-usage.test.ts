import { describe, it, expect } from "vitest";
import { piContextUsageToEvent } from "../../../src/lib/server/pi/context-usage";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";

describe("piContextUsageToEvent", () => {
  it("maps a normal snapshot to a context.usage event", () => {
    const usage: ContextUsage = {
      tokens: 2000,
      contextWindow: 200_000,
      percent: 1,
    };
    expect(piContextUsageToEvent(usage)).toEqual({
      type: "context.usage",
      currentTokens: 2000,
      tokenLimit: 200_000,
      percentage: 1,
    });
  });

  it("returns null when tokens are unknown (right after compaction)", () => {
    expect(
      piContextUsageToEvent({
        tokens: null,
        contextWindow: 200_000,
        percent: null,
      }),
    ).toBeNull();
  });

  it("returns null when contextWindow is not positive", () => {
    expect(
      piContextUsageToEvent({ tokens: 100, contextWindow: 0, percent: null }),
    ).toBeNull();
  });

  it("omits percentage when percent is null so the client computes it", () => {
    const event = piContextUsageToEvent({
      tokens: 2000,
      contextWindow: 200_000,
      percent: null,
    });
    expect(event).toEqual({
      type: "context.usage",
      currentTokens: 2000,
      tokenLimit: 200_000,
    });
    expect("percentage" in event!).toBe(false);
  });
});
