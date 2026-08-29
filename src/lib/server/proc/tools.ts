import { z } from "zod";
import { toolCallId as toolCodec } from "$lib/ids";
import type { PortalEvent } from "$lib/types";
import type { PiPermissionResolver } from "$lib/server/pi/session";
import { err, ok, type PortalTool } from "$lib/server/tools/types";
import {
  PROGRAM_FACADE_TOOL_NAMES,
  programCapabilities,
  programToolManifest,
} from "$lib/server/ptc/contracts";
import { createProcTransaction, type ProcOutputPolicy } from "./store";
import { initialProcMessages, runProcWorker } from "./worker";

const EMERGENCY_PROC_RESULT_BYTES = 64 * 1024;

const ProcArgs = z
  .object({
    summary: z.string().min(1).max(500),
    procedure: z.string().min(1).max(30_000),
    result_requirements: z.string().min(1).max(10_000),
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
  const contracts = programToolManifest(
    new Map(
      [...capabilities].filter(
        ([name]) => !PROGRAM_FACADE_TOOL_NAMES.has(name),
      ),
    ),
  );
  return [
    {
      name: "proc",
      description:
        "Execute a specified repository procedure while keeping routine intermediate data out of context.",
      promptSnippet:
        "Realize a repository procedure with code-first data reduction.",
      promptGuidelines: [
        "Specify ordered steps, selection and exclusion rules, and a stopping condition.",
        "Specify the exact emitted shape, allowed fields, required evidence, ordering, and completeness. result_requirements is an allowlist, not a minimum.",
        "Request only the exact result needed after the procedure completes. Proc must reduce broad reads in JavaScript, not return raw responses, candidate corpora, paged context, or unrequested supporting detail.",
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
          result_requirements: {
            type: "string",
            description:
              "What the emitted result must contain: shape, fields, selection and exclusion rules, evidence, ordering, and completeness.",
          },
        },
        required: ["summary", "procedure", "result_requirements"],
        additionalProperties: false,
      },
      permissionBehavior: "never-prompt",
      async handler(raw, ctx) {
        const args = ProcArgs.parse(raw);
        if (!ctx?.toolCallId) return err("proc requires a mapped tool call id");
        const requestProblem = validateProcRequest({
          requirements: args.result_requirements,
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
          maxBytes: EMERGENCY_PROC_RESULT_BYTES,
          store: false,
        };
        const messages = initialProcMessages({
          summary: args.summary,
          requirements: args.result_requirements,
          procedure: args.procedure,
          outputPolicy,
          contracts,
        });
        const transaction = createProcTransaction({
          conversationId: opts.conversationId,
          parentToolCallId: toolCodec.parse(ctx.toolCallId),
          workerModel: opts.workerModel ?? opts.frontierModel,
          summary: args.summary,
          requirements: args.result_requirements,
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
  requirements: string;
  procedure: string;
}): string | null {
  const text = `${input.requirements}\n${input.procedure}`;
  const requestsVerbatimCorpus =
    /\b(?:raw\s+)?(?:file\s+)?contents?\s+verbatim\b/i.test(text) ||
    /\b(?:read|include|return)\b[^\n.]{0,80}\b(?:full|fully|entire)\b[^\n.]{0,40}\b(?:file|content|source)\b/i.test(
      text,
    );
  const requestsModelSideCorpus =
    /\b(?:return|emit|include|show)\b[^\n.]{0,80}\b(?:all|every)\b[^\n.]{0,40}\b(?:matches|candidates|search results|relevant context)\b/i.test(
      text,
    ) ||
    /\b(?:return|emit|include|show)\b[^\n.]{0,80}\b(?:pages?|chunks?|batches?)\b[^\n.]{0,40}\b(?:matches|candidates|results|files|content|source)\b/i.test(
      text,
    );
  if (requestsModelSideCorpus) {
    return "Proc must reduce candidate corpora in JavaScript, not page or return them for model-side browsing. Require only the selected facts or targeted evidence needed by the next decision.";
  }
  if (!requestsVerbatimCorpus) return null;
  const paths = new Set(
    [
      ...text.matchAll(/\b(?:src|tests|e2e|docs|scripts|static)\/[^\s,;"')]+/g),
    ].map((match) => match[0].replace(/[.:]+$/, "")),
  );
  if (paths.size < 2 && !/\b(?:all|multiple|every)\s+files?\b/i.test(text)) {
    return null;
  }
  return "Proc must emit an exact derived result, not full or paged source corpora. Require selected paths, ranges, purposes, or targeted excerpts and exclude everything not needed by the next decision.";
}
