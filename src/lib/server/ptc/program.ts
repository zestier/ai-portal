import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSDeferredPromise } from "quickjs-emscripten";
import type { PortalTool, ToolResult } from "$lib/server/tools/types";

const MAX_OPERATIONS = 50;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_RUNTIME_MS = 120_000;
const MAX_MEMORY_BYTES = 32 * 1024 * 1024;
const MAX_STACK_BYTES = 512 * 1024;

export interface ProgramRunOptions {
  source: string;
  capabilities: ReadonlyMap<string, PortalTool>;
  execute(
    name: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult>;
  signal: AbortSignal;
}

export interface ProgramRunResult {
  value: unknown;
  operations: number;
}

export async function runProgram(
  opts: ProgramRunOptions,
): Promise<ProgramRunResult> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(MAX_MEMORY_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const deadline = Date.now() + MAX_RUNTIME_MS;
  const deadlineInterrupt = shouldInterruptAfterDeadline(deadline);
  runtime.setInterruptHandler(
    (activeRuntime) => opts.signal.aborted || deadlineInterrupt(activeRuntime),
  );
  const vm = runtime.newContext();
  const pending = new Set<Promise<unknown>>();
  const deferreds = new Set<QuickJSDeferredPromise>();
  let operations = 0;

  const callHandle = vm.newFunction(
    "__callCapability",
    (nameHandle, argsHandle) => {
      const name = vm.getString(nameHandle);
      const args = argsHandle ? vm.dump(argsHandle) : {};
      const deferred = vm.newPromise();
      deferreds.add(deferred);
      const operation = execute(name, args)
        .then((value) => {
          const encoded = JSON.stringify(value);
          if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) {
            throw new Error(
              `Capability ${name} result exceeded the size budget.`,
            );
          }
          const handle = vm.newString(encoded);
          deferred.resolve(handle);
          handle.dispose();
        })
        .catch((error) => {
          const handle = vm.newError(
            error instanceof Error ? error.message : String(error),
          );
          deferred.reject(handle);
          handle.dispose();
        })
        .finally(() => {
          pending.delete(operation);
          void runtime.executePendingJobs();
        });
      pending.add(operation);
      return deferred.handle;
    },
  );
  vm.setProp(vm.global, "__callCapability", callHandle);
  callHandle.dispose();

  const wrapped = `(async () => {
    const tools = new Proxy(Object.create(null), {
      get(_target, name) {
        if (typeof name !== "string" || name === "then") return undefined;
        return async (args = {}) => JSON.parse(await __callCapability(name, args));
      }
    });
    ${opts.source}
  })()`;

  try {
    const evaluation = vm.evalCode(wrapped, "frontier-program.js");
    const promiseHandle = vm.unwrapResult(evaluation);
    try {
      runtime.executePendingJobs();
      const state = vm.getPromiseState(promiseHandle);
      const valueHandle =
        state.type === "fulfilled"
          ? state.value
          : state.type === "rejected"
            ? (() => {
                const message = String(vm.dump(state.error));
                state.error.dispose();
                throw new Error(message);
              })()
            : vm.unwrapResult(await vm.resolvePromise(promiseHandle));
      try {
        const value = vm.dump(valueHandle);
        const encoded = JSON.stringify(value ?? null);
        if (Buffer.byteLength(encoded) > MAX_OUTPUT_BYTES) {
          throw new Error("Program result exceeded its size budget.");
        }
        return { value, operations };
      } finally {
        valueHandle.dispose();
      }
    } finally {
      promiseHandle.dispose();
    }
  } finally {
    await Promise.allSettled(pending);
    for (const deferred of deferreds) deferred.dispose();
    vm.dispose();
    runtime.dispose();
  }

  async function execute(name: string, args: unknown): Promise<ToolResult> {
    operations++;
    if (operations > MAX_OPERATIONS) {
      throw new Error("Program exceeded its operation budget.");
    }
    if (opts.signal.aborted) throw new Error("Program aborted.");
    if (Date.now() > deadline) {
      throw new Error("Program exceeded its runtime budget.");
    }
    if (!opts.capabilities.has(name)) {
      return {
        ok: false,
        error: {
          message: `Unknown capability: ${name}`,
          details: { validTools: [...opts.capabilities.keys()].sort() },
        },
      };
    }
    return opts.execute(name, args, opts.signal);
  }
}
