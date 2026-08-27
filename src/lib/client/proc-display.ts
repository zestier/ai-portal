import { parseEnvelopeJson } from "$lib/tool-result-views";

export interface ProcArgs {
  summary: string;
  procedure: string;
  output: { contract: string; max_bytes: number };
}

export interface ProcExecutionArgs {
  summary: string;
  javascript: string;
  purpose: "checkpoint" | "inspect" | "final";
}

export interface ProcExecutionResult {
  purpose?: "checkpoint" | "inspect" | "final";
  result_id?: string;
  bytes?: number;
  projection?: unknown;
  projection_bytes?: number;
  operations?: number;
  effects?: Array<{ tool: string; effect: string; ok: boolean }>;
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
    !isObject(value.output) ||
    typeof value.output.contract !== "string" ||
    typeof value.output.max_bytes !== "number"
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
  if (
    !isObject(value) ||
    typeof value.summary !== "string" ||
    typeof value.javascript !== "string" ||
    !["checkpoint", "inspect", "final"].includes(String(value.purpose))
  ) {
    return null;
  }
  return value as unknown as ProcExecutionArgs;
}

export function parseProcExecutionResult(
  json: string | null,
): ProcExecutionResult | null {
  return parseObject(json) as ProcExecutionResult | null;
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
