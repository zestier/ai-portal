import { z } from "zod";
import { messageId as msgCodec } from "$lib/ids";
import * as memoryRepo from "../../db/repos/memory";
import * as messagesRepo from "../../db/repos/messages";
import { ok, type PortalTool } from "../types";
import { project, withOmitted, FieldsArg, FIELDS_PARAM } from "../project";
import { projectOptions } from "./common";
import type { MemoryToolsOpts } from "./common";

const MESSAGE_KEEP = ["id", "role", "content"] as const;

export const TranscriptLookupArgs = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).optional().default(8),
  fields: FieldsArg,
});

export function buildMemoryTranscriptTools(
  opts: MemoryToolsOpts,
): PortalTool[] {
  return [
    {
      name: "memory_get_transcript",
      description:
        "Search exact prior conversation wording (phrasing, quotes, old statements).",
      argsSchema: TranscriptLookupArgs,
      permissionBehavior: "never-prompt",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Literal text to find in prior messages.",
          },
          limit: {
            type: "number",
            description: "Matching messages 1-20, default 8.",
          },
          fields: FIELDS_PARAM,
        },
        required: ["query"],
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = TranscriptLookupArgs.parse(args);
        const matches = messagesRepo.searchConversation(
          opts.conversationId,
          parsed.query,
          {
            limit: parsed.limit,
          },
        );
        const summary = `${matches.length} message(s)`;
        memoryRepo.recordToolCall(opts.conversationId, {
          turnId: opts.getTurnId?.() ?? null,
          toolName: "memory_get_transcript",
          arguments: parsed,
          resultSummary: summary,
          resultIds: matches.map((message) => msgCodec.parse(message.id)),
        });
        const projected = project(
          matches,
          projectOptions(parsed.fields, MESSAGE_KEEP),
        );
        return ok(
          withOmitted({ messages: projected.value }, projected.omitted),
          summary,
        );
      },
    },
  ];
}
