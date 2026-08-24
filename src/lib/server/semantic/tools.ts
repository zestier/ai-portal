import { z } from "zod";
import { toolCallId as toolCodec } from "$lib/ids";
import type { PortalEvent } from "$lib/types";
import type { PiPermissionResolver } from "$lib/server/pi/session";
import { err, ok, type PortalTool } from "$lib/server/tools/types";
import {
  createTransaction,
  getTransaction,
  readArtifact,
  updateTransaction,
  type ArtifactKind,
} from "./store";
import { initialWorkerMessages, runSemanticWorker } from "./worker";
import { executeDelegatedTool } from "./delegated-tool";
import { runProgram } from "$lib/server/ptc/program";

const ResolveArgs = z
  .object({
    intent: z.string().min(1).max(20_000),
    constraints: z.array(z.string().max(2_000)).max(20).optional(),
    completion: z.array(z.string().max(2_000)).max(20).optional(),
  })
  .strict();

const ResumeArgs = z
  .object({
    transaction_id: z.string().min(1).max(128),
    decision: z.string().min(1).max(10_000),
  })
  .strict();

const ReaderArgs = z
  .object({
    id: z.string().min(1).max(128),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(256).max(32_768).optional(),
  })
  .strict();

const ProgramArgs = z
  .object({ source: z.string().min(1).max(20_000) })
  .strict();

const DescribeCapabilitiesArgs = z
  .object({ names: z.array(z.string().min(1).max(100)).max(20).optional() })
  .strict();

export interface SemanticToolOptions {
  conversationId: number;
  frontierModel: string;
  workerModel?: string | null;
  capabilities: ReadonlyMap<string, PortalTool>;
  permissionResolver: PiPermissionResolver;
  emit: (event: PortalEvent) => void;
}

export function buildSemanticTools(opts: SemanticToolOptions): PortalTool[] {
  return [
    buildResolveTool(opts),
    buildResumeTool(opts),
    buildProgramTool(opts),
    buildDescribeCapabilitiesTool(opts.capabilities),
    buildReaderTool(opts.conversationId, "evidence", "read_evidence"),
    buildReaderTool(opts.conversationId, "changeset", "read_changeset"),
    buildReaderTool(opts.conversationId, "trace", "read_trace"),
    buildReaderTool(opts.conversationId, "output", "read_output"),
  ];
}

function buildProgramTool(opts: SemanticToolOptions): PortalTool {
  return {
    name: "program",
    description:
      "Run bounded JavaScript that composes portal capabilities as await tools.<name>(args); return JSON.",
    promptSnippet:
      "Batch deterministic capability calls in isolated JavaScript.",
    promptGuidelines: [
      "Use describe_capabilities before calling unfamiliar tools. Generated code has no ambient host APIs.",
    ],
    argsSchema: ProgramArgs,
    parameters: {
      type: "object",
      properties: { source: { type: "string" } },
      required: ["source"],
      additionalProperties: false,
    },
    permissionBehavior: "never-prompt",
    async handler(raw, ctx) {
      const args = ProgramArgs.parse(raw);
      if (!ctx?.toolCallId)
        return err("program requires a mapped tool call id");
      const capabilities = ptcCapabilities(opts.capabilities);
      try {
        const result = await runProgram({
          source: args.source,
          capabilities,
          execute: (name, callArgs, signal) =>
            executeDelegatedTool(
              {
                parentToolCallId: toolCodec.parse(ctx.toolCallId!),
                capabilities,
                permissionResolver: opts.permissionResolver,
                emit: opts.emit,
                signal,
              },
              name,
              callArgs,
            ),
          signal: ctx.signal,
        });
        return ok(
          result,
          `Program completed with ${result.operations} capability call(s).`,
        );
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error), {
          code: "program_failed",
        });
      }
    },
  };
}

function buildDescribeCapabilitiesTool(
  capabilities: ReadonlyMap<string, PortalTool>,
): PortalTool {
  return {
    name: "describe_capabilities",
    description: "List PTC capabilities or load selected argument schemas.",
    argsSchema: DescribeCapabilitiesArgs,
    parameters: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, maxItems: 20 },
      },
      additionalProperties: false,
    },
    permissionBehavior: "never-prompt",
    async handler(raw) {
      const args = DescribeCapabilitiesArgs.parse(raw);
      const available = ptcCapabilities(capabilities);
      if (!args.names?.length) {
        return ok(
          [...available.values()].map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
          `${available.size} program capabilities available.`,
        );
      }
      const selected = args.names.map((name) => {
        const tool = available.get(name);
        return tool
          ? { name, description: tool.description, parameters: tool.parameters }
          : { name, error: "unknown capability" };
      });
      return ok(selected, `Described ${selected.length} capability schema(s).`);
    },
  };
}

function buildResolveTool(opts: SemanticToolOptions): PortalTool {
  return {
    name: "resolve",
    description:
      "Complete one bounded repository intent through a semantic worker; escalates consequential choices.",
    promptSnippet: "Delegate bounded adaptive repository mechanics.",
    promptGuidelines: [
      "Keep diagnosis, design, and tradeoffs in the frontier; give resolve one immediate, checkable intent.",
    ],
    argsSchema: ResolveArgs,
    parameters: {
      type: "object",
      properties: {
        intent: { type: "string", description: "One bounded outcome." },
        constraints: { type: "array", items: { type: "string" } },
        completion: { type: "array", items: { type: "string" } },
      },
      required: ["intent"],
      additionalProperties: false,
    },
    permissionBehavior: "never-prompt",
    async handler(raw, ctx) {
      const args = ResolveArgs.parse(raw);
      if (!ctx?.toolCallId)
        return err("resolve requires a mapped tool call id");
      const transaction = createTransaction({
        conversationId: opts.conversationId,
        parentToolCallId: toolCodec.parse(ctx.toolCallId),
        workerModel: opts.workerModel ?? opts.frontierModel,
        intent: args.intent,
        messages: initialWorkerMessages({
          intent: args.intent,
          ...(args.constraints !== undefined
            ? { constraints: args.constraints }
            : {}),
          ...(args.completion !== undefined
            ? { completion: args.completion }
            : {}),
        }),
      });
      const result = await runSemanticWorker({
        transaction,
        capabilities: opts.capabilities,
        permissionResolver: opts.permissionResolver,
        emit: opts.emit,
        signal: ctx.signal,
      });
      return result.status === "failed"
        ? err(result.summary, {
            code: "semantic_worker_failed",
            details: result,
            summary: result.summary,
          })
        : ok(result, result.summary);
    },
  };
}

function buildResumeTool(opts: SemanticToolOptions): PortalTool {
  return {
    name: "resume",
    description:
      "Resume a suspended semantic transaction with a frontier decision.",
    argsSchema: ResumeArgs,
    parameters: {
      type: "object",
      properties: {
        transaction_id: { type: "string" },
        decision: { type: "string" },
      },
      required: ["transaction_id", "decision"],
      additionalProperties: false,
    },
    permissionBehavior: "never-prompt",
    async handler(raw, ctx) {
      const args = ResumeArgs.parse(raw);
      if (!ctx?.toolCallId) return err("resume requires a mapped tool call id");
      const transaction = getTransaction(
        args.transaction_id,
        opts.conversationId,
      );
      if (!transaction) return err("Semantic transaction not found.");
      if (transaction.status !== "decision_required") {
        return err(`Transaction is ${transaction.status}, not suspended.`);
      }
      transaction.parentToolCallId = toolCodec.parse(ctx.toolCallId);
      transaction.status = "running";
      transaction.pending = null;
      transaction.messages.push({ role: "user", content: args.decision });
      updateTransaction(transaction);
      const result = await runSemanticWorker({
        transaction,
        capabilities: opts.capabilities,
        permissionResolver: opts.permissionResolver,
        emit: opts.emit,
        signal: ctx.signal,
      });
      return result.status === "failed"
        ? err(result.summary, {
            code: "semantic_worker_failed",
            details: result,
            summary: result.summary,
          })
        : ok(result, result.summary);
    },
  };
}

function buildReaderTool(
  conversationId: number,
  kind: ArtifactKind,
  name: string,
): PortalTool {
  return {
    name,
    description: `Read a captured semantic ${kind} artifact by id.`,
    argsSchema: ReaderArgs,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 256, maximum: 32768 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    permissionBehavior: "never-prompt",
    async handler(raw) {
      const args = ReaderArgs.parse(raw);
      const artifact = readArtifact({
        id: args.id,
        conversationId,
        kind,
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      if (!artifact) return err(`${kind} artifact not found.`);
      return ok(artifact, `${kind} artifact (${artifact.totalBytes} bytes)`, {
        views: [{ type: "text", text: artifact.content }],
      });
    },
  };
}

function ptcCapabilities(
  capabilities: ReadonlyMap<string, PortalTool>,
): Map<string, PortalTool> {
  const selected = new Map<string, PortalTool>();
  for (const [name, tool] of capabilities) {
    if (
      name === "ask_user" ||
      name === "request_permission_grant" ||
      name === "force_retry_tool" ||
      name === "permission_capabilities"
    )
      continue;
    selected.set(name, tool);
  }
  return selected;
}
