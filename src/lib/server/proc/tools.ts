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
        "Tolerantly realize one supplied repository procedure while keeping intermediate data out of model context.",
      promptSnippet:
        "Execute a frontier-authored procedure with stateful program atoms.",
      promptGuidelines: [
        "Proc is not a subagent. You own diagnosis, procedure, relevance criteria, and consequential decisions; proc only realizes the procedure tolerantly.",
        "Summary is a short user-visible label; output.contract is the fuller bounded return contract the worker shapes the final value to. Supply observable steps, filtering/reduction rules, stopping criteria, and an output that can fit max_bytes.",
        "State the bounded answer proc should produce and why before naming any path, then name the searches, the read ranges, the fields and excerpts to keep, what to discard, and when to stop. 'Return this file' is a placeholder for an undefined answer; derive a real one, e.g. 'the API contract surface of src/index.ts' or 'which handlers call X, with their line ranges'. If you only want raw content back, you do not need proc — you already hold the context.",
        "Use proc to reduce a larger corpus into selected evidence, not to return multiple full files or other raw corpora verbatim. Prefer paths, line ranges, purposes, and bounded excerpts.",
        'Good: summary "Map the API contract"; output.contract "Function names, exported types, and signatures exposed by src/index.ts"; procedure "read the file, collect public exports, omit private helpers". Bad: "read these six files fully and return raw contents verbatim", or a contract of "src/routes.ts" with no bounded answer.',
      ],
      argsSchema: ProcArgs,
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description:
              "Short user-visible label for the proc card, distinct from the fuller return contract.",
          },
          procedure: {
            type: "string",
            description:
              "Ordered pseudocode, selection rules, and stopping criteria.",
          },
          output: {
            type: "object",
            properties: {
              contract: {
                type: "string",
                description:
                  "Concrete bounded return contract (shape and bounds) the worker shapes the final value to; not an open-ended objective.",
              },
              max_bytes: {
                type: "integer",
                minimum: MIN_RESULT_BYTES,
                maximum: MAX_RESULT_BYTES,
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
          const frontierResult = {
            status: outcome.status,
            bytes: outcome.bytes,
            ...(outcome.projection !== undefined
              ? { projection: outcome.projection }
              : {}),
            projection_bytes: outcome.projectionBytes,
            truncated: outcome.truncated,
          };
          return ok(
            {
              ...outcome,
              content: JSON.stringify(frontierResult, null, 2),
            },
            outcome.summary,
            {
              views: [
                {
                  type: "text",
                  text: JSON.stringify(frontierResult),
                },
              ],
            },
          );
        }
        return err(outcome.summary, {
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
  return "Proc output must be a bounded derived result, not multiple full files or raw corpus content. Request paths, line ranges, purposes, and only the excerpts needed by the frontier, with explicit filtering rules that fit output.max_bytes.";
}
