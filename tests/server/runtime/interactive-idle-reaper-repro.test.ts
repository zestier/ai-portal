// Regression test for ticket 01KTYKK0Z2CCH0Y2G7RNTYNJDH (primary strand;
// follow-up to investigation 01KTNR3HRJQFW3CGPK6K5V5XKV).
//
// The "walk away, come back, approve, tool never runs" symptom. The pool's
// idle reaper (default IDLE_TIMEOUT_MIN=15) and capacity eviction used to
// dispose a pooled SDK session purely on `lastUsed` age / oldest-first, with
// NO regard for an outstanding interactive prompt or an active turn. So a
// permission prompt left open past the idle window had its backing session
// reaped while `onPermissionRequest` was still awaiting the deferred: the
// dialog stayed answerable and the resolve POST 200'd, but the SDK session
// that would execute the approved tool was gone -> the tool never ran and the
// turn hung.
//
// The fix:
//   - the reaper SKIPS any session with work outstanding (pending prompt via
//     interactive-requests.hasPending, or an active turn via a registered
//     keep-alive predicate) -> "a leak is better than a silent deny";
//   - capacity eviction prefers an unprotected session, and only force-evicts
//     a protected one as a last resort, first expiring its pending prompt with
//     a distinct non-deny "session expired — re-issue" outcome so the agent
//     unblocks instead of hanging.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupLocalEnv } from "../../helpers/env";

const openMock = vi.fn();

vi.mock("../../../src/lib/server/pi", () => ({
  openPiSession: (...args: unknown[]) => openMock(...args),
}));

async function importModules() {
  vi.resetModules();
  const pool = await import("../../../src/lib/server/runtime/pool");
  const interactive =
    await import("../../../src/lib/server/runtime/interactive-requests");
  return { pool, interactive };
}

function makeStubSession(conversationId: number) {
  return {
    conversationId,
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
}

type InteractiveModule =
  typeof import("../../../src/lib/server/runtime/interactive-requests");

const usedConvs = new Set<number>();

function registerPrompt(
  interactive: InteractiveModule,
  conversationId: number,
  requestId: string,
  kind: "permission" | "user_input" = "permission",
) {
  usedConvs.add(conversationId);
  const result: {
    settled: boolean;
    outcome: unknown;
    rejected: unknown;
    events: unknown[];
  } = {
    settled: false,
    outcome: null,
    rejected: null,
    events: [],
  };
  const view =
    kind === "permission"
      ? {
          requestId,
          kind: "permission" as const,
          tool: "git_commit",
          permissionKind: "shell",
          summary: "commit changes",
          args: null,
          userPolicy: "prompt" as const,
          canPersistDecision: false,
        }
      : {
          requestId,
          kind: "user_input" as const,
          question: "pick one",
          allowFreeform: true,
        };
  interactive.register({
    requestId,
    conversationId,
    kind,
    view,
    resolve: (r) => {
      result.settled = true;
      result.outcome = r;
    },
    reject: (e) => {
      result.rejected = e;
    },
    emit: (ev) => {
      result.events.push(ev);
    },
  });
  return result;
}

describe("pool does not strand sessions with outstanding work", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-idle-reaper-");
    process.env.IDLE_TIMEOUT_MIN = "15";
    delete process.env.MAX_CONCURRENT_SESSIONS;
    openMock.mockReset();
    usedConvs.clear();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { pool, interactive } = await importModules();
    // Clear any deferreds left on the globalThis-backed pending map so
    // they don't leak into sibling test files in the same worker.
    for (const id of usedConvs)
      interactive.cancelConversation(id, "test_cleanup");
    usedConvs.clear();
    await pool.shutdown();
  });

  it("idle reaper skips a session with a pending permission prompt, then reaps it after resolve", async () => {
    const session = makeStubSession(1);
    openMock.mockResolvedValue(session);
    const { pool, interactive } = await importModules();

    await pool.acquire({
      conversationId: 1,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    // The turn parks on a permission prompt (SDK callback awaiting the deferred).
    const result = registerPrompt(interactive, 1, "REQ_IDLE_1");
    expect(interactive.hasPending(1)).toBe(true);

    // User walks away well past the idle window. lastUsed never advanced.
    pool.startIdleReaper();
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);

    // FIX: the session backing the open prompt is NOT disposed.
    expect(session.dispose).not.toHaveBeenCalled();
    expect(pool.getActive(1)).toBe(session);

    // User comes back and approves: the SAME live session is still there to
    // run the tool, so the turn can progress.
    const ok = interactive.resolve("REQ_IDLE_1", 1, {
      kind: "permission",
      decision: "allow-once",
    });
    expect(ok).toBe(true);
    expect(result.settled).toBe(true);
    expect(pool.getActive(1)).toBe(session);

    // With no work outstanding, the next reaper tick is free to reclaim it.
    expect(interactive.hasPending(1)).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(pool.getActive(1)).toBeNull();
  });

  it("idle reaper skips a session with an active turn (keep-alive predicate)", async () => {
    const session = makeStubSession(2);
    openMock.mockResolvedValue(session);
    const { pool } = await importModules();

    await pool.acquire({
      conversationId: 2,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    // Simulate the turn registry reporting an active turn (turn-runner
    // registers exactly this predicate against the live registry).
    let turnRunning = true;
    pool.registerKeepAlive("test.active-turn", (id) => id === 2 && turnRunning);

    pool.startIdleReaper();
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    expect(session.dispose).not.toHaveBeenCalled();

    // Turn finishes -> no longer protected -> reapable.
    turnRunning = false;
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(session.dispose).toHaveBeenCalledTimes(1);

    // Restore the predicate so it doesn't pin sessions in later tests.
    pool.registerKeepAlive("test.active-turn", () => false);
  });

  it("capacity eviction prefers an idle, unprotected session over a busy one", async () => {
    process.env.MAX_CONCURRENT_SESSIONS = "2";
    const busy = makeStubSession(3);
    const idle = makeStubSession(4);
    const fresh = makeStubSession(5);
    openMock
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce(fresh);
    const { pool, interactive } = await importModules();

    // conv-busy acquired first (oldest), but it has an open prompt.
    await pool.acquire({
      conversationId: 3,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    registerPrompt(interactive, 3, "REQ_BUSY");

    await pool.acquire({
      conversationId: 4,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    // Third acquire is over capacity. conv-busy is the oldest, but it's
    // protected -> the unprotected conv-idle is evicted instead.
    await pool.acquire({
      conversationId: 5,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    expect(idle.dispose).toHaveBeenCalledTimes(1);
    expect(busy.dispose).not.toHaveBeenCalled();
    expect(pool.getActive(3)).toBe(busy);
    expect(pool.getActive(5)).toBe(fresh);
    expect(interactive.hasPending(3)).toBe(true);
  });

  it("forced eviction (all sessions busy) expires the prompt with a non-deny re-issue outcome", async () => {
    process.env.MAX_CONCURRENT_SESSIONS = "1";
    const busy = makeStubSession(6);
    const fresh = makeStubSession(7);
    openMock.mockResolvedValueOnce(busy).mockResolvedValueOnce(fresh);
    const { pool, interactive } = await importModules();

    await pool.acquire({
      conversationId: 6,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    const result = registerPrompt(interactive, 6, "REQ_ONLY");

    // Over capacity and the ONLY session is busy -> forced eviction. The
    // parked prompt is expired (not denied) so the agent unblocks.
    await pool.acquire({
      conversationId: 7,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });

    expect(busy.dispose).toHaveBeenCalledTimes(1);
    expect(pool.getActive(6)).toBeNull();
    expect(pool.getActive(7)).toBe(fresh);

    // The deferred settled by REJECTION (agent no longer hangs; the SDK maps
    // this to `user-not-available`, not a user denial).
    expect(result.settled).toBe(false);
    const rejected = result.rejected as {
      name?: string;
      auditDecision?: string;
    } | null;
    expect(rejected?.name).toBe("InteractivePromptCancelledError");
    expect(rejected?.auditDecision).toBe("auto-expired");

    // The broadcast `interactive.resolved` event still carries the distinct,
    // non-deny "re-issue" outcome (feedback marks it as a reclaim, not a
    // user denial) so a replayed event log shows the real cause.
    const resolvedEvent = result.events.find(
      (e) => (e as { type?: string }).type === "interactive.resolved",
    ) as
      | { cancelled?: boolean; outcome?: { kind: string; feedback?: string } }
      | undefined;
    expect(resolvedEvent?.cancelled).toBe(true);
    expect(resolvedEvent?.outcome?.kind).toBe("permission");
    expect(resolvedEvent?.outcome?.feedback ?? "").toMatch(/re-issue/i);
    expect(resolvedEvent?.outcome?.feedback ?? "").not.toMatch(/denied/i);
    // And the request is cleared from the pending map.
    expect(interactive.get("REQ_ONLY")).toBeUndefined();
    expect(interactive.hasPending(6)).toBe(false);
  });

  it("protects non-permission prompt kinds too (user_input)", async () => {
    const session = makeStubSession(8);
    openMock.mockResolvedValue(session);
    const { pool, interactive } = await importModules();

    await pool.acquire({
      conversationId: 8,
      userId: 1,
      workingDirectory: "/tmp/work-a",
      model: "gpt-4",
      policy: "prompt",
    });
    registerPrompt(interactive, 8, "REQ_INPUT", "user_input");

    pool.startIdleReaper();
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    expect(session.dispose).not.toHaveBeenCalled();
  });
});
