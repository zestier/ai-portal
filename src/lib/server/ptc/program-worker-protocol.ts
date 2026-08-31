import type { ProgramRunResult } from "./program.ts";

export type CapabilityKind = "tool" | "facade";

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  fileName?: string;
  lineNumber?: number;
  cause?: SerializedError;
  storeWrites?: Record<string, unknown>;
}

export type ProgramWorkerRequest =
  | {
      type: "run";
      executionId: string;
      source: string;
      resultMode?: "required" | "discard";
      storeMode?: "read-only" | "mutable";
      capabilityNames: string[];
      facadeCapabilityNames: string[];
      abortBuffer: SharedArrayBuffer;
    }
  | {
      type: "capability.result";
      executionId: string;
      requestId: number;
      result: unknown;
    }
  | {
      type: "capability.error";
      executionId: string;
      requestId: number;
      error: SerializedError;
    }
  | {
      type: "saved-value.result";
      executionId: string;
      requestId: number;
      value: unknown;
    }
  | {
      type: "saved-value.error";
      executionId: string;
      requestId: number;
      error: SerializedError;
    };

export type ProgramWorkerResponse =
  | {
      type: "ready";
    }
  | {
      type: "capability.call";
      executionId: string;
      requestId: number;
      kind: CapabilityKind;
      name: string;
      args: unknown;
    }
  | {
      type: "saved-value.get";
      executionId: string;
      requestId: number;
      id: string;
    }
  | {
      type: "completed";
      executionId: string;
      result: ProgramRunResult;
    }
  | {
      type: "failed";
      executionId: string;
      error: SerializedError;
    };

export function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const located = error as Error & {
    fileName?: string;
    lineNumber?: number;
    storeWrites?: Record<string, unknown>;
  };
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(located.fileName ? { fileName: located.fileName } : {}),
    ...(typeof located.lineNumber === "number"
      ? { lineNumber: located.lineNumber }
      : {}),
    ...(error.cause ? { cause: serializeError(error.cause) } : {}),
    ...(located.storeWrites ? { storeWrites: located.storeWrites } : {}),
  };
}

export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message, {
    ...(serialized.cause ? { cause: deserializeError(serialized.cause) } : {}),
  });
  error.name = serialized.name;
  if (serialized.stack) error.stack = serialized.stack;
  const located = error as Error & {
    fileName?: string;
    lineNumber?: number;
    storeWrites?: Record<string, unknown>;
  };
  if (serialized.fileName) located.fileName = serialized.fileName;
  if (typeof serialized.lineNumber === "number") {
    located.lineNumber = serialized.lineNumber;
  }
  if (serialized.storeWrites) located.storeWrites = serialized.storeWrites;
  return error;
}
