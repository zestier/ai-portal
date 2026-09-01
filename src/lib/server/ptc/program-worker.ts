import type { MessagePort } from "node:worker_threads";
import { ok, type PortalTool, type ToolResult } from "../tools/types.ts";
import { runProgramInline } from "./program.ts";
import {
  deserializeError,
  serializeError,
  type CapabilityKind,
  type ProgramWorkerRequest,
  type ProgramWorkerResponse,
} from "./program-worker-protocol.ts";

let activeExecutionId: string | null = null;
let nextRequestId = 1;
const pending = new Map<
  number,
  { resolve(value: unknown): void; reject(error: Error): void }
>();
let port: MessagePort;

export function startProgramWorker(parentPort: MessagePort): void {
  port = parentPort;
  port.on("message", (message: ProgramWorkerRequest) => {
    if (message.type === "run") {
      if (activeExecutionId) {
        post({
          type: "failed",
          executionId: message.executionId,
          error: serializeError(new Error("Program worker is already busy.")),
        });
        return;
      }
      pending.clear();
      nextRequestId = 1;
      void run(message);
      return;
    }
    if (message.executionId !== activeExecutionId) return;
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    if (message.type === "capability.result") request.resolve(message.result);
    else if (message.type === "saved-value.result")
      request.resolve(message.value);
    else request.reject(deserializeError(message.error));
  });
  post({ type: "ready" });
}

async function run(
  message: Extract<ProgramWorkerRequest, { type: "run" }>,
): Promise<void> {
  activeExecutionId = message.executionId;
  const abortView = new Int32Array(message.abortBuffer);
  try {
    const result = await runProgramInline({
      source: message.source,
      cwd: message.cwd,
      ...(message.resultMode !== undefined
        ? { resultMode: message.resultMode }
        : {}),
      ...(message.storeMode !== undefined
        ? { storeMode: message.storeMode }
        : {}),
      capabilities: toolMap(message.capabilityNames),
      facadeCapabilities: toolMap(message.facadeCapabilityNames),
      savedValues: {
        get(id) {
          return request("saved-value", { id });
        },
      },
      execute: async () => ok(),
      hostManagedExecute: (kind, name, args) =>
        request("capability", { kind, name, args }) as Promise<ToolResult>,
      signal: {
        get aborted() {
          return Atomics.load(abortView, 0) === 1;
        },
      } as AbortSignal,
    });
    post({ type: "completed", executionId: message.executionId, result });
  } catch (error) {
    post({
      type: "failed",
      executionId: message.executionId,
      error: serializeError(error),
    });
  } finally {
    activeExecutionId = null;
  }
}

function request(
  type: "capability",
  input: { kind: CapabilityKind; name: string; args: unknown },
): Promise<unknown>;
function request(type: "saved-value", input: { id: string }): Promise<unknown>;
function request(
  type: "capability" | "saved-value",
  input: { kind: CapabilityKind; name: string; args: unknown } | { id: string },
): Promise<unknown> {
  if (!activeExecutionId) {
    return Promise.reject(new Error("No active program execution."));
  }
  const requestId = nextRequestId++;
  const response = new Promise<unknown>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
  });
  if (type === "capability" && "name" in input) {
    post({
      type: "capability.call",
      executionId: activeExecutionId,
      requestId,
      kind: input.kind,
      name: input.name,
      args: input.args,
    });
  } else if ("id" in input) {
    post({
      type: "saved-value.get",
      executionId: activeExecutionId,
      requestId,
      id: input.id,
    });
  }
  return response;
}

function toolMap(names: string[]): Map<string, PortalTool> {
  return new Map(
    names.map((name) => [
      name,
      {
        name,
        description: name,
        parameters: {},
        async handler() {
          return ok();
        },
      },
    ]),
  );
}

function post(message: ProgramWorkerResponse): void {
  port.postMessage(message);
}
