import { parseEnvelopeJson } from "$lib/tool-result-views";
import type { ToolCallRecord } from "$lib/types";

export interface ProcArgs {
  summary: string;
  procedure: string;
  result_requirements: string;
}

export interface ProcExecutionArgs {
  javascript: string;
  needed_for?: string;
  store_into?: string | null;
  max_bytes?: number;
  /** Legacy streamed metadata retained for older conversations. */
  save_as?: string | null;
  worker_view?: "none" | "shape" | "value";
  worker_view_max_bytes?: number;
  /** Legacy worker view retained for older conversations. */
  view?: "shape" | "value";
}

export interface ProcExecutionResult {
  store_revision?: string;
  store_writes?: Array<{
    name: string;
    version: string;
    result_id: string;
    value_bytes: number;
    shape?: unknown;
    shape_bytes?: number;
    shape_truncated?: boolean;
  }>;
  store_snapshot?: Record<string, { toolCallId: number; resultId: string }>;
  save_as?: string | null;
  value_bytes?: number;
  worker_view?: "none" | "shape" | "value";
  worker_view_kind?: "none" | "shape" | "value";
  worker_view_max_bytes?: number;
  worker_view_bytes?: number;
  worker_view_truncated?: boolean;
  reason?: "value_exceeded_limit";
  /** Legacy worker view fields retained for older conversations. */
  view?: "shape" | "value";
  shape?: unknown;
  value?: unknown;
  view_bytes?: number;
  truncated?: boolean;
  structure?: unknown;
  structure_bytes?: number;
  shape_bytes?: number;
  shape_truncated?: boolean;
  max_bytes?: number;
  needed_for?: string;
  bytes?: number;
  operations?: number;
  effects?: Array<{
    tool: string;
    effect: string;
    ok: boolean;
    count?: number;
  }>;
  effects_total?: number;
  retry_safe?: boolean;
  error?: string;
}

export interface ProcOutcome {
  status?: string;
  bytes?: number;
  projection?: unknown;
  projection_bytes?: number;
  truncated?: boolean;
  usage?: {
    turns?: number;
    executions?: number;
    operations?: number;
    input?: number;
    output?: number;
    cost?: number;
  };
  error?: string;
}

export interface ProcExecutionDisplay {
  kind: "execute" | "view" | "finish";
  title: string;
  storageLabel: string | null;
  requestedView: "shape" | "value" | "none" | null;
  actualView: "shape" | "value" | "none" | null;
  bytes: number | null;
  operations: number | null;
  error: string | null;
  retrySafe: boolean | null;
  input: {
    javascript: string;
    storeId: string | null | undefined;
    workerView: "shape" | "value" | "none";
    viewBudget: number | null;
  } | null;
  output: {
    label: "Structure" | "Worker view";
    value: unknown;
    bytes: number | null;
    truncated: boolean;
    reason: string | null;
  } | null;
  rawInput: string | null;
  workerFeedback: string | null;
  rawOutput: string | null;
  storeRevision: string | null;
}

export function normalizeProcExecution(
  execution: ToolCallRecord,
): ProcExecutionDisplay {
  const kind =
    execution.tool === "view" || execution.tool === "finish"
      ? execution.tool
      : "execute";
  const args =
    parseProcExecutionArgs(execution.argsJson) ??
    parseProcExecutionMeta(execution.meta);
  const result = parseProcExecutionResult(execution.resultJson);
  const storeId = args?.store_into ?? args?.save_as;
  const requestedView =
    kind === "view" ? "value" : (args?.worker_view ?? args?.view ?? null);
  const actualView =
    result?.worker_view_kind ??
    result?.view ??
    (kind === "view"
      ? "value"
      : kind === "execute" && result?.shape !== undefined
        ? "shape"
        : null);
  const viewValue = actualView === "value" ? result?.value : result?.shape;
  const output =
    result?.structure !== undefined
      ? {
          label: "Structure" as const,
          value: result.structure,
          bytes: result.structure_bytes ?? null,
          truncated: result.shape_truncated ?? false,
          reason: null,
        }
      : viewValue !== undefined
        ? {
            label: "Worker view" as const,
            value: viewValue,
            bytes:
              result?.worker_view_bytes ??
              result?.view_bytes ??
              result?.shape_bytes ??
              null,
            truncated:
              result?.worker_view_truncated ??
              result?.truncated ??
              result?.shape_truncated ??
              false,
            reason:
              result?.reason === "value_exceeded_limit"
                ? "value exceeded budget"
                : null,
          }
        : null;
  const storageLabel =
    kind === "finish"
      ? "final result"
      : kind === "view"
        ? null
        : result?.store_writes?.length
          ? `stored: ${result.store_writes.map((write) => write.name).join(", ")}`
          : storeId
            ? `store: ${storeId}`
            : null;

  return {
    kind,
    title:
      args?.needed_for ??
      (execution.tool === "finish"
        ? "Final result"
        : kind === "view"
          ? "View"
          : "Execution"),
    storageLabel,
    requestedView,
    actualView,
    bytes: result?.value_bytes ?? result?.bytes ?? null,
    operations: result?.operations ?? null,
    error: result?.error ?? null,
    retrySafe: result?.retry_safe ?? null,
    input: args
      ? {
          javascript: args.javascript,
          storeId,
          workerView: requestedView ?? (kind === "execute" ? "shape" : "none"),
          viewBudget: args.worker_view_max_bytes ?? args.max_bytes ?? null,
        }
      : null,
    output,
    rawInput: execution.argsJson,
    workerFeedback: procExecutionFeedbackText(execution.resultJson),
    rawOutput: execution.resultJson,
    storeRevision: result?.store_revision ?? null,
  };
}

export function parseProcArgs(json: string | null): ProcArgs | null {
  return procArgsOf(parseObject(json));
}

export function parseProcMeta(value: unknown): ProcArgs | null {
  return procArgsOf(value);
}

function procArgsOf(value: unknown): ProcArgs | null {
  if (
    !isObject(value) ||
    typeof value.summary !== "string" ||
    typeof value.procedure !== "string" ||
    typeof value.result_requirements !== "string"
  ) {
    return null;
  }
  return value as unknown as ProcArgs;
}

export function parseProcExecutionArgs(
  json: string | null,
): ProcExecutionArgs | null {
  return procExecutionArgsOf(parseObject(json));
}

export function parseProcExecutionMeta(
  value: unknown,
): ProcExecutionArgs | null {
  return procExecutionArgsOf(value);
}

function procExecutionArgsOf(value: unknown): ProcExecutionArgs | null {
  if (!isObject(value) || typeof value.javascript !== "string") {
    return null;
  }
  if (
    (value.needed_for !== undefined && typeof value.needed_for !== "string") ||
    (value.store_into !== undefined &&
      value.store_into !== null &&
      typeof value.store_into !== "string") ||
    (value.save_as !== undefined &&
      value.save_as !== null &&
      typeof value.save_as !== "string") ||
    (value.max_bytes !== undefined && typeof value.max_bytes !== "number") ||
    (value.worker_view !== undefined &&
      value.worker_view !== "none" &&
      value.worker_view !== "shape" &&
      value.worker_view !== "value") ||
    (value.worker_view_max_bytes !== undefined &&
      typeof value.worker_view_max_bytes !== "number") ||
    (value.view !== undefined &&
      value.view !== "shape" &&
      value.view !== "value")
  ) {
    return null;
  }
  return value as unknown as ProcExecutionArgs;
}

/** The byte-for-byte JSON text returned to the proc worker. */
export function procExecutionFeedbackText(json: string | null): string | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "string" ? value : json;
  } catch {
    return json;
  }
}

export function parseProcExecutionResult(
  json: string | null,
): ProcExecutionResult | null {
  if (!json) return null;
  try {
    let value: unknown = JSON.parse(json);
    if (typeof value === "string") {
      const text = value;
      try {
        value = JSON.parse(text);
      } catch {
        return { error: text };
      }
    }
    if (isObject(value) && value.ok === true && "result" in value) {
      value = value.result;
    } else if (isObject(value) && value.ok === false) {
      const error = value.error;
      return {
        error:
          isObject(error) && typeof error.message === "string"
            ? error.message
            : typeof error === "string"
              ? error
              : "Execution failed.",
      };
    }
    return isObject(value) ? (value as ProcExecutionResult) : null;
  } catch {
    return null;
  }
}

export function parseProcOutcome(json: string | null): ProcOutcome | null {
  if (!json) return null;
  const envelope = parseEnvelopeJson(json);
  if (envelope) {
    if (envelope.ok && isObject(envelope.result)) {
      return envelope.result as ProcOutcome;
    }
    if (!envelope.ok) {
      return {
        status:
          envelope.error.code === "proc_cannot_execute"
            ? "cannot_execute"
            : "failed",
        error: envelope.error.message,
        ...(isObject(envelope.error.details)
          ? (envelope.error.details as ProcOutcome)
          : {}),
      };
    }
  }
  return parseObject(json) as ProcOutcome | null;
}

function parseObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    let value: unknown = JSON.parse(json);
    if (typeof value === "string") value = JSON.parse(value);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
