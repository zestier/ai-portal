import { z } from "zod";
import { toolCallId as toolCodec } from "$lib/ids";
import type { PortalEvent } from "$lib/types";
import { log } from "$lib/server/log";
import { mintToolCallId } from "$lib/server/db/repos/messages";
import { piChat, resolveModelSelection } from "$lib/server/pi/complete";
import type {
  ExtractorChatMessage,
  ExtractorToolSpec,
} from "$lib/server/memory/extractor";
import type { PiPermissionResolver } from "$lib/server/pi/session";
import type { PortalTool } from "$lib/server/tools/types";
import { executeDelegatedTool } from "$lib/server/semantic/delegated-tool";
import { runProgram } from "$lib/server/ptc/program";
import { normalizeProgramToolArgs } from "$lib/server/ptc/contracts";
import { projectProcValue } from "./projection";
import {
  createProcResult,
  deleteProcResults,
  createProcValueReader,
  updateProcTransaction,
  type ProcOutputPolicy,
  type ProcTransaction,
} from "./store";

const MAX_TURNS = 100;
const EXECUTE = "execute";
const CANNOT_EXECUTE = "cannot_execute";
const CHECKPOINT_SHAPE_BYTES = 2 * 1024;
const INSPECTION_BYTES = 12 * 1024;
const MAX_TRANSCRIPT_BYTES = 128 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 96 * 1024;
const MAX_WORKER_OUTPUT_TOKENS = 32 * 1024;

const ExecuteArgs = z
  .object({
    summary: z.string().min(1).max(500),
    javascript: z.string().min(1).max(20_000),
    result_for: z.enum([
      "no_one",
      "later_javascript",
      "worker_context",
      "proc_result",
    ]),
  })
  .strict();

const CannotExecuteArgs = z
  .object({ reason: z.string().min(1).max(4_000) })
  .strict();

export const PROC_WORKER_SYSTEM = `Execute the supplied procedure without changing it. Do not add goals, broaden scope, change selection criteria, choose another method, or make consequential decisions.
Fuse adjacent mechanical steps into the largest reliable execute call; procedure steps are not turn boundaries. Keep mechanical intermediate values inside JavaScript.
Keep data in JavaScript. Use worker_context only when required semantic judgment cannot be expressed as data operations.
Internal reads stay out of your context. Return only requested, bounded data; do not return complete files unless result_requirements requires that exact value.
Treat result_requirements as the completion test. Use proc_result only when the returned value satisfies every requirement and max_result_bytes. A probe, candidate set, or partial result is not final.
Repair syntax, capability arguments, batching, and other mechanical failures. If the procedure lacks a consequential instruction, call cannot_execute with the smallest missing instruction.
Call exactly one tool per turn. Finish only with proc_result or cannot_execute. Use brief, user-facing summaries.`;

export interface ProcWorkerOptions {
  transaction: ProcTransaction;
  capabilities: ReadonlyMap<string, PortalTool>;
  facadeCapabilities: ReadonlyMap<string, PortalTool>;
  permissionResolver: PiPermissionResolver;
  emit: (event: PortalEvent) => void;
  signal: AbortSignal;
}

export interface ProcWorkerOutcome {
  status: "completed" | "cannot_execute" | "failed";
  summary: string;
  transactionId: string;
  resultId?: string;
  stored?: boolean;
  bytes?: number;
  projection?: unknown;
  projectionBytes?: number;
  truncated?: boolean;
  usage: ProcTransaction["usage"];
}

export function initialProcMessages(input: {
  summary: string;
  requirements: string;
  procedure: string;
  outputPolicy: ProcOutputPolicy;
  contracts: Array<Record<string, unknown>>;
}): ExtractorChatMessage[] {
  return [
    { role: "system", content: PROC_WORKER_SYSTEM },
    {
      role: "user",
      content: JSON.stringify({
        summary: input.summary,
        procedure: input.procedure,
        result_requirements: input.requirements,
        max_result_bytes: input.outputPolicy.maxBytes,
        environment: {
          tools: input.contracts,
          globals: {
            loadValue: "loadValue(valueId): immutable saved JSON value",
            fs: [
              'readFile(path, "utf8")',
              "writeFile(path, text)",
              "stat(path): { size, mtimeMs, isFile(), isDirectory(), isSymbolicLink() }",
              "exists(path)",
              "readLines(path, { start?, end? }): { text, start, end, totalLines } // 1-based, inclusive",
              "mkdir(path) // recursive and idempotent",
              "rename(from, to) // overwrites files",
              "copyFile(from, to) // UTF8 text only",
              "rm(path, { recursive?, force? }) // reversible trash",
              "unlink(path) // reversible trash",
              "glob(pattern: string | string[], { path?, maxDepth?, includeIgnored? }): string[] // workspace-relative; ripgrep rules",
              "grep(pattern: string, { path?, glob?: string | string[], caseInsensitive?, includeIgnored? }): { path, line, column, text }[] // workspace-relative; 1-based positions; ripgrep rules",
            ],
            path: [
              "join(...paths)",
              "dirname(path)",
              "basename(path, suffix?)",
              "extname(path)",
              "normalize(path)",
              "relative(from, to)",
              "isAbsolute(path)",
            ],
            git: [
              "status(): { head, merge, changes: { path, previousPath, index, worktree }[] } // branch/upstream, active operation/conflicts, staged/worktree status",
              "diff({ target?, sha?, path? }): { patch, files: { path, previousPath, status, added, removed, binary }[], truncated } // unified diff plus per-file line counts",
              "log({ limit?, skip?, ref?, path? }): { sha, shortSha, author, email, timestamp, subject }[] // commit summaries",
              "show(ref, { includePatch? }): { sha, shortSha, author, email, timestamp, subject, body, parents, files: { status, path, origPath }[], patch? } // commit details",
              "show(ref, path): string // file contents at ref",
              "blame(path, { startLine?, endLine? }): { sha, line, author, email, timestamp, summary, text }[]",
            ],
            command:
              "command.run(executable, args?, { cwd?, stdin?, timeoutMs? }): { status, stdout, stderr }",
          },
        },
      }),
    },
  ];
}

export async function runProcWorker(
  opts: ProcWorkerOptions,
): Promise<ProcWorkerOutcome> {
  const { transaction } = opts;
  const executableCapabilities = new Map([
    ...opts.capabilities,
    ...opts.facadeCapabilities,
  ]);
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
      if (opts.signal.aborted) throw new Error("Proc transaction aborted.");
      const transcript = procTranscriptStats(transaction.messages);
      if (transcript.bytes > MAX_TRANSCRIPT_BYTES) {
        log.warn("proc.worker.transcript_limit", {
          transactionId: transaction.id,
          ...transcript,
          limitBytes: MAX_TRANSCRIPT_BYTES,
        });
        throw new Error(
          `Proc worker transcript reached ${transcript.bytes} bytes (limit ${MAX_TRANSCRIPT_BYTES}); largest message is ${transcript.largestMessageBytes} bytes at index ${transcript.largestMessageIndex}. Start a new, more tightly projected proc call.`,
        );
      }
      const turn = await piChat(
        {
          model,
          runtime,
          timeoutMs: 120_000,
          maxTokens: MAX_WORKER_OUTPUT_TOKENS,
        },
        transaction.messages,
        workerToolSpecs(),
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
      for (const call of turn.toolCalls) {
        const argumentBytes = Buffer.byteLength(call.arguments);
        if (argumentBytes > MAX_TOOL_ARGUMENT_BYTES) {
          log.warn("proc.worker.tool_arguments_limit", {
            transactionId: transaction.id,
            tool: call.name,
            argumentBytes,
            limitBytes: MAX_TOOL_ARGUMENT_BYTES,
          });
          throw new Error(
            `Proc worker produced ${argumentBytes} bytes of arguments for ${call.name} (limit ${MAX_TOOL_ARGUMENT_BYTES}); the call was not retained or executed.`,
          );
        }
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
          content: "Call execute or cannot_execute now.",
        });
        updateProcTransaction(transaction);
        continue;
      }

      for (const call of turn.toolCalls) {
        const raw = parseArgs(call.arguments);
        const protocolId = toolCodec.encode(mintToolCallId());
        const procId = toolCodec.encode(transaction.parentToolCallId);
        const effects: ExecutionEffect[] = [];
        let retainedResult: { id: string; bytes: number } | null = null;
        opts.emit({
          type: "tool.call",
          toolCallId: protocolId,
          tool: call.name,
          args: raw,
          parentToolCallId: procId,
        });
        try {
          if (call.name === EXECUTE) {
            const args = ExecuteArgs.parse(raw);
            transaction.usage.executions++;
            const result = await runProgram({
              source: args.javascript,
              ...(args.result_for === "no_one"
                ? { resultMode: "discard" as const }
                : {}),
              capabilities: opts.capabilities,
              facadeCapabilities: opts.facadeCapabilities,
              savedValues: createProcValueReader(
                transaction.id,
                transaction.conversationId,
              ),
              execute: (name, callArgs, signal) => {
                const tool = executableCapabilities.get(name);
                const normalized = tool
                  ? normalizeProgramToolArgs(tool, callArgs)
                  : callArgs;
                const effect = executionEffect(name, normalized, tool);
                return executeDelegatedTool(
                  {
                    parentToolCallId: toolCodec.parse(protocolId),
                    capabilities: executableCapabilities,
                    permissionResolver: opts.permissionResolver,
                    emit: opts.emit,
                    signal,
                  },
                  name,
                  normalized,
                ).then((result) => {
                  effects.push({ tool: name, effect, ok: result.ok });
                  return result;
                });
              },
              signal: opts.signal,
            });
            transaction.usage.operations += result.operations;
            if (args.result_for === "proc_result") {
              const projection = projectProcValue(
                result.value,
                transaction.outputPolicy,
              );
              const stored = transaction.outputPolicy.store
                ? createProcResult({
                    transactionId: transaction.id,
                    conversationId: transaction.conversationId,
                    value: result.value,
                  })
                : null;
              transaction.status = "completed";
              transaction.resultId = stored?.id ?? null;
              if (!transaction.outputPolicy.store) {
                deleteProcResults(transaction.id, transaction.conversationId);
              }
              updateProcTransaction(transaction);
              emitProtocolResult(
                opts.emit,
                protocolId,
                procId,
                true,
                JSON.stringify({
                  result_for: "proc_result",
                  status: "completed",
                  bytes:
                    stored?.bytes ??
                    Buffer.byteLength(JSON.stringify(result.value)),
                  operations: result.operations,
                }),
              );
              emitCompleted(opts, transaction);
              return {
                status: "completed",
                summary: transaction.summary,
                transactionId: transaction.id,
                ...(stored ? { resultId: stored.id } : {}),
                stored: transaction.outputPolicy.store,
                bytes:
                  stored?.bytes ??
                  Buffer.byteLength(JSON.stringify(result.value)),
                ...(projection.projection !== undefined
                  ? { projection: projection.projection }
                  : {}),
                projectionBytes: projection.projectionBytes,
                truncated: projection.truncated,
                usage: transaction.usage,
              };
            }
            const effectSummary = summarizeExecutionEffects(effects);
            if (args.result_for === "no_one") {
              recordExecutionFeedback(
                opts.emit,
                transaction,
                call.id,
                protocolId,
                procId,
                true,
                {
                  result_for: "no_one",
                  operations: result.operations,
                  effects: effectSummary,
                  effects_total: effects.length,
                },
              );
              continue;
            }
            const policy: ProcOutputPolicy =
              args.result_for === "worker_context"
                ? {
                    mode: "exact",
                    maxBytes: INSPECTION_BYTES,
                    store: true,
                  }
                : {
                    mode: "shape",
                    maxBytes: CHECKPOINT_SHAPE_BYTES,
                    store: true,
                  };
            retainedResult = createProcResult({
              transactionId: transaction.id,
              conversationId: transaction.conversationId,
              value: result.value,
            });
            const projection = projectProcValue(result.value, policy);
            const feedback = {
              result_for: args.result_for,
              value_id: retainedResult.id,
              value_bytes: retainedResult.bytes,
              ...(args.result_for === "later_javascript"
                ? {
                    structure: projection.projection,
                    structure_bytes: projection.projectionBytes,
                  }
                : {
                    bounded_value: projection.projection,
                    bounded_value_bytes: projection.projectionBytes,
                  }),
              truncated: projection.truncated,
              operations: result.operations,
              effects: effectSummary,
              effects_total: effects.length,
            };
            recordExecutionFeedback(
              opts.emit,
              transaction,
              call.id,
              protocolId,
              procId,
              true,
              feedback,
            );
            continue;
          }
          if (call.name === CANNOT_EXECUTE) {
            const args = CannotExecuteArgs.parse(raw);
            transaction.status = "cannot_execute";
            transaction.error = args.reason;
            deleteProcResults(transaction.id, transaction.conversationId);
            updateProcTransaction(transaction);
            emitProtocolResult(
              opts.emit,
              protocolId,
              procId,
              false,
              JSON.stringify({ reason: args.reason }),
            );
            emitCompleted(opts, transaction);
            return {
              status: "cannot_execute",
              summary: args.reason,
              transactionId: transaction.id,
              usage: transaction.usage,
            };
          }
          throw new Error(`Unknown proc worker tool: ${call.name}`);
        } catch (error) {
          if (opts.signal.aborted) throw error;
          const retrySafe = effects.every((effect) => effect.effect === "read");
          const effectSummary = summarizeExecutionEffects(effects);
          const feedback = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            ...(retainedResult
              ? {
                  value_id: retainedResult.id,
                  value_bytes: retainedResult.bytes,
                }
              : {}),
            effects: effectSummary,
            effects_total: effects.length,
            retry_safe: retrySafe,
            instruction: retrySafe
              ? "Fix and retry, or checkpoint before the failing step. Use cannot_execute only if the procedure itself cannot be realized."
              : "Do not replay: effects may have occurred. Check current repository state and execute only unfinished work; otherwise call cannot_execute.",
          };
          recordExecutionFeedback(
            opts.emit,
            transaction,
            call.id,
            protocolId,
            procId,
            false,
            feedback,
          );
        }
      }
      updateProcTransaction(transaction);
    }
    throw new Error(`Proc worker exceeded its ${MAX_TURNS}-turn budget.`);
  } catch (error) {
    transaction.status = "failed";
    transaction.error = error instanceof Error ? error.message : String(error);
    deleteProcResults(transaction.id, transaction.conversationId);
    updateProcTransaction(transaction);
    opts.emit({
      type: "subagent.lifecycle",
      toolCallId: toolCodec.encode(transaction.parentToolCallId),
      agentId: transaction.id,
      status: "failed",
    });
    return {
      status: "failed",
      summary: transaction.error,
      transactionId: transaction.id,
      usage: transaction.usage,
    };
  }
}

export function procTranscriptStats(messages: ExtractorChatMessage[]): {
  bytes: number;
  largestMessageBytes: number;
  largestMessageIndex: number;
} {
  let largestMessageBytes = 0;
  let largestMessageIndex = -1;
  for (const [index, message] of messages.entries()) {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > largestMessageBytes) {
      largestMessageBytes = bytes;
      largestMessageIndex = index;
    }
  }
  return {
    bytes: Buffer.byteLength(JSON.stringify(messages)),
    largestMessageBytes,
    largestMessageIndex,
  };
}

type ExecutionEffectKind = "read" | "mutation" | "opaque";

interface ExecutionEffect {
  tool: string;
  effect: ExecutionEffectKind;
  ok: boolean;
}

export interface ExecutionEffectSummary extends ExecutionEffect {
  count: number;
}

export function summarizeExecutionEffects(
  effects: ExecutionEffect[],
): ExecutionEffectSummary[] {
  const counts = new Map<string, ExecutionEffectSummary>();
  for (const effect of effects) {
    const key = `${effect.tool}\0${effect.effect}\0${effect.ok}`;
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { ...effect, count: 1 });
  }
  return [...counts.values()].sort(
    (left, right) =>
      right.count - left.count ||
      left.tool.localeCompare(right.tool) ||
      left.effect.localeCompare(right.effect) ||
      Number(left.ok) - Number(right.ok),
  );
}

function executionEffect(
  name: string,
  args: unknown,
  tool: PortalTool | undefined,
): ExecutionEffectKind {
  if (name === "__ptc_command_run") return "opaque";
  try {
    if (tool?.derivePermissionRequest?.(args)?.permissionKind === "read") {
      return "read";
    }
  } catch {
    // Invalid guessed arguments are classified by static metadata below.
  }
  return tool?.program?.operationCategory === "read" ? "read" : "mutation";
}

function workerToolSpecs(): ExtractorToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: EXECUTE,
        description:
          "Execute part or all of the procedure as one JavaScript program.",
        parameters: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "Short label shown to the user.",
            },
            javascript: {
              type: "string",
              description:
                "JavaScript function body. Must return one JSON-compatible value unless result_for is no_one.",
            },
            result_for: {
              type: "string",
              enum: [
                "no_one",
                "later_javascript",
                "worker_context",
                "proc_result",
              ],
              description:
                "Who needs the returned value. no_one discards it. later_javascript saves it as value_id for loadValue(value_id). worker_context puts a bounded representation in your next turn and also saves the exact value as value_id. proc_result returns it as the final proc result and ends proc.",
            },
          },
          required: ["summary", "javascript", "result_for"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: CANNOT_EXECUTE,
        description:
          "Stop because the procedure is unsupported or lacks a consequential instruction.",
        parameters: {
          type: "object",
          properties: {
            reason: {
              type: "string",
              description: "Smallest missing or unsupported instruction.",
            },
          },
          required: ["reason"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function parseArgs(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { _invalidJson: raw };
  }
}

function emitCompleted(
  opts: ProcWorkerOptions,
  transaction: ProcTransaction,
): void {
  opts.emit({
    type: "subagent.lifecycle",
    toolCallId: toolCodec.encode(transaction.parentToolCallId),
    agentId: transaction.id,
    status: "completed",
  });
}

function emitProtocolResult(
  emit: (event: PortalEvent) => void,
  toolCallId: string,
  parentToolCallId: string,
  ok: boolean,
  output: string,
): void {
  emit({
    type: "tool.result",
    toolCallId,
    ok,
    summary: ok ? "Completed" : "Failed",
    output,
    parentToolCallId,
  });
}

function recordExecutionFeedback(
  emit: (event: PortalEvent) => void,
  transaction: ProcTransaction,
  workerToolCallId: string,
  protocolId: string,
  procId: string,
  ok: boolean,
  feedback: unknown,
): void {
  const text = JSON.stringify(feedback);
  transaction.messages.push({
    role: "tool",
    tool_call_id: workerToolCallId,
    content: text,
  });
  emitProtocolResult(emit, protocolId, procId, ok, text);
}
