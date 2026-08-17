import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../../../src/lib/server/runtime/async-queue";

describe("AsyncQueue", () => {
  it("yields values in order then ends", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.end();
    const seen: number[] = [];
    for await (const v of q) seen.push(v);
    expect(seen).toEqual([1, 2]);
  });

  it("supports a waiting consumer", async () => {
    const q = new AsyncQueue<number>();
    const seen: number[] = [];
    const consumer = (async () => {
      for await (const v of q) seen.push(v);
    })();
    // Yield once so the consumer parks on the empty queue.
    await Promise.resolve();
    q.push(7);
    q.push(8);
    q.end();
    await consumer;
    expect(seen).toEqual([7, 8]);
  });

  it("propagates errors", async () => {
    const q = new AsyncQueue<number>();
    q.fail(new Error("boom"));
    await expect(async () => {
      for await (const _ of q) void _;
    }).rejects.toThrow("boom");
  });
});
