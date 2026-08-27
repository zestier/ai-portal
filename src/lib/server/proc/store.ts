import { getDb } from "$lib/server/db";
import { ulid } from "$lib/server/db/ids";
import type { ExtractorChatMessage } from "$lib/server/memory/extractor";

export type ProcStatus = "running" | "completed" | "cannot_execute" | "failed";
export type ProcProjectionMode = "none" | "shape" | "exact";

export interface ProcOutputPolicy {
  mode: ProcProjectionMode;
  maxBytes?: number;
  store: boolean;
}

export interface ProcUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  atoms: number;
  operations: number;
}

export interface ProcTransaction {
  id: string;
  conversationId: number;
  parentToolCallId: number;
  workerModel: string;
  status: ProcStatus;
  summary: string;
  contract: string;
  procedure: string;
  outputPolicy: ProcOutputPolicy;
  messages: ExtractorChatMessage[];
  resultId: string | null;
  error: string | null;
  usage: ProcUsage;
  createdAt: number;
  updatedAt: number;
}

const EMPTY_USAGE: ProcUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  atoms: 0,
  operations: 0,
};

export function createProcTransaction(input: {
  conversationId: number;
  parentToolCallId: number;
  workerModel: string;
  summary: string;
  contract: string;
  procedure: string;
  outputPolicy: ProcOutputPolicy;
  messages: ExtractorChatMessage[];
}): ProcTransaction {
  const now = Date.now();
  const transaction: ProcTransaction = {
    id: `PTX_${ulid()}`,
    conversationId: input.conversationId,
    parentToolCallId: input.parentToolCallId,
    workerModel: input.workerModel,
    status: "running",
    summary: input.summary,
    contract: input.contract,
    procedure: input.procedure,
    outputPolicy: input.outputPolicy,
    messages: input.messages,
    resultId: null,
    error: null,
    usage: { ...EMPTY_USAGE },
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO proc_transactions(
         id, conversation_id, parent_tool_call_id, worker_model, status,
         summary, contract_text, procedure_text, output_json, messages_json,
         result_id, error, usage_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      transaction.id,
      transaction.conversationId,
      transaction.parentToolCallId,
      transaction.workerModel,
      transaction.status,
      transaction.summary,
      transaction.contract,
      transaction.procedure,
      JSON.stringify(transaction.outputPolicy),
      JSON.stringify(transaction.messages),
      JSON.stringify(transaction.usage),
      now,
      now,
    );
  return transaction;
}

export function updateProcTransaction(transaction: ProcTransaction): void {
  transaction.updatedAt = Date.now();
  getDb()
    .prepare(
      `UPDATE proc_transactions
          SET status = ?, messages_json = ?, result_id = ?, error = ?,
              usage_json = ?, updated_at = ?
        WHERE id = ? AND conversation_id = ?`,
    )
    .run(
      transaction.status,
      JSON.stringify(transaction.messages),
      transaction.resultId,
      transaction.error,
      JSON.stringify(transaction.usage),
      transaction.updatedAt,
      transaction.id,
      transaction.conversationId,
    );
}

export function getProcTransaction(
  id: string,
  conversationId: number,
): ProcTransaction | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM proc_transactions WHERE id = ? AND conversation_id = ?`,
    )
    .get(id, conversationId) as ProcTransactionRow | undefined;
  return row ? transactionOf(row) : null;
}

export function createProcResult(input: {
  transactionId: string;
  conversationId: number;
  value: unknown;
}): { id: string; bytes: number } {
  const valueJson = JSON.stringify(input.value);
  if (valueJson === undefined)
    throw new Error("Proc result must be JSON-compatible.");
  const bytes = Buffer.byteLength(valueJson);
  const id = `RES_${ulid()}`;
  getDb()
    .prepare(
      `INSERT INTO proc_results(
         id, transaction_id, conversation_id, value_json, bytes, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.transactionId,
      input.conversationId,
      valueJson,
      bytes,
      Date.now(),
    );
  return { id, bytes };
}

export function getProcResult(input: {
  id: string;
  transactionId: string;
  conversationId: number;
}): { value: unknown; bytes: number } | null {
  const row = getDb()
    .prepare(
      `SELECT value_json, bytes FROM proc_results
        WHERE id = ? AND transaction_id = ? AND conversation_id = ?`,
    )
    .get(input.id, input.transactionId, input.conversationId) as
    { value_json: string; bytes: number } | undefined;
  return row ? { value: JSON.parse(row.value_json), bytes: row.bytes } : null;
}

export function getProcState(
  transactionId: string,
  conversationId: number,
): Map<string, unknown> {
  const rows = getDb()
    .prepare(
      `SELECT id, value_json FROM proc_results
        WHERE transaction_id = ? AND conversation_id = ?
        ORDER BY created_at, id`,
    )
    .all(transactionId, conversationId) as Array<{
    id: string;
    value_json: string;
  }>;
  return new Map(rows.map((row) => [row.id, JSON.parse(row.value_json)]));
}

export function deleteProcResult(input: {
  id: string;
  transactionId: string;
  conversationId: number;
}): void {
  getDb()
    .prepare(
      `DELETE FROM proc_results
        WHERE id = ? AND transaction_id = ? AND conversation_id = ?`,
    )
    .run(input.id, input.transactionId, input.conversationId);
}

interface ProcTransactionRow {
  id: string;
  conversation_id: number;
  parent_tool_call_id: number;
  worker_model: string;
  status: ProcStatus;
  summary: string;
  contract_text: string;
  procedure_text: string;
  output_json: string;
  messages_json: string;
  result_id: string | null;
  error: string | null;
  usage_json: string;
  created_at: number;
  updated_at: number;
}

function transactionOf(row: ProcTransactionRow): ProcTransaction {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentToolCallId: row.parent_tool_call_id,
    workerModel: row.worker_model,
    status: row.status,
    summary: row.summary,
    contract: row.contract_text,
    procedure: row.procedure_text,
    outputPolicy: JSON.parse(row.output_json) as ProcOutputPolicy,
    messages: JSON.parse(row.messages_json) as ExtractorChatMessage[],
    resultId: row.result_id,
    error: row.error,
    usage: {
      ...EMPTY_USAGE,
      ...(JSON.parse(row.usage_json) as Partial<ProcUsage>),
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
