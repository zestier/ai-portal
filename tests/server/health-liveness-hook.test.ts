import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Handle } from "@sveltejs/kit";
import { setupLocalEnv } from "../helpers/env";

// Simulate a DB that fails the way a transient hiccup / mid-migration lock
// would: hooks.server.ts calls users.ensureLocalUser() on every request, and
// that helper runs a sync DB query. If the liveness probe routed through it,
// the container HEALTHCHECK would flap and restart the container. Mock the
// helper to throw so we can prove the liveness path never reaches it.
vi.mock("$lib/server/db/repos/users", async () => {
  const actual = await vi.importActual<object>("$lib/server/db/repos/users");
  return {
    ...actual,
    ensureLocalUser: () => {
      throw new Error("db down");
    },
  };
});

type HandleEvent = Parameters<Handle>[0]["event"];

function makeEvent(path: string): HandleEvent {
  const url = new URL(`http://127.0.0.1${path}`);
  return {
    url,
    request: new Request(url, { method: "GET", headers: new Headers() }),
    cookies: {
      get: () => undefined,
      getAll: () => [],
      set: () => {},
      delete: () => {},
      serialize: () => "",
    },
    locals: {} as App.Locals,
    setHeaders: () => {},
    platform: undefined,
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as HandleEvent;
}

async function loadHandle() {
  vi.resetModules();
  const mod = await import("../../src/hooks.server");
  return mod.handle;
}

describe("liveness probe is DB-independent at the hook", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-liveness-hook-");
  });

  it("serves /api/health/liveness even when the DB-backed auth path throws", async () => {
    const handle = await loadHandle();
    const res = await handle({
      event: makeEvent("/api/health/liveness"),
      resolve: async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });
    expect(res.status).toBe(200);
  });

  it("the same broken DB does reach the auth path for non-liveness routes", async () => {
    // Guards that the test above is meaningful: any other route still runs
    // the DB-touching auth resolution (which now throws), so liveness's
    // success is the short-circuit, not a no-op mock.
    const handle = await loadHandle();
    await expect(
      handle({
        event: makeEvent("/api/health"),
        resolve: async () => new Response("unreachable", { status: 200 }),
      }),
    ).rejects.toThrow("db down");
  });
});
