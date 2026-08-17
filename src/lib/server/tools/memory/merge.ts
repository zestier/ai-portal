import { z } from "zod";
import { memoryEntityId } from "$lib/ids";
import * as memoryRepo from "../../db/repos/memory";
import { ok, type PortalTool } from "../types";
import type { MemoryToolsOpts } from "./common";

export const MergeEntitiesArgs = z.object({
  from: z.string().trim().min(1).max(200),
  into: z.string().trim().min(1).max(200),
});

export function buildMemoryMergeTools(opts: MemoryToolsOpts): PortalTool[] {
  return [
    {
      name: "memory_merge_entities",
      description:
        "Fold a duplicate entity into a canonical one when two keys denote the same real referent.",
      argsSchema: MergeEntitiesArgs,
      permissionBehavior: "never-prompt",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Duplicate entity to retire (id or key).",
          },
          into: {
            type: "string",
            description: "Canonical entity to keep (id or key).",
          },
        },
        required: ["from", "into"],
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = MergeEntitiesArgs.parse(args);
        const result = memoryRepo.mergeEntities(opts.conversationId, {
          fromKeyOrId: parsed.from,
          intoKeyOrId: parsed.into,
        });
        const summary = result.ok
          ? `merged ${parsed.from} into ${parsed.into} (${result.reassignedFacts} fact(s), ${result.reassignedEvents} event(s))`
          : `not merged: ${result.error ?? "unknown error"}`;
        memoryRepo.recordToolCall(opts.conversationId, {
          turnId: opts.getTurnId?.() ?? null,
          toolName: "memory_merge_entities",
          arguments: parsed,
          resultSummary: summary,
          resultIds: result.into ? [memoryEntityId.parse(result.into.id)] : [],
        });
        return ok(result, summary);
      },
    },
  ];
}
