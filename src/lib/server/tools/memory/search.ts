import { z } from "zod";
import { memoryEntityId, memoryFactId } from "$lib/ids";
import * as memoryRepo from "../../db/repos/memory";
import { ok, type PortalTool } from "../types";
import { project, withOmitted, FieldsArg, FIELDS_PARAM } from "../project";
import type { MemoryToolsOpts } from "./common";
import { projectOptions, SEARCH_HIT_KEEP } from "./common";

export const SearchArgs = z.object({
  query: z.string().trim().min(1).max(500),
  types: z
    .array(z.enum(["entity", "event", "fact", "open_loop"]))
    .max(5)
    .optional(),
  limit: z.number().int().min(1).max(50).optional().default(20),
  fields: FieldsArg,
});

export function buildMemorySearchTools(opts: MemoryToolsOpts): PortalTool[] {
  return [
    {
      name: "memory_search",
      description: "Search durable session memory.",
      argsSchema: SearchArgs,
      permissionBehavior: "never-prompt",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text to search for." },
          types: {
            type: "array",
            items: {
              type: "string",
              enum: ["entity", "event", "fact", "open_loop"],
            },
            description: "Optional memory item types to include.",
          },
          limit: { type: "number", description: "Results 1-50, default 20." },
          fields: FIELDS_PARAM,
        },
        required: ["query"],
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = SearchArgs.parse(args);
        const results = memoryRepo.search(opts.conversationId, parsed);
        const summary = `${results.length} result(s)`;
        memoryRepo.recordToolCall(opts.conversationId, {
          turnId: opts.getTurnId?.() ?? null,
          toolName: "memory_search",
          arguments: parsed,
          resultSummary: summary,
          resultIds: results.map((result) =>
            result.itemType === "entity"
              ? memoryEntityId.parse(result.itemId as string)
              : result.itemType === "fact"
                ? memoryFactId.parse(result.itemId as string)
                : (result.itemId as number),
          ),
        });
        const projected = project(
          results,
          projectOptions(parsed.fields, SEARCH_HIT_KEEP),
        );
        return ok(
          withOmitted({ results: projected.value }, projected.omitted),
          summary,
        );
      },
    },
  ];
}
