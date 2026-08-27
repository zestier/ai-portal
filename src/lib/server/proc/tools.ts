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
    contract: z.string().min(1).max(10_000),
    max_bytes: z.number().int().min(MIN_RESULT_BYTES).max(MAX_RESULT_BYTES),
  })
  .strict();

const ProcArgs = z
  .object({
    summary: z.string().min(1).max(500),
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
        "Execute a specified repository procedure while keeping routine intermediate data out of context.",
      promptSnippet: "Execute a bounded repository procedure.",
      promptGuidelines: [
        "Provide ordered, observable steps with selection, filtering, and stopping criteria. Define a derived result that fits output.max_bytes.",
        "Request the smallest result that preserves your ability to decide or edit correctly, not context that is merely convenient. Do not sacrifice consequential detail or verifiability.",
        "Choose an appropriate representation for the task. Consider summaries, structured facts, provenance, bounded excerpts, and exact source.",
        "Describe the result before where to find it. A path alone is not a result contract; request concrete evidence such as exported signatures or callers with ranges.",
        'Example: procedure "read src/index.ts; collect public exports; omit private helpers"; output.contract "exported names, types, and signatures". Do not request multiple full files.',
      ],
      argsSchema: ProcArgs,
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Short label shown to the user.",
          },
          procedure: {
            type: "string",
            description:
              "Ordered steps, selection criteria, and stopping rule.",
          },
          output: {
            type: "object",
            properties: {
              contract: {
                type: "string",
                description:
                  "What the result must contain: format, fields, selection criteria, and bounds.",
              },
              max_bytes: {
                type: "integer",
                minimum: MIN_RESULT_BYTES,
                maximum: MAX_RESULT_BYTES,
                description: "Hard UTF-8 byte limit for the final result.",
              },
            },
            required: ["contract", "max_bytes"],
            additionalProperties: false,
          },
        },
        required: ["summary", "procedure", "output"],
        additionalProperties: false,
      },
      permissionBehavior: "never-prompt",
      async handler(raw, ctx) {
        const args = ProcArgs.parse(raw);
        if (!ctx?.toolCallId) return err("proc requires a mapped tool call id");
        const requestProblem = validateProcRequest({
          contract: args.output.contract,
          procedure: args.procedure,
        });
        if (requestProblem) {
          return err(requestProblem, {
            code: "proc_unbounded_output",
            summary: requestProblem,
          });
        }
        const outputPolicy: ProcOutputPolicy = {
          mode: "exact",
          maxBytes: args.output.max_bytes,
          store: false,
        };
        const messages = initialProcMessages({
          summary: args.summary,
          contract: args.output.contract,
          procedure: args.procedure,
          outputPolicy,
          contracts,
        });
        const transaction = createProcTransaction({
          conversationId: opts.conversationId,
          parentToolCallId: toolCodec.parse(ctx.toolCallId),
          workerModel: opts.workerModel ?? opts.frontierModel,
          summary: args.summary,
          contract: args.output.contract,
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
        if (outcome.status === "completed") {
          return ok(outcome, outcome.summary, {
            views: [
              {
                type: "text",
                text: JSON.stringify(outcome.projection),
              },
            ],
          });
        }
        return err(outcome.summary, {
          code:
            outcome.status === "cannot_execute"
              ? "proc_cannot_execute"
              : "proc_failed",
          summary: outcome.summary,
          details: outcome,
          detailsUiOnly: true,
        });
      },
    },
  ];
}

export function validateProcRequest(input: {
  contract: string;
  procedure: string;
}): string | null {
  const text = `${input.contract}\n${input.procedure}`;
  const requestsVerbatimCorpus =
    /\b(?:raw\s+)?(?:file\s+)?contents?\s+verbatim\b/i.test(text) ||
    /\b(?:read|include|return)\b[^\n.]{0,80}\b(?:full|fully|entire)\b[^\n.]{0,40}\b(?:file|content|source)\b/i.test(
      text,
    );
  if (!requestsVerbatimCorpus) return null;
  const paths = new Set(
    [
      ...text.matchAll(/\b(?:src|tests|e2e|docs|scripts|static)\/[^\s,;"')]+/g),
    ].map((match) => match[0].replace(/[.:]+$/, "")),
  );
  if (paths.size < 2 && !/\b(?:all|multiple|every)\s+files?\b/i.test(text)) {
    return null;
  }
  return "Proc must return a bounded derived result, not multiple full files. Request selected paths, ranges, purposes, or limited excerpts that fit output.max_bytes.";
}
