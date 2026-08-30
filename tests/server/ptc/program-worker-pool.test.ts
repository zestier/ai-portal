import { afterEach, describe, expect, it } from "vitest";
import { ok } from "../../../src/lib/server/tools/types";
import {
  ProgramWorkerPool,
  type ProgramWorkerRunOptions,
} from "../../../src/lib/server/ptc/program-worker-pool";

const pools: ProgramWorkerPool[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.shutdown()));
});

describe("ProgramWorkerPool", () => {
  it("serializes executions through one worker", async () => {
    const pool = createPool();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const calls: string[] = [];

    const first = pool.run(
      options(
        "return tools.pause({ id: 'first' });",
        async (_kind, _name, args) => {
          calls.push((args as { id: string }).id);
          firstStarted();
          await firstGate;
          return ok("first done");
        },
      ),
    );
    await started;
    const second = pool.run(
      options(
        "return tools.pause({ id: 'second' });",
        async (_kind, _name, args) => {
          calls.push((args as { id: string }).id);
          return ok("second done");
        },
      ),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual(["first"]);
    expect(pool.snapshot()).toMatchObject({ active: true, queueDepth: 1 });

    releaseFirst();
    await expect(first).resolves.toMatchObject({ value: "first done" });
    await expect(second).resolves.toMatchObject({ value: "second done" });
    expect(calls).toEqual(["first", "second"]);
    expect(pool.snapshot()).toMatchObject({
      active: false,
      queueDepth: 0,
      completed: 2,
    });
  });

  it("removes an aborted queued execution without disturbing active work", async () => {
    const pool = createPool();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const first = pool.run(
      options("return tools.pause({});", async () => {
        firstStarted();
        await firstGate;
        return ok("done");
      }),
    );
    await started;

    const controller = new AbortController();
    const queued = pool.run(options("return 2;", async () => ok(), controller));
    controller.abort();

    await expect(queued).rejects.toThrow("Execution aborted");
    expect(pool.snapshot()).toMatchObject({
      active: true,
      queueDepth: 0,
      aborted: 1,
    });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ value: "done" });
  });

  it("interrupts CPU-bound guest work and remains reusable", async () => {
    const pool = createPool({ abortGraceMs: 500 });
    const controller = new AbortController();
    const run = pool.run(options("for (;;) {}", async () => ok(), controller));

    setTimeout(() => controller.abort(), 30);
    await expect(run).rejects.toThrow(/interrupted|aborted/i);
    await expect(
      pool.run(options("return 42;", async () => ok())),
    ).resolves.toMatchObject({ value: 42 });
    expect(pool.snapshot()).toMatchObject({ aborted: 1, completed: 1 });
  });

  it("bounds accepted active and queued executions", async () => {
    const pool = createPool({ maxQueueDepth: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = pool.run(
      options("return tools.pause({});", async () => {
        started();
        await gate;
        return ok("first");
      }),
    );
    await active;
    const second = pool.run(options("return 'second';", async () => ok()));

    await expect(
      pool.run(options("return 'overflow';", async () => ok())),
    ).rejects.toThrow("Program execution queue is full (2)");
    release();
    await expect(first).resolves.toMatchObject({ value: "first" });
    await expect(second).resolves.toMatchObject({ value: "second" });
  });

  it("terminates hard-timed-out work and resumes the queue on a new worker", async () => {
    const pool = createPool({ hardTimeoutMs: 75 });
    let hostAborted = false;
    let hostStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      hostStarted = resolve;
    });
    const stuck = pool.run(
      options(
        "return tools.pause({});",
        async (_kind, _name, _args, signal) => {
          hostStarted();
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                hostAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return ok("late");
        },
      ),
    );
    await started;
    const queued = pool.run(
      options("return 'after restart';", async () => ok()),
    );

    await expect(stuck).rejects.toThrow("Execution exceeded 120s");
    await expect(queued).resolves.toMatchObject({ value: "after restart" });
    expect(hostAborted).toBe(true);
    expect(pool.snapshot()).toMatchObject({
      failed: 1,
      completed: 1,
      workerRestarts: 1,
    });
  });

  it("ignores a late host result after replacing its worker", async () => {
    const pool = createPool({ hardTimeoutMs: 60 });
    let finishHost!: () => void;
    const hostGate = new Promise<void>((resolve) => {
      finishHost = resolve;
    });
    let hostStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      hostStarted = resolve;
    });
    const timedOut = pool.run(
      options("return tools.pause({});", async () => {
        hostStarted();
        await hostGate;
        return ok("too late");
      }),
    );
    await started;
    const next = pool.run(options("return 'next';", async () => ok()));

    await expect(timedOut).rejects.toThrow("exceeded 120s");
    finishHost();
    await expect(next).resolves.toMatchObject({ value: "next" });
    expect(pool.snapshot()).toMatchObject({ completed: 1, failed: 1 });
  });

  it("aborts in-flight host work during shutdown", async () => {
    const pool = createPool();
    let hostAborted = false;
    let hostStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      hostStarted = resolve;
    });
    const run = pool.run(
      options(
        "return tools.pause({});",
        async (_kind, _name, _args, signal) => {
          hostStarted();
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                hostAborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return ok();
        },
      ),
    );
    await started;
    const outcome = run.catch((error: unknown) => error);

    await pool.shutdown();
    await expect(outcome).resolves.toMatchObject({
      message: "Program worker pool shut down.",
    });
    expect(hostAborted).toBe(true);
  });

  it("preserves host errors and processes later work", async () => {
    const pool = createPool();
    const failed = pool.run(
      options("return tools.fail({});", async () => {
        throw new TypeError("host capability failed");
      }),
    );

    await expect(failed).rejects.toMatchObject({
      name: "TypeError",
      message: "host capability failed",
      stack: expect.stringContaining("program.js"),
    });
    await expect(
      pool.run(options("return 'recovered';", async () => ok())),
    ).resolves.toMatchObject({ value: "recovered" });
    expect(pool.snapshot()).toMatchObject({ failed: 1, completed: 1 });
  });
});

function createPool(
  options: ConstructorParameters<typeof ProgramWorkerPool>[0] = {},
): ProgramWorkerPool {
  const pool = new ProgramWorkerPool(options);
  pools.push(pool);
  return pool;
}

function options(
  source: string,
  execute: ProgramWorkerRunOptions["execute"],
  controller = new AbortController(),
): ProgramWorkerRunOptions {
  return {
    source,
    capabilityNames: ["pause", "fail"],
    facadeCapabilityNames: [],
    signal: controller.signal,
    execute,
    loadValue: () => undefined,
  };
}
