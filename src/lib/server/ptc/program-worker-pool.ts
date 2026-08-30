import { randomUUID } from "node:crypto";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import type { ToolResult } from "$lib/server/tools/types";
import type { ProgramRunResult } from "./program.ts";
import { startProgramWorker } from "./program-worker.ts";
import {
  deserializeError,
  serializeError,
  type CapabilityKind,
  type ProgramWorkerRequest,
  type ProgramWorkerResponse,
} from "./program-worker-protocol.ts";

const MAX_QUEUE_DEPTH = 32;
const ABORT_GRACE_MS = 250;
const HARD_TIMEOUT_MS = 120_500;
const WORKER_KIND = "ptc-program-worker";

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  if (!parentPort) throw new Error("Program worker requires a parent port.");
  startProgramWorker(parentPort);
}

export interface ProgramWorkerPoolOptions {
  maxQueueDepth?: number;
  abortGraceMs?: number;
  hardTimeoutMs?: number;
}

export interface ProgramWorkerPoolSnapshot {
  active: boolean;
  queueDepth: number;
  completed: number;
  failed: number;
  aborted: number;
  workerRestarts: number;
  totalQueueWaitMs: number;
  totalExecutionMs: number;
}

export interface ProgramWorkerRunOptions {
  source: string;
  resultMode?: "required" | "discard";
  capabilityNames: string[];
  facadeCapabilityNames: string[];
  signal: AbortSignal;
  execute(
    kind: CapabilityKind,
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult>;
  loadValue(id: string): unknown | undefined;
}

interface QueueEntry {
  executionId: string;
  options: ProgramWorkerRunOptions;
  resolve(result: ProgramRunResult): void;
  reject(error: Error): void;
  abortBuffer: SharedArrayBuffer;
  abortView: Int32Array;
  controller: AbortController;
  removeAbortListener?: () => void;
  abortTimer?: ReturnType<typeof setTimeout>;
  hardTimer?: ReturnType<typeof setTimeout>;
  settled: boolean;
  enqueuedAt: number;
  startedAt?: number;
}

export class ProgramWorkerPool {
  private worker: Worker | null = null;
  private ready = false;
  private active: QueueEntry | null = null;
  private readonly queue: QueueEntry[] = [];
  private replacingWorker = false;
  private readonly maxQueueDepth: number;
  private readonly abortGraceMs: number;
  private readonly hardTimeoutMs: number;
  private completed = 0;
  private failed = 0;
  private aborted = 0;
  private workerRestarts = 0;
  private totalQueueWaitMs = 0;
  private totalExecutionMs = 0;

  constructor(options: ProgramWorkerPoolOptions = {}) {
    this.maxQueueDepth = options.maxQueueDepth ?? MAX_QUEUE_DEPTH;
    this.abortGraceMs = options.abortGraceMs ?? ABORT_GRACE_MS;
    this.hardTimeoutMs = options.hardTimeoutMs ?? HARD_TIMEOUT_MS;
  }

  run(options: ProgramWorkerRunOptions): Promise<ProgramRunResult> {
    if (options.signal.aborted) {
      return Promise.reject(new Error("Execution aborted."));
    }
    if (this.queue.length + (this.active ? 1 : 0) >= this.maxQueueDepth) {
      return Promise.reject(
        new Error(`Program execution queue is full (${this.maxQueueDepth}).`),
      );
    }

    return new Promise((resolve, reject) => {
      const abortBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const entry: QueueEntry = {
        executionId: randomUUID(),
        options,
        resolve,
        reject,
        abortBuffer,
        abortView: new Int32Array(abortBuffer),
        controller: new AbortController(),
        settled: false,
        enqueuedAt: Date.now(),
      };
      const onAbort = () => this.abort(entry);
      options.signal.addEventListener("abort", onAbort, { once: true });
      entry.removeAbortListener = () =>
        options.signal.removeEventListener("abort", onAbort);
      this.queue.push(entry);
      this.ensureWorker();
      this.dispatch();
    });
  }

  async shutdown(): Promise<void> {
    const error = new Error("Program worker pool shut down.");
    if (this.active) {
      this.active.controller.abort(error);
      this.settle(this.active, error);
    }
    this.active = null;
    for (const entry of this.queue.splice(0)) this.settle(entry, error);
    const worker = this.worker;
    this.worker = null;
    this.ready = false;
    if (worker) await worker.terminate();
  }

  snapshot(): ProgramWorkerPoolSnapshot {
    return {
      active: this.active !== null,
      queueDepth: this.queue.length,
      completed: this.completed,
      failed: this.failed,
      aborted: this.aborted,
      workerRestarts: this.workerRestarts,
      totalQueueWaitMs: this.totalQueueWaitMs,
      totalExecutionMs: this.totalExecutionMs,
    };
  }

  private ensureWorker(): void {
    if (this.worker || this.replacingWorker) return;
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: WORKER_KIND },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 2,
      },
    });
    worker.on("message", (message: ProgramWorkerResponse) =>
      this.onMessage(worker, message),
    );
    worker.on("error", (error) =>
      this.replaceWorker(
        worker,
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    worker.on("exit", (code) => {
      if (this.worker === worker) {
        this.replaceWorker(
          worker,
          new Error(`Program worker exited with code ${code}.`),
        );
      }
    });
    worker.unref();
    this.worker = worker;
  }

  private dispatch(): void {
    if (!this.worker || !this.ready || this.active) return;
    const entry = this.queue.shift();
    if (!entry) {
      this.worker.unref();
      return;
    }
    if (entry.options.signal.aborted) {
      this.settle(entry, new Error("Execution aborted."));
      this.dispatch();
      return;
    }
    this.active = entry;
    entry.startedAt = Date.now();
    this.totalQueueWaitMs += entry.startedAt - entry.enqueuedAt;
    this.worker.ref();
    entry.hardTimer = setTimeout(() => {
      this.replaceWorker(this.worker, new Error("Execution exceeded 120s."));
    }, this.hardTimeoutMs);
    this.post({
      type: "run",
      executionId: entry.executionId,
      source: entry.options.source,
      ...(entry.options.resultMode !== undefined
        ? { resultMode: entry.options.resultMode }
        : {}),
      capabilityNames: entry.options.capabilityNames,
      facadeCapabilityNames: entry.options.facadeCapabilityNames,
      abortBuffer: entry.abortBuffer,
    });
  }

  private onMessage(worker: Worker, message: ProgramWorkerResponse): void {
    if (worker !== this.worker) return;
    if (message.type === "ready") {
      this.ready = true;
      this.dispatch();
      return;
    }
    const entry = this.active;
    if (!entry || entry.executionId !== message.executionId) return;

    if (message.type === "capability.call") {
      void entry.options
        .execute(
          message.kind,
          message.name,
          message.args,
          entry.controller.signal,
        )
        .then((result) => {
          if (this.worker === worker && this.active === entry) {
            this.postTo(worker, {
              type: "capability.result",
              executionId: entry.executionId,
              requestId: message.requestId,
              result,
            });
          }
        })
        .catch((error: unknown) => {
          if (this.worker === worker && this.active === entry) {
            this.postTo(worker, {
              type: "capability.error",
              executionId: entry.executionId,
              requestId: message.requestId,
              error: serializeError(error),
            });
          }
        });
      return;
    }
    if (message.type === "saved-value.get") {
      try {
        this.post({
          type: "saved-value.result",
          executionId: entry.executionId,
          requestId: message.requestId,
          value: entry.options.loadValue(message.id),
        });
      } catch (error) {
        this.post({
          type: "saved-value.error",
          executionId: entry.executionId,
          requestId: message.requestId,
          error: serializeError(error),
        });
      }
      return;
    }
    if (message.type === "completed") {
      this.finishActive(undefined, message.result);
    } else if (message.type === "failed") {
      this.finishActive(deserializeError(message.error));
    }
  }

  private abort(entry: QueueEntry): void {
    Atomics.store(entry.abortView, 0, 1);
    Atomics.notify(entry.abortView, 0);
    entry.controller.abort();
    if (entry !== this.active) {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      this.settle(entry, new Error("Execution aborted."));
      return;
    }
    entry.abortTimer = setTimeout(() => {
      if (this.active === entry) {
        this.replaceWorker(this.worker, new Error("Execution aborted."));
      }
    }, this.abortGraceMs);
  }

  private finishActive(error?: Error, result?: ProgramRunResult): void {
    const entry = this.active;
    if (!entry) return;
    this.active = null;
    this.settle(entry, error, result);
    this.dispatch();
  }

  private settle(
    entry: QueueEntry,
    error?: Error,
    result?: ProgramRunResult,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.removeAbortListener?.();
    if (entry.abortTimer) clearTimeout(entry.abortTimer);
    if (entry.hardTimer) clearTimeout(entry.hardTimer);
    if (entry.startedAt) {
      this.totalExecutionMs += Date.now() - entry.startedAt;
    }
    if (error) {
      if (
        entry.options.signal.aborted ||
        error.message === "Execution aborted."
      ) {
        this.aborted++;
      } else {
        this.failed++;
      }
      entry.reject(error);
    } else if (result) {
      this.completed++;
      entry.resolve(result);
    } else entry.reject(new Error("Program execution ended without a result."));
  }

  private replaceWorker(worker: Worker | null, error: Error): void {
    if (!worker || worker !== this.worker || this.replacingWorker) return;
    const failedDuringStartup = !this.ready;
    this.workerRestarts++;
    this.replacingWorker = true;
    this.worker = null;
    this.ready = false;
    const entry = this.active;
    this.active = null;
    if (entry) {
      entry.controller.abort(error);
      this.settle(entry, error);
    }
    if (failedDuringStartup) {
      for (const queued of this.queue.splice(0)) this.settle(queued, error);
    }
    void worker.terminate().finally(() => {
      this.replacingWorker = false;
      if (this.queue.length > 0) {
        this.ensureWorker();
        this.dispatch();
      }
    });
  }

  private post(message: ProgramWorkerRequest): void {
    if (this.worker) this.postTo(this.worker, message);
  }

  private postTo(worker: Worker, message: ProgramWorkerRequest): void {
    try {
      worker.postMessage(message);
    } catch (error) {
      this.replaceWorker(
        worker,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

const programWorkerPool = new ProgramWorkerPool();

export function runProgramInWorker(
  options: ProgramWorkerRunOptions,
): Promise<ProgramRunResult> {
  return programWorkerPool.run(options);
}

export function shutdownProgramWorkerPool(): Promise<void> {
  return programWorkerPool.shutdown();
}

export function getProgramWorkerPoolStats(): ProgramWorkerPoolSnapshot {
  return programWorkerPool.snapshot();
}
