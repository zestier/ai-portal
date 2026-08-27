import { z } from "zod";
import { toolCallId as toolCodec } from "$lib/ids";
import type { PortalEvent } from "$lib/types";
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
  deleteProcResult,
  getProcResult,
  getProcState,
  updateProcTransaction,
  type ProcOutputPolicy,
  type ProcTransaction,
} from "./store";

const MAX_TURNS = 100;
const ATOM = "atom";
const COMPLETE = "complete";
const CANNOT_EXECUTE = "cannot_execute";
const MIN_PROJECTION_BYTES = 256;
const MAX_PROJECTION_BYTES = 48 * 1024;

const OutputPolicy = z
  .object({
    mode: z.enum(["none", "shape", "exact"]),
    max_bytes: z
      .number()
      .int()
      .min(MIN_PROJECTION_BYTES)
      .max(MAX_PROJECTION_BYTES)
      .optional(),
    store: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== "none" && value.max_bytes === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${value.mode} requires max_bytes.`,
      });
    }
    if (value.mode === "none" && !value.store) {
      ctx.addIssue({ code: "custom", message: "none requires store: true." });
    }
  });

const AtomArgs = z
  .object({
    summary: z.string().min(1).max(500),
    source: z.string().min(1).max(20_000),
    output: OutputPolicy,
  })
  .strict();

const CompleteArgs = z
  .object({ result_id: z.string().min(1).max(128) })
  .strict();
const CannotExecuteArgs = z
  .object({ reason: z.string().min(1).max(4_000) })
  .strict();

export const PROC_WORKER_SYSTEM = `Realize exactly the supplied procedure using program atoms.
You are a tolerant compiler and dataflow orchestrator, not a goal-owning agent. Do not broaden the investigation, add goals, reinterpret relevance, or choose a different algorithm. Fuse, batch, and inline procedure steps into fewer atoms where the result, selection rules, and stopping criteria are unchanged.
Every stored atom's exact value is always available to later atoms as state[resultId]; an atom's output mode only chooses what you see in the feedback to plan the next step, never what the next atom can access. Choose the smallest mode that lets you write the next atom: none when the next atom only pipes the value; shape when it filters, groups, or selects mechanically. Write that mechanical logic as a JS predicate over state[resultId], which always holds the full exact value, so you almost never need to see it. Use exact as a last resort, and only on a small bounded batch, when the supplied criterion is subjective and a later atom cannot decide it in code — such as judging whether prose or code is worth keeping, or summarizing it. Never request exact to re-inspect a batch a predicate can already filter.
Give every atom a brief user-visible summary. Design the final stored value to satisfy the proc output policy; never use proc as a bulk conduit for full files or other raw corpora. If the final value would exceed its byte budget, apply the supplied filtering criteria and request shape rather than broad raw data.
Repair syntax, tool contracts, batching, and equivalent mechanical failures. If a consequential instruction is missing or the procedure cannot be realized, call cannot_execute with the smallest precise reason.
End only with complete for a stored final result or cannot_execute.`;

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
  contract: string;
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
        output: {
          contract: input.contract,
          max_bytes: input.outputPolicy.maxBytes,
        },
        program_environment: {
          tool_contracts: input.contracts,
          globals: "state, fs, path, command, tools",
          facades: {
            fs: [
              'readFile(path, "utf8") -> string',
              "writeFile(path, text) -> void",
              "readdir(path) -> string[]",
              "stat(path) -> { size, mtimeMs, isFile(), isDirectory(), isSymbolicLink() }",
              "mkdir(path) -> void",
              "rename(from, to) -> void",
            ],
            path: [
              "join",
              "dirname",
              "basename",
              "extname",
              "normalize",
              "relative",
              "isAbsolute",
            ],
            command:
              "run(executable, args?, { cwd?, stdin?, timeoutMs? }) -> { stdout, stderr }",
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
      const turn = await piChat(
        { model, runtime, timeoutMs: 120_000 },
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
          content: "Continue with atom, complete, or cannot_execute.",
        });
        updateProcTransaction(transaction);
        continue;
      }

      for (const call of turn.toolCalls) {
        const raw = parseArgs(call.arguments);
        const protocolId = toolCodec.encode(mintToolCallId());
        const procId = toolCodec.encode(transaction.parentToolCallId);
        opts.emit({
          type: "tool.call",
          toolCallId: protocolId,
          tool: call.name,
          args: raw,
          parentToolCallId: procId,
        });
        try {
          if (call.name === ATOM) {
            const args = AtomArgs.parse(raw);
            const policy = policyOf(args.output);
            transaction.usage.atoms++;
            const result = await runProgram({
              source: args.source,
              capabilities: opts.capabilities,
              facadeCapabilities: opts.facadeCapabilities,
              state: getProcState(transaction.id, transaction.conversationId),
              execute: (name, callArgs, signal) => {
                const tool = executableCapabilities.get(name);
                const normalized = tool
                  ? normalizeProgramToolArgs(tool, callArgs)
                  : callArgs;
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
                );
              },
              signal: opts.signal,
            });
            transaction.usage.operations += result.operations;
            const projection = projectProcValue(result.value, policy);
            const stored = policy.store
              ? createProcResult({
                  transactionId: transaction.id,
                  conversationId: transaction.conversationId,
                  value: result.value,
                })
              : null;
            const feedback = {
              ...(stored ? { result_id: stored.id } : {}),
              stored: policy.store,
              bytes:
                stored?.bytes ??
                Buffer.byteLength(JSON.stringify(result.value)),
              ...(projection.projection !== undefined
                ? { projection: projection.projection }
                : {}),
              projection_bytes: projection.projectionBytes,
              truncated: projection.truncated,
              operations: result.operations,
              final_output: transaction.outputPolicy,
            };
            const feedbackText = JSON.stringify(feedback);
            transaction.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: feedbackText,
            });
            emitProtocolResult(
              opts.emit,
              protocolId,
              procId,
              true,
              feedbackText,
            );
            continue;
          }
          if (call.name === COMPLETE) {
            const args = CompleteArgs.parse(raw);
            const stored = getProcResult({
              id: args.result_id,
              transactionId: transaction.id,
              conversationId: transaction.conversationId,
            });
            if (!stored)
              throw new Error("complete referenced an unknown proc result.");
            const projection = projectProcValue(
              stored.value,
              transaction.outputPolicy,
            );
            transaction.status = "completed";
            transaction.resultId = transaction.outputPolicy.store
              ? args.result_id
              : null;
            if (!transaction.outputPolicy.store) {
              deleteProcResult({
                id: args.result_id,
                transactionId: transaction.id,
                conversationId: transaction.conversationId,
              });
            }
            updateProcTransaction(transaction);
            emitProtocolResult(
              opts.emit,
              protocolId,
              procId,
              true,
              JSON.stringify({
                result_id: args.result_id,
                status: "completed",
              }),
            );
            emitCompleted(opts, transaction);
            return {
              status: "completed",
              summary: transaction.summary,
              transactionId: transaction.id,
              ...(transaction.outputPolicy.store
                ? { resultId: args.result_id }
                : {}),
              stored: transaction.outputPolicy.store,
              bytes: stored.bytes,
              ...(projection.projection !== undefined
                ? { projection: projection.projection }
                : {}),
              projectionBytes: projection.projectionBytes,
              truncated: projection.truncated,
              usage: transaction.usage,
            };
          }
          if (call.name === CANNOT_EXECUTE) {
            const args = CannotExecuteArgs.parse(raw);
            transaction.status = "cannot_execute";
            transaction.error = args.reason;
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
          const feedback = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            instruction:
              "Repair the equivalent atom or call cannot_execute if the supplied procedure cannot be realized.",
          };
          transaction.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(feedback),
          });
          emitProtocolResult(
            opts.emit,
            protocolId,
            procId,
            false,
            JSON.stringify(feedback),
          );
        }
      }
      updateProcTransaction(transaction);
    }
    throw new Error(`Proc worker exceeded its ${MAX_TURNS}-turn budget.`);
  } catch (error) {
    transaction.status = "failed";
    transaction.error = error instanceof Error ? error.message : String(error);
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

function workerToolSpecs(): ExtractorToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: ATOM,
        description:
          "Execute one JavaScript dataflow atom against capabilities and immutable state.",
        parameters: {
          type: "object",
          properties: {
            summary: {
              type: "string",
              description: "Brief user-visible explanation of this atom.",
            },
            source: { type: "string" },
            output: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["none", "shape", "exact"] },
                max_bytes: {
                  type: "integer",
                  minimum: MIN_PROJECTION_BYTES,
                  maximum: MAX_PROJECTION_BYTES,
                },
                store: { type: "boolean" },
              },
              required: ["mode", "store"],
              additionalProperties: false,
            },
          },
          required: ["summary", "source", "output"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: COMPLETE,
        description: "Complete with the id of the stored exact final value.",
        parameters: {
          type: "object",
          properties: { result_id: { type: "string" } },
          required: ["result_id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: CANNOT_EXECUTE,
        description:
          "Stop when the supplied procedure is unsupported or needs a missing decision.",
        parameters: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function policyOf(value: z.infer<typeof OutputPolicy>): ProcOutputPolicy {
  return {
    mode: value.mode,
    ...(value.max_bytes !== undefined ? { maxBytes: value.max_bytes } : {}),
    store: value.store,
  };
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
