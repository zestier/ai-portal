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
  executions: number;
  operations: number;
  savedValuesCreated: number;
  savedValuesLoaded: number;
  consoleAttempts: number;
  nonProgressExecutions: number;
  views: number;
  viewBytes: number;
}

export interface ProcTransaction {
  id: string;
  conversationId: number;
  parentToolCallId: number;
  workerModel: string;
  status: ProcStatus;
  summary: string;
  requirements: string;
  procedure: string;
  outputPolicy: ProcOutputPolicy;
  messages: ExtractorChatMessage[];
  resultId: string | null;
  error: string | null;
  usage: ProcUsage;
  createdAt: number;
  updatedAt: number;
}

export interface ProcStoreBinding {
  name: string;
  toolCallId: number;
  resultId: string;
  bytes: number;
}

export interface ProcStoreSnapshotEntry {
  toolCallId: number;
  resultId: string;
}

const EMPTY_USAGE: ProcUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  executions: 0,
  operations: 0,
  savedValuesCreated: 0,
  savedValuesLoaded: 0,
  consoleAttempts: 0,
  nonProgressExecutions: 0,
  views: 0,
  viewBytes: 0,
};

export function createProcTransaction(input: {
  conversationId: number;
  parentToolCallId: number;
  workerModel: string;
  summary: string;
  requirements: string;
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
    requirements: input.requirements,
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
      transaction.requirements,
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
    throw new Error("Saved value: JSON-compatible data required.");
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

export function createNamedProcResult(input: {
  transactionId: string;
  conversationId: number;
  name: string;
  value: unknown;
}): { id: string; bytes: number } {
  const valueJson = JSON.stringify(input.value);
  if (valueJson === undefined)
    throw new Error("Saved value: JSON-compatible data required.");
  const bytes = Buffer.byteLength(valueJson);
  const id = namedResultId(input.transactionId, input.name);
  try {
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
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
      throw new Error(`Saved value name already exists: ${input.name}`, {
        cause: error,
      });
    }
    throw error;
  }
  return { id: input.name, bytes };
}

export function commitProcStoreWrites(input: {
  transactionId: string;
  conversationId: number;
  toolCallId: number;
  writes: Record<string, unknown>;
}): {
  toolCallId: number;
  bindings: ProcStoreBinding[];
  snapshot: Record<string, ProcStoreSnapshotEntry>;
} {
  return getDb().transaction(() => {
    const entries = Object.entries(input.writes).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    if (entries.length === 0) {
      return {
        toolCallId: input.toolCallId,
        bindings: [],
        snapshot: getProcStoreSnapshot({
          transactionId: input.transactionId,
          conversationId: input.conversationId,
          atToolCallId: input.toolCallId,
        }),
      };
    }

    const now = Date.now();
    const insertResult = getDb().prepare(
      `INSERT INTO proc_results(
         id, transaction_id, conversation_id, value_json, bytes, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertBinding = getDb().prepare(
      `INSERT INTO proc_store_bindings(
         transaction_id, tool_call_id, name, result_id, created_at
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const bindings = entries.map(([name, value]) => {
      const valueJson = JSON.stringify(value);
      if (valueJson === undefined) {
        throw new Error(`store.${name}: JSON-compatible data required.`);
      }
      const bytes = Buffer.byteLength(valueJson);
      const resultId = `RES_${ulid()}`;
      insertResult.run(
        resultId,
        input.transactionId,
        input.conversationId,
        valueJson,
        bytes,
        now,
      );
      insertBinding.run(
        input.transactionId,
        input.toolCallId,
        name,
        resultId,
        now,
      );
      return { name, toolCallId: input.toolCallId, resultId, bytes };
    });
    return {
      toolCallId: input.toolCallId,
      bindings,
      snapshot: getProcStoreSnapshot({
        transactionId: input.transactionId,
        conversationId: input.conversationId,
        atToolCallId: input.toolCallId,
      }),
    };
  })();
}

export function getProcStoreSnapshot(input: {
  transactionId: string;
  conversationId: number;
  atToolCallId?: number;
}): Record<string, ProcStoreSnapshotEntry> {
  const atToolCallId = input.atToolCallId ?? Number.MAX_SAFE_INTEGER;
  const rows = getDb()
    .prepare(
      `SELECT b.name, b.tool_call_id, b.result_id
         FROM proc_store_bindings b
         JOIN proc_results r ON r.id = b.result_id
        WHERE b.transaction_id = ? AND b.tool_call_id <= ?
          AND r.conversation_id = ?
        ORDER BY b.name, b.tool_call_id DESC`,
    )
    .all(input.transactionId, atToolCallId, input.conversationId) as Array<{
    name: string;
    tool_call_id: number;
    result_id: string;
  }>;
  const snapshot: Record<string, ProcStoreSnapshotEntry> = {};
  for (const row of rows) {
    if (snapshot[row.name] === undefined) {
      snapshot[row.name] = {
        toolCallId: row.tool_call_id,
        resultId: row.result_id,
      };
    }
  }
  return snapshot;
}

export function getProcResult(input: {
  id: string;
  transactionId: string;
  conversationId: number;
}): { value: unknown; bytes: number } | null {
  return findProcResult(input.id, input.transactionId, input.conversationId);
}

export function getNamedProcResult(input: {
  name: string;
  transactionId: string;
  conversationId: number;
}): { value: unknown; bytes: number } | null {
  return findProcResult(
    namedResultId(input.transactionId, input.name),
    input.transactionId,
    input.conversationId,
  );
}

function findProcResult(
  id: string,
  transactionId: string,
  conversationId: number,
): { value: unknown; bytes: number } | null {
  const row = getDb()
    .prepare(
      `SELECT value_json, bytes FROM proc_results
        WHERE id = ? AND transaction_id = ? AND conversation_id = ?`,
    )
    .get(id, transactionId, conversationId) as
    { value_json: string; bytes: number } | undefined;
  return row ? { value: JSON.parse(row.value_json), bytes: row.bytes } : null;
}

export function createProcValueReader(
  transactionId: string,
  conversationId: number,
): { get(id: string): unknown | undefined } {
  const query = getDb().prepare(
    `SELECT r.value_json FROM proc_results r
       JOIN proc_transactions t ON t.id = r.transaction_id
      WHERE r.id = ? AND r.transaction_id = ? AND r.conversation_id = ?
        AND t.status = 'running'`,
  );
  const latestBinding = getDb().prepare(
    `SELECT r.value_json FROM proc_store_bindings b
       JOIN proc_results r ON r.id = b.result_id
       JOIN proc_transactions t ON t.id = b.transaction_id
      WHERE b.transaction_id = ? AND b.name = ?
        AND r.conversation_id = ? AND t.status = 'running'
      ORDER BY b.tool_call_id DESC LIMIT 1`,
  );
  return {
    get(id: string): unknown | undefined {
      const boundRow = latestBinding.get(transactionId, id, conversationId) as
        { value_json: string } | undefined;
      const namedRow =
        boundRow ??
        (query.get(
          namedResultId(transactionId, id),
          transactionId,
          conversationId,
        ) as { value_json: string } | undefined);
      const row =
        namedRow ??
        (id.startsWith("RES_")
          ? (query.get(id, transactionId, conversationId) as
              { value_json: string } | undefined)
          : undefined);
      return row ? JSON.parse(row.value_json) : undefined;
    },
  };
}

function namedResultId(transactionId: string, name: string): string {
  return `${transactionId}:${name}`;
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
  const storedUsage = JSON.parse(row.usage_json) as Partial<ProcUsage> & {
    atoms?: number;
  };
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentToolCallId: row.parent_tool_call_id,
    workerModel: row.worker_model,
    status: row.status,
    summary: row.summary,
    requirements: row.contract_text,
    procedure: row.procedure_text,
    outputPolicy: JSON.parse(row.output_json) as ProcOutputPolicy,
    messages: JSON.parse(row.messages_json) as ExtractorChatMessage[],
    resultId: row.result_id,
    error: row.error,
    usage: {
      ...EMPTY_USAGE,
      ...storedUsage,
      executions: storedUsage.executions ?? storedUsage.atoms ?? 0,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
