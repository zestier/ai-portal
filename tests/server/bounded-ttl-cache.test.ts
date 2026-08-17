import { describe, expect, it } from "vitest";
import { BoundedTtlCache } from "../../src/lib/server/cache";

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("BoundedTtlCache", () => {
  it("returns cached values within the TTL", () => {
    const time = clock();
    const cache = new BoundedTtlCache<string, number>({
      ttlMs: 100,
      maxEntries: 10,
      now: time.now,
    });
    cache.set("a", 1);
    time.advance(99);
    expect(cache.get("a")).toBe(1);
  });

  it("deletes expired entries on read so the map does not grow unbounded", () => {
    const time = clock();
    const cache = new BoundedTtlCache<string, number>({
      ttlMs: 100,
      maxEntries: 10,
      now: time.now,
    });
    cache.set("a", 1);
    time.advance(100);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least-recently-used entry when over the cap", () => {
    const time = clock();
    const cache = new BoundedTtlCache<string, number>({
      ttlMs: 1_000,
      maxEntries: 3,
      now: time.now,
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    // Touch 'a' so 'b' becomes the least-recently-used.
    expect(cache.get("a")).toBe(1);
    cache.set("d", 4);

    expect(cache.size).toBe(3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.get("d")).toBe(4);
  });

  it("caps growth even when many distinct keys are inserted", () => {
    const cache = new BoundedTtlCache<number, number>({
      ttlMs: 1_000,
      maxEntries: 1000,
    });
    for (let i = 0; i < 5000; i++) cache.set(i, i);
    expect(cache.size).toBe(1000);
    // Oldest keys evicted, newest retained.
    expect(cache.get(0)).toBeUndefined();
    expect(cache.get(4999)).toBe(4999);
  });

  it("does not reset the TTL clock when refreshing LRU recency on read", () => {
    const time = clock();
    const cache = new BoundedTtlCache<string, number>({
      ttlMs: 100,
      maxEntries: 10,
      now: time.now,
    });
    cache.set("a", 1);
    time.advance(60);
    expect(cache.get("a")).toBe(1);
    time.advance(60);
    expect(cache.get("a")).toBeUndefined();
  });

  it("refreshes the TTL on set", () => {
    const time = clock();
    const cache = new BoundedTtlCache<string, number>({
      ttlMs: 100,
      maxEntries: 10,
      now: time.now,
    });
    cache.set("a", 1);
    time.advance(60);
    cache.set("a", 2);
    time.advance(60);
    expect(cache.get("a")).toBe(2);
  });

  it("supports delete and clear", () => {
    const cache = new BoundedTtlCache<string, number>({
      ttlMs: 1_000,
      maxEntries: 10,
    });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("rejects a non-positive cap", () => {
    expect(
      () => new BoundedTtlCache<string, number>({ ttlMs: 1, maxEntries: 0 }),
    ).toThrow();
  });
});
