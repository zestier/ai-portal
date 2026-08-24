import { toolCallId as toolCodec } from "$lib/ids";
import type { PortalEvent } from "$lib/types";
import { piChat, resolveModelSelection } from "$lib/server/pi/complete";
import type {
  ExtractorChatMessage,
  ExtractorToolSpec,
} from "$lib/server/memory/extractor";
import type { PiPermissionResolver } from "$lib/server/pi/session";
import {
  deriveToolResultViews,
  type PortalTool,
  type ToolResult,
} from "$lib/server/tools/types";
import { executeDelegatedTool } from "./delegated-tool";
import {
  createArtifact,
  updateTransaction,
  type SemanticTransaction,
} from "./store";

const MAX_TURNS = 12;
const COMPLETE = "semantic_complete";
const ESCALATE = "semantic_escalate";

// Stable by design: dynamic ids, paths, and intents belong in user messages so
// providers can cache this system/tool prefix across semantic transactions.
export const SEMANTIC_WORKER_SYSTEM = `You are a semantic tool executor. Satisfy one bounded intent by operating repository tools.
The frontier owns diagnosis, design, tradeoffs, and product decisions. You own only the mechanics of obtaining or realizing its specified result.
Use tools incrementally. Never guess through consequential ambiguity: call semantic_escalate with the smallest decision the frontier must make.
When the requested result is established and any requested validation is done, call semantic_complete. Do not merely describe completion in prose.
Keep findings factual, compact, and grounded in locations or tool results. Do not start unrelated cleanup or broaden scope.`;

export interface WorkerRunOptions {
  transaction: SemanticTransaction;
  capabilities: ReadonlyMap<string, PortalTool>;
  permissionResolver: PiPermissionResolver;
  emit: (event: PortalEvent) => void;
  signal: AbortSignal;
}

export interface WorkerOutcome {
  status: "completed" | "decision_required" | "failed";
  summary: string;
  transactionId: string;
  evidenceId?: string;
  changesetId?: string;
  traceId: string;
  outputId?: string;
  pending?: unknown;
  usage: SemanticTransaction["usage"];
}

interface TraceEntry {
  tool: string;
  args: unknown;
  ok: boolean;
  summary: string;
  result?: unknown;
}

export async function runSemanticWorker(
  opts: WorkerRunOptions,
): Promise<WorkerOutcome> {
  const { transaction } = opts;
  const trace: TraceEntry[] = [];
  const changes: unknown[] = [];
  const evidence: unknown[] = [];
  const specs = workerToolSpecs(opts.capabilities);
  const { model, runtime } = await resolveModelSelection(
    transaction.workerModel,
  );

  opts.emit({
    type: "subagent.lifecycle",
    toolCallId: toolCodec.encode(transaction.parentToolCallId),
    agentId: transaction.id,
    status: "running",
  });

  try {
    for (let iteration = 0; iteration < MAX_TURNS; iteration++) {
      if (opts.signal.aborted) throw new Error("Semantic transaction aborted.");
      const turn = await piChat(
        { model, runtime, timeoutMs: 120_000 },
        transaction.messages,
        specs,
        undefined,
        opts.signal,
      );
      transaction.usage.turns++;
      if (turn.usage) {
        transaction.usage.input += turn.usage.input;
        transaction.usage.output += turn.usage.output;
        transaction.usage.cacheRead += turn.usage.cacheRead;
        transaction.usage.cacheWrite += turn.usage.cacheWrite;
        transaction.usage.cost += turn.usage.cost;
      }
      transaction.messages.push({
        role: "assistant",
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      if (turn.toolCalls.length === 0) {
        transaction.messages.push({
          role: "user",
          content:
            "Continue using tools. End only by calling semantic_complete or semantic_escalate.",
        });
        updateTransaction(transaction);
        continue;
      }

      for (const call of turn.toolCalls) {
        const args = parseArgs(call.arguments);
        if (call.name === COMPLETE) {
          const completed = completeArgs(args);
          evidence.push(...completed.findings);
          transaction.status = "completed";
          transaction.summary = completed.summary;
          transaction.pending = null;
          const handles = persistArtifacts(
            transaction,
            evidence,
            changes,
            trace,
          );
          updateTransaction(transaction);
          opts.emit({
            type: "subagent.lifecycle",
            toolCallId: toolCodec.encode(transaction.parentToolCallId),
            agentId: transaction.id,
            status: "completed",
          });
          return {
            status: "completed",
            summary: completed.summary,
            transactionId: transaction.id,
            ...handles,
            usage: transaction.usage,
          };
        }
        if (call.name === ESCALATE) {
          const pending = escalationArgs(args);
          transaction.status = "decision_required";
          transaction.pending = pending;
          transaction.summary = pending.question;
          const handles = persistArtifacts(
            transaction,
            evidence,
            changes,
            trace,
          );
          updateTransaction(transaction);
          opts.emit({
            type: "subagent.lifecycle",
            toolCallId: toolCodec.encode(transaction.parentToolCallId),
            agentId: transaction.id,
            status: "completed",
          });
          return {
            status: "decision_required",
            summary: pending.question,
            transactionId: transaction.id,
            pending,
            ...handles,
            usage: transaction.usage,
          };
        }

        const result = await executeDelegatedTool(
          {
            parentToolCallId: transaction.parentToolCallId,
            capabilities: opts.capabilities,
            permissionResolver: opts.permissionResolver,
            emit: opts.emit,
            signal: opts.signal,
          },
          call.name,
          args,
        );
        transaction.usage.primitiveCalls++;
        const summary = result.ok
          ? deriveToolResultViews(result).modelText
          : result.error.message;
        trace.push({
          tool: call.name,
          args,
          ok: result.ok,
          summary: summary.slice(0, 2_000),
          result: result.ok ? result.result : result.error,
        });
        collectResultArtifacts(result, evidence, changes);
        transaction.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: summary,
        });
      }
      updateTransaction(transaction);
    }
    throw new Error(`Semantic worker exceeded its ${MAX_TURNS}-turn budget.`);
  } catch (error) {
    transaction.status = "failed";
    transaction.summary =
      error instanceof Error ? error.message : String(error);
    const handles = persistArtifacts(transaction, evidence, changes, trace);
    updateTransaction(transaction);
    opts.emit({
      type: "subagent.lifecycle",
      toolCallId: toolCodec.encode(transaction.parentToolCallId),
      agentId: transaction.id,
      status: "failed",
    });
    return {
      status: "failed",
      summary: transaction.summary,
      transactionId: transaction.id,
      ...handles,
      usage: transaction.usage,
    };
  }
}

export function initialWorkerMessages(input: {
  intent: string;
  constraints?: string[];
  completion?: string[];
}): ExtractorChatMessage[] {
  return [
    { role: "system", content: SEMANTIC_WORKER_SYSTEM },
    {
      role: "user",
      content: JSON.stringify({
        intent: input.intent,
        constraints: input.constraints ?? [],
        completion: input.completion ?? [],
      }),
    },
  ];
}

function workerToolSpecs(
  capabilities: ReadonlyMap<string, PortalTool>,
): ExtractorToolSpec[] {
  const specs: ExtractorToolSpec[] = [];
  for (const tool of capabilities.values()) {
    if (isWorkerExcluded(tool.name)) continue;
    specs.push({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    });
  }
  specs.push({
    type: "function",
    function: {
      name: COMPLETE,
      description: "Finish the bounded intent with grounded findings.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          findings: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "findings"],
        additionalProperties: false,
      },
    },
  });
  specs.push({
    type: "function",
    function: {
      name: ESCALATE,
      description:
        "Suspend when the frontier must make a consequential decision.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question", "options"],
        additionalProperties: false,
      },
    },
  });
  return specs;
}

function collectResultArtifacts(
  result: ToolResult,
  evidence: unknown[],
  changes: unknown[],
): void {
  if (!result.ok) return;
  if (isRecord(result.result) && "filePath" in result.result) {
    changes.push(result.result);
  } else if (result.result !== undefined) {
    evidence.push(result.result);
  }
}

function persistArtifacts(
  transaction: SemanticTransaction,
  evidence: unknown[],
  changes: unknown[],
  trace: TraceEntry[],
): {
  evidenceId?: string;
  changesetId?: string;
  traceId: string;
  outputId?: string;
} {
  const traceId = createArtifact({
    transactionId: transaction.id,
    conversationId: transaction.conversationId,
    kind: "trace",
    content: trace,
  });
  const evidenceId = evidence.length
    ? createArtifact({
        transactionId: transaction.id,
        conversationId: transaction.conversationId,
        kind: "evidence",
        content: evidence,
      })
    : undefined;
  const changesetId = changes.length
    ? createArtifact({
        transactionId: transaction.id,
        conversationId: transaction.conversationId,
        kind: "changeset",
        content: changes,
      })
    : undefined;
  const outputs = trace
    .filter((entry) => entry.result !== undefined)
    .map((entry) => ({ tool: entry.tool, result: entry.result }));
  const outputId = outputs.length
    ? createArtifact({
        transactionId: transaction.id,
        conversationId: transaction.conversationId,
        kind: "output",
        content: outputs,
      })
    : undefined;
  return {
    traceId,
    ...(evidenceId ? { evidenceId } : {}),
    ...(changesetId ? { changesetId } : {}),
    ...(outputId ? { outputId } : {}),
  };
}

function completeArgs(args: unknown): { summary: string; findings: string[] } {
  if (!isRecord(args) || typeof args.summary !== "string") {
    throw new Error("semantic_complete requires a summary.");
  }
  return {
    summary: args.summary.slice(0, 2_000),
    findings: Array.isArray(args.findings)
      ? args.findings.filter((item): item is string => typeof item === "string")
      : [],
  };
}

function escalationArgs(args: unknown): {
  question: string;
  options: string[];
} {
  if (!isRecord(args) || typeof args.question !== "string") {
    throw new Error("semantic_escalate requires a question.");
  }
  return {
    question: args.question.slice(0, 2_000),
    options: Array.isArray(args.options)
      ? args.options
          .filter((item): item is string => typeof item === "string")
          .slice(0, 8)
      : [],
  };
}

function parseArgs(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { _invalidJson: raw };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWorkerExcluded(name: string): boolean {
  return (
    name === "ask_user" ||
    name === "request_permission_grant" ||
    name === "force_retry_tool" ||
    name === "permission_capabilities"
  );
}
