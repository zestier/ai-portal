import { z } from "zod";
import { toolCallId as toolCodec } from "$lib/ids";
import type { PortalEvent } from "$lib/types";
import type { PiPermissionResolver } from "$lib/server/pi/session";
import { err, ok, type PortalTool } from "$lib/server/tools/types";
import {
  programCapabilities,
  programToolManifest,
} from "$lib/server/ptc/contracts";
import { createProcTransaction, type ProcOutputPolicy } from "./store";
import { initialProcMessages, runProcWorker } from "./worker";

const MIN_RESULT_BYTES = 256;
const MAX_RESULT_BYTES = 48 * 1024;

const OutputPolicy = z
  .object({
    mode: z.enum(["shape", "exact"]),
    max_bytes: z.number().int().min(MIN_RESULT_BYTES).max(MAX_RESULT_BYTES),
    store: z.boolean(),
  })
  .strict();

const ProcArgs = z
  .object({
    summary: z.string().min(1).max(500),
    goal: z.string().min(1).max(10_000),
    procedure: z.string().min(1).max(30_000),
    output: OutputPolicy,
  })
  .strict();

export interface ProcToolOptions {
  conversationId: number;
  frontierModel: string;
  workerModel?: string | null;
  capabilities: ReadonlyMap<string, PortalTool>;
  facadeCapabilities: ReadonlyMap<string, PortalTool>;
  permissionResolver: PiPermissionResolver;
  emit: (event: PortalEvent) => void;
}

export function buildProcTools(opts: ProcToolOptions): PortalTool[] {
  const capabilities = programCapabilities(opts.capabilities);
  const contracts = programToolManifest(capabilities);
  return [
    {
      name: "proc",
      description:
        "Tolerantly realize one supplied repository procedure while keeping intermediate data out of model context.",
      promptSnippet:
        "Execute a frontier-authored procedure with stateful program atoms.",
      promptGuidelines: [
        "Proc is not a subagent. You own diagnosis, procedure, relevance criteria, and consequential decisions; proc only realizes the procedure tolerantly.",
        "Supply observable steps and a return contract. Use shape for structural results and exact when you need the actual bounded value.",
      ],
      argsSchema: ProcArgs,
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Brief user-visible explanation of the procedure.",
          },
          goal: {
            type: "string",
            description:
              "Concrete final data contract, not an open-ended objective.",
          },
          procedure: {
            type: "string",
            description:
              "Ordered pseudocode, selection rules, and stopping criteria.",
          },
          output: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["shape", "exact"] },
              max_bytes: {
                type: "integer",
                minimum: MIN_RESULT_BYTES,
                maximum: MAX_RESULT_BYTES,
              },
              store: { type: "boolean" },
            },
            required: ["mode", "max_bytes", "store"],
            additionalProperties: false,
          },
        },
        required: ["summary", "goal", "procedure", "output"],
        additionalProperties: false,
      },
      permissionBehavior: "never-prompt",
      async handler(raw, ctx) {
        const args = ProcArgs.parse(raw);
        if (!ctx?.toolCallId) return err("proc requires a mapped tool call id");
        const outputPolicy: ProcOutputPolicy = {
          mode: args.output.mode,
          maxBytes: args.output.max_bytes,
          store: args.output.store,
        };
        const messages = initialProcMessages({
          summary: args.summary,
          goal: args.goal,
          procedure: args.procedure,
          outputPolicy,
          contracts,
        });
        const transaction = createProcTransaction({
          conversationId: opts.conversationId,
          parentToolCallId: toolCodec.parse(ctx.toolCallId),
          workerModel: opts.workerModel ?? opts.frontierModel,
          summary: args.summary,
          goal: args.goal,
          procedure: args.procedure,
          outputPolicy,
          messages,
        });
        const outcome = await runProcWorker({
          transaction,
          capabilities,
          facadeCapabilities: opts.facadeCapabilities,
          permissionResolver: opts.permissionResolver,
          emit: opts.emit,
          signal: ctx.signal,
        });
        return outcome.status === "completed"
          ? ok(outcome, outcome.summary, {
              views: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: outcome.status,
                    ...(outcome.resultId
                      ? { result_id: outcome.resultId }
                      : {}),
                    stored: outcome.stored,
                    bytes: outcome.bytes,
                    ...(outcome.projection !== undefined
                      ? { projection: outcome.projection }
                      : {}),
                    projection_bytes: outcome.projectionBytes,
                    truncated: outcome.truncated,
                  }),
                },
              ],
            })
          : err(outcome.summary, {
              code:
                outcome.status === "cannot_execute"
                  ? "proc_cannot_execute"
                  : "proc_failed",
              summary: outcome.summary,
              details: outcome,
            });
      },
    },
  ];
}
