import { z } from "zod";
import * as memoryRepo from "../../db/repos/memory";
import { ok, type PortalTool } from "../types";
import { project, withOmitted, FieldsArg, FIELDS_PARAM } from "../project";
import { projectOptions, SEARCH_HIT_KEEP } from "./common";
import type { MemoryToolsOpts } from "./common";

const GLOBAL_MEMORY_KEEP = [
  "id",
  "kind",
  "memoryKey",
  "value",
  "status",
] as const;

export const GlobalRememberArgs = z.object({
  kind: z.enum(["preference", "decision", "fact", "style", "constraint"]),
  key: z.string().trim().min(1).max(200),
  value: z.unknown(),
  fields: FieldsArg,
});

export const GlobalSearchArgs = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(50).optional().default(20),
  fields: FieldsArg,
});

export function buildMemoryGlobalTools(opts: MemoryToolsOpts): PortalTool[] {
  return [
    {
      name: "memory_global_record",
      description:
        "Explicitly store a user-scoped global memory recallable across conversations.",
      argsSchema: GlobalRememberArgs,
      permissionBehavior: "never-prompt",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["preference", "decision", "fact", "style", "constraint"],
            description: "Global memory kind.",
          },
          key: { type: "string", description: "Stable key for this memory." },
          value: { description: "JSON-serializable global memory value." },
          fields: FIELDS_PARAM,
        },
        required: ["kind", "key", "value"],
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = GlobalRememberArgs.parse(args);
        const row = memoryRepo.upsertGlobalMemory(opts.userId, {
          kind: parsed.kind,
          memoryKey: parsed.key,
          value: parsed.value,
          sourceConversationId: opts.conversationId,
        });
        const summary = `Stored global ${row.kind}: ${row.memoryKey}`;
        memoryRepo.recordToolCall(opts.conversationId, {
          turnId: opts.getTurnId?.() ?? null,
          toolName: "memory_global_record",
          arguments: parsed,
          resultSummary: summary,
          resultIds: [row.id],
        });
        const projected = project(
          row,
          projectOptions(parsed.fields, GLOBAL_MEMORY_KEEP),
        );
        return ok(
          withOmitted({ memory: projected.value }, projected.omitted),
          summary,
        );
      },
    },
    {
      name: "memory_global_search",
      description: "Search explicit user-scoped global memories.",
      argsSchema: GlobalSearchArgs,
      permissionBehavior: "never-prompt",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search in global memories.",
          },
          limit: { type: "number", description: "Results 1-50, default 20." },
          fields: FIELDS_PARAM,
        },
        required: ["query"],
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = GlobalSearchArgs.parse(args);
        const results = memoryRepo.searchGlobalMemories(opts.userId, parsed);
        const summary = `${results.length} global result(s)`;
        memoryRepo.recordToolCall(opts.conversationId, {
          turnId: opts.getTurnId?.() ?? null,
          toolName: "memory_global_search",
          arguments: parsed,
          resultSummary: summary,
          resultIds: results.map((result) => result.itemId),
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
