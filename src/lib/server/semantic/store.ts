import { getDb } from "$lib/server/db";
import { ulid } from "$lib/server/db/ids";
import type { ExtractorChatMessage } from "$lib/server/memory/extractor";

export type TransactionStatus =
  "running" | "decision_required" | "completed" | "failed";
export type ArtifactKind = "evidence" | "changeset" | "trace" | "output";

export interface SemanticUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  primitiveCalls: number;
}

export interface SemanticTransaction {
  id: string;
  conversationId: number;
  parentToolCallId: number;
  workerModel: string;
  status: TransactionStatus;
  intent: string;
  messages: ExtractorChatMessage[];
  pending: unknown | null;
  summary: string | null;
  usage: SemanticUsage;
  createdAt: number;
  updatedAt: number;
}

const EMPTY_USAGE: SemanticUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  primitiveCalls: 0,
};

export function createTransaction(input: {
  conversationId: number;
  parentToolCallId: number;
  workerModel: string;
  intent: string;
  messages: ExtractorChatMessage[];
}): SemanticTransaction {
  const now = Date.now();
  const transaction: SemanticTransaction = {
    id: `STX_${ulid()}`,
    conversationId: input.conversationId,
    parentToolCallId: input.parentToolCallId,
    workerModel: input.workerModel,
    status: "running",
    intent: input.intent,
    messages: input.messages,
    pending: null,
    summary: null,
    usage: { ...EMPTY_USAGE },
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO semantic_transactions(
         id, conversation_id, parent_tool_call_id, worker_model, status,
         intent, messages_json, pending_json, summary, usage_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      transaction.id,
      transaction.conversationId,
      transaction.parentToolCallId,
      transaction.workerModel,
      transaction.status,
      transaction.intent,
      JSON.stringify(transaction.messages),
      JSON.stringify(transaction.usage),
      now,
      now,
    );
  return transaction;
}

export function getTransaction(
  id: string,
  conversationId: number,
): SemanticTransaction | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM semantic_transactions
        WHERE id = ? AND conversation_id = ?`,
    )
    .get(id, conversationId) as TransactionRow | undefined;
  return row ? transactionOf(row) : null;
}

export function updateTransaction(transaction: SemanticTransaction): void {
  transaction.updatedAt = Date.now();
  getDb()
    .prepare(
      `UPDATE semantic_transactions
          SET parent_tool_call_id = ?, status = ?, messages_json = ?,
            pending_json = ?, summary = ?, usage_json = ?, updated_at = ?
        WHERE id = ? AND conversation_id = ?`,
    )
    .run(
      transaction.parentToolCallId,
      transaction.status,
      JSON.stringify(transaction.messages),
      transaction.pending === null ? null : JSON.stringify(transaction.pending),
      transaction.summary,
      JSON.stringify(transaction.usage),
      transaction.updatedAt,
      transaction.id,
      transaction.conversationId,
    );
}

export function createArtifact(input: {
  transactionId: string;
  conversationId: number;
  kind: ArtifactKind;
  content: unknown;
}): string {
  const id = `${artifactPrefix(input.kind)}_${ulid()}`;
  getDb()
    .prepare(
      `INSERT INTO semantic_artifacts(
         id, transaction_id, conversation_id, kind, content, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.transactionId,
      input.conversationId,
      input.kind,
      typeof input.content === "string"
        ? input.content
        : JSON.stringify(input.content),
      Date.now(),
    );
  return id;
}

export function readArtifact(input: {
  id: string;
  conversationId: number;
  kind: ArtifactKind;
  offset?: number;
  limit?: number;
}): { content: string; nextOffset: number | null; totalBytes: number } | null {
  const row = getDb()
    .prepare(
      `SELECT content FROM semantic_artifacts
        WHERE id = ? AND conversation_id = ? AND kind = ?`,
    )
    .get(input.id, input.conversationId, input.kind) as
    { content: string } | undefined;
  if (!row) return null;
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(32_768, Math.max(256, input.limit ?? 8_192));
  const content = row.content.slice(offset, offset + limit);
  const nextOffset = offset + content.length;
  return {
    content,
    nextOffset: nextOffset < row.content.length ? nextOffset : null,
    totalBytes: row.content.length,
  };
}

interface TransactionRow {
  id: string;
  conversation_id: number;
  parent_tool_call_id: number;
  worker_model: string;
  status: TransactionStatus;
  intent: string;
  messages_json: string;
  pending_json: string | null;
  summary: string | null;
  usage_json: string;
  created_at: number;
  updated_at: number;
}

function transactionOf(row: TransactionRow): SemanticTransaction {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentToolCallId: row.parent_tool_call_id,
    workerModel: row.worker_model,
    status: row.status,
    intent: row.intent,
    messages: parseJson(row.messages_json, []),
    pending: row.pending_json ? parseJson(row.pending_json, null) : null,
    summary: row.summary,
    usage: { ...EMPTY_USAGE, ...parseJson(row.usage_json, {}) },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function artifactPrefix(kind: ArtifactKind): string {
  switch (kind) {
    case "evidence":
      return "EVD";
    case "changeset":
      return "CHG";
    case "trace":
      return "TRC";
    case "output":
      return "OUT";
  }
}
