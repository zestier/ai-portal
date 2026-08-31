import { parseEnvelopeJson } from "$lib/tool-result-views";

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
  const hasExecutionMetadata =
    value.needed_for !== undefined ||
    value.store_into !== undefined ||
    value.max_bytes !== undefined ||
    value.save_as !== undefined ||
    value.worker_view !== undefined ||
    value.worker_view_max_bytes !== undefined ||
    value.view !== undefined;
  const hasDestination =
    value.store_into !== undefined ||
    value.save_as !== undefined ||
    value.max_bytes !== undefined;
  if (
    (hasExecutionMetadata &&
      (typeof value.needed_for !== "string" || !hasDestination)) ||
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
