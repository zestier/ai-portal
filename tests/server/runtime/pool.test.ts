import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupLocalEnv } from "../../helpers/env";

const openMock = vi.fn();
const fingerprintMock = vi.fn();

vi.mock("../../../src/lib/server/pi", () => ({
  openPiSession: (...args: unknown[]) => openMock(...args),
}));

vi.mock("../../../src/lib/server/extensions", () => ({
  fingerprint: (...args: unknown[]) => fingerprintMock(...args),
}));

async function importPool() {
  vi.resetModules();
  return await import("../../../src/lib/server/runtime/pool");
}

describe("session pool", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-pool-test-");
    openMock.mockReset();
    // Default: the pool fingerprints the extension set on every acquire; a
    // mock session carries no fingerprint (undefined), so undefined matches
    // the undefined fingerprint and reuse proceeds exactly as before.
    fingerprintMock.mockReset();
    fingerprintMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    const pool = await importPool();
    await pool.shutdown();
  });

  it("reuses a live session when the requested workdir matches", async () => {
    const session = {
      conversationId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApproveAll: vi.fn(),
      resetSessionApprovals: vi.fn(),
    };
    openMock.mockResolvedValue(session);
    const pool = await importPool();

    const first = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    const second = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    expect(first).toBe(second);
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("reuses a session whose providerSessionId is the string form of the conversation id", async () => {
    // Regression: `openPiSession` stores `providerSessionId = String(conversationId)`
    // ("7"), while a follow-up acquire computes the requested id from the numeric
    // `conversationId` (7). A strict `===` on the raw values mismatched, so the
    // pool disposed the live session and recreated it on EVERY turn after the
    // first. The comparison must treat "7" and 7 as the same session.
    const session = {
      conversationId: 7,
      providerSessionId: "7",
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApproveAll: vi.fn(),
      resetSessionApprovals: vi.fn(),
    };
    openMock.mockResolvedValue(session);
    const pool = await importPool();

    const first = await pool.acquire({
      conversationId: 7,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    const second = await pool.acquire({
      conversationId: 7,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    expect(first).toBe(second);
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it("recreates a live session when the requested workdir changes", async () => {
    const firstSession = {
      conversationId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApproveAll: vi.fn(),
      resetSessionApprovals: vi.fn(),
    };
    const secondSession = {
      ...firstSession,
      workingDirectory: "/tmp/work-b",
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    openMock
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const pool = await importPool();

    const first = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    const second = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-b",
      model: "gpt-4",
      policy: "prompt",
    });

    expect(first).not.toBe(second);
    expect(firstSession.dispose).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledTimes(2);
    expect(second.workingDirectory).toBe("/tmp/work-b");
  });

  it("recreates a live session when the requested provider label differs", async () => {
    // The pool is pi-only now: a session without an explicit provider is
    // treated as `pi`, so a later acquire for a different label is a
    // mismatch and the old session is torn down.
    const piSession = {
      conversationId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApprovalMode: vi.fn(),
      resetSessionApprovals: vi.fn(),
    };
    const labeledSession = {
      ...piSession,
      provider: "openai-compatible" as const,
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    openMock
      .mockResolvedValueOnce(piSession)
      .mockResolvedValueOnce(labeledSession);
    const pool = await importPool();

    const first = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    const second = await pool.acquire({
      provider: "openai-compatible",
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    expect(first).not.toBe(second);
    expect(piSession.dispose).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledTimes(2);
    expect(second.provider).toBe("openai-compatible");
  });

  it("coalesces concurrent acquires for the same conversation into one open()", async () => {
    const session = {
      conversationId: 1,
      workingDirectory: "/tmp/work-a",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApproveAll: vi.fn(),
      resetSessionApprovals: vi.fn(),
    };
    let resolveOpen!: (s: typeof session) => void;
    openMock.mockImplementationOnce(
      () =>
        new Promise<typeof session>((res) => {
          resolveOpen = res;
        }),
    );
    const pool = await importPool();

    const a = pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    const b = pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    // Each acquire awaits the (mocked) extension fingerprint before invoking
    // open(); wait for the single open() call so the resolver is set before
    // we resolve it.
    await vi.waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    resolveOpen(session);
    const [r1, r2] = await Promise.all([a, b]);

    expect(r1).toBe(session);
    expect(r2).toBe(session);
    expect(openMock).toHaveBeenCalledTimes(1);
  });

  it("drops the in-flight cache entry when open() rejects so retries can proceed", async () => {
    const err = new Error("boom");
    openMock.mockRejectedValueOnce(err);
    const session = {
      conversationId: 1,
      workingDirectory: "/tmp/work-a",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApproveAll: vi.fn(),
      resetSessionApprovals: vi.fn(),
    };
    openMock.mockResolvedValueOnce(session);
    const pool = await importPool();

    await expect(
      pool.acquire({
        conversationId: 1,
        userId: 1,
        workingDirectory: "/tmp/work-a",
        model: "gpt-4",
        policy: "prompt",
      }),
    ).rejects.toBe(err);
    const ok = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    expect(ok).toBe(session);
    expect(ok).toBe(session);
    expect(openMock).toHaveBeenCalledTimes(2);
  });

  it("release leaves an active-turn session pooled instead of disposing it mid-turn", async () => {
    const session = {
      conversationId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApproveAll: vi.fn(),
      resetSessionApprovals: vi.fn(),
    };
    openMock.mockResolvedValue(session);
    const pool = await importPool();
    await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    // Simulate an active turn via the keep-alive registry (turn-runner
    // registers `turns.active` there in production). Releasing must NOT
    // dispose the session out from under the stream — that would end the
    // send queue and finalize the turn as a silent empty/partial 'complete'.
    pool.registerKeepAlive("test.active", (cid) => cid === 1);
    await pool.release(1);
    expect(session.dispose).not.toHaveBeenCalled();
    expect(pool.getActive(1)).toBe(session);

    // Once the turn settles, release behaves exactly as before.
    pool.registerKeepAlive("test.active", () => false);
    await pool.release(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(pool.getActive(1)).toBeNull();
  });

  it("defers forced eviction while every session has an active turn", async () => {
    process.env.MAX_CONCURRENT_SESSIONS = "1";
    const makeSession = (conversationId: number) => ({
      conversationId,
      workingDirectory: `/tmp/work-${conversationId}`,
      model: "gpt-4",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApproveAll: vi.fn(),
      resetSessionApprovals: vi.fn(),
    });
    const busySession = makeSession(1);
    const spareSession = makeSession(2);
    const afterSession = makeSession(3);
    openMock
      .mockResolvedValueOnce(busySession)
      .mockResolvedValueOnce(spareSession)
      .mockResolvedValueOnce(afterSession);
    try {
      const pool = await importPool();
      await pool.acquire({
        conversationId: 1,
        userId: 1,
        workingDirectory: "/tmp/work-1",
        model: "gpt-4",
        policy: "prompt",
      });
      pool.registerKeepAlive("test.active", (cid) => cid === 1);

      // The only live session is mid-turn and the pool is at capacity: the
      // new acquire must NOT force-dispose it (which would silently kill
      // the stream); the cap overrun is deferred until the turn finishes.
      const second = await pool.acquire({
        conversationId: 2,
        userId: 1,
        workingDirectory: "/tmp/work-2",
        model: "gpt-4",
        policy: "prompt",
      });
      expect(second).toBe(spareSession);
      expect(busySession.dispose).not.toHaveBeenCalled();
      expect(pool.getActive(1)).toBe(busySession);

      // Turn ends → the session is unprotected → the next acquire evicts
      // it as the oldest idle session, as before the guard.
      pool.registerKeepAlive("test.active", () => false);
      const third = await pool.acquire({
        conversationId: 3,
        userId: 1,
        workingDirectory: "/tmp/work-3",
        model: "gpt-4",
        policy: "prompt",
      });
      expect(third).toBe(afterSession);
      expect(busySession.dispose).toHaveBeenCalledTimes(1);
      expect(pool.getActive(1)).toBeNull();
    } finally {
      delete process.env.MAX_CONCURRENT_SESSIONS;
      // Clear the keep-alive registration so it can't leak into the next
      // test (the registry survives via globalThis).
      openMock.mockReset();
    }
  });

  it("recreates a live session when the extension fingerprint changes", async () => {
    const firstSession = {
      conversationId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      extensionFingerprint: "fp-a",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApproveAll: vi.fn(),
      resetSessionApprovals: vi.fn(),
    };
    const secondSession = {
      ...firstSession,
      extensionFingerprint: "fp-b",
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    // Extension set changed between the two acquires → the cached session is
    // disposed and a fresh one opened (the Settings → Extensions effect).
    fingerprintMock.mockResolvedValueOnce("fp-a").mockResolvedValueOnce("fp-b");
    openMock
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(secondSession);
    const pool = await importPool();

    const first = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    const second = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    expect(first).not.toBe(second);
    expect(firstSession.dispose).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledTimes(2);
    expect(second.extensionFingerprint).toBe("fp-b");
  });

  it("reuses a live session when the extension fingerprint is unchanged", async () => {
    const session = {
      conversationId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      extensionFingerprint: "fp-same",
      lastUsed: Date.now(),
      send: vi.fn(),
      abort: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      setMode: vi.fn(),
      setApproveAll: vi.fn(),
      resetSessionApprovals: vi.fn(),
    };
    fingerprintMock.mockResolvedValue("fp-same");
    openMock.mockResolvedValue(session);
    const pool = await importPool();

    const first = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    const second = await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    expect(first).toBe(second);
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(session.dispose).not.toHaveBeenCalled();
  });
});
