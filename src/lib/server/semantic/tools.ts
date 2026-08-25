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
import {
  normalizeProgramToolArgs,
  programCapabilities,
  programCatalog,
  programToolContracts,
} from "$lib/server/ptc/contracts";

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

const ProgramToolSchemasArgs = z
  .object({
    names: z.array(z.string().min(1).max(100)).min(1).max(20),
  })
  .strict();

export interface SemanticToolOptions {
  conversationId: number;
  frontierModel: string;
  workerModel?: string | null;
  capabilities: ReadonlyMap<string, PortalTool>;
  facadeCapabilities?: ReadonlyMap<string, PortalTool>;
  permissionResolver: PiPermissionResolver;
  emit: (event: PortalEvent) => void;
}

export function buildSemanticTools(opts: SemanticToolOptions): PortalTool[] {
  return [
    buildResolveTool(opts),
    buildResumeTool(opts),
    buildProgramTool(opts),
    buildProgramToolSchemasTool(opts.capabilities),
    buildReaderTool(opts.conversationId, "evidence", "read_evidence"),
    buildReaderTool(opts.conversationId, "changeset", "read_changeset"),
    buildReaderTool(opts.conversationId, "trace", "read_trace"),
    buildReaderTool(opts.conversationId, "output", "read_output"),
  ];
}

function buildProgramTool(opts: SemanticToolOptions): PortalTool {
  const capabilities = programCapabilities(opts.capabilities);
  const facadeCapabilities = new Map<string, PortalTool>();
  for (const name of ["read", "write"]) {
    const tool = capabilities.get(name);
    if (tool) facadeCapabilities.set(name, tool);
  }
  for (const [name, tool] of opts.facadeCapabilities ?? []) {
    facadeCapabilities.set(name, tool);
  }
  const executableCapabilities = new Map([
    ...capabilities,
    ...facadeCapabilities,
  ]);
  const catalog = programCatalog(capabilities);
  return {
    name: "program",
    description:
      "Run bounded JavaScript that composes portal capabilities as await tools.<name>(args); return JSON.",
    promptSnippet:
      "Batch deterministic capability calls in isolated JavaScript.",
    promptGuidelines: [
      `Available program tools: ${catalog}. Call get_program_tool_schemas for exact contracts when a name is ambiguous or arguments fail. Generated code has no ambient host APIs.`,
      'Programs have async fs.readFile(path, "utf8"), fs.writeFile(path, text, { encoding?: "utf8" }), fs.readdir(path), and fs.stat(path). Only text IO is supported; fs.stat returns size, mtimeMs, isFile(), isDirectory(), and isSymbolicLink().',
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
      try {
        const result = await runProgram({
          source: args.source,
          capabilities,
          facadeCapabilities,
          execute: (name, callArgs, signal) => {
            const tool = executableCapabilities.get(name);
            const normalized = tool
              ? normalizeProgramToolArgs(tool, callArgs)
              : callArgs;
            return executeDelegatedTool(
              {
                parentToolCallId: toolCodec.parse(ctx.toolCallId!),
                capabilities: executableCapabilities,
                permissionResolver: opts.permissionResolver,
                emit: opts.emit,
                signal,
              },
              name,
              normalized,
            );
          },
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

function buildProgramToolSchemasTool(
  capabilities: ReadonlyMap<string, PortalTool>,
): PortalTool {
  return {
    name: "get_program_tool_schemas",
    description:
      "Get exact input and result contracts for named program tools when the compact catalog is insufficient.",
    argsSchema: ProgramToolSchemasArgs,
    parameters: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
        },
      },
      required: ["names"],
      additionalProperties: false,
    },
    permissionBehavior: "never-prompt",
    async handler(raw) {
      const args = ProgramToolSchemasArgs.parse(raw);
      const tools = programToolContracts(capabilities, args.names);
      return ok(
        { tools },
        `Returned ${tools.length} program tool contract(s).`,
      );
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
