import { z } from "zod";
import { memoryEntityId } from "$lib/ids";
import * as memoryRepo from "../../db/repos/memory";
import { ok, type PortalTool } from "../types";
import {
  assertFieldsKnown,
  combineOmitted,
  project,
  withOmitted,
  FieldsArg,
  FIELDS_PARAM,
} from "../project";
import { ENTITY_KEEP, EVENT_KEEP, FACT_KEEP, projectOptions } from "./common";
import type { MemoryToolsOpts } from "./common";

export const EntityArgs = z.object({
  id: z.string().trim().min(1).max(200),
  fields: FieldsArg,
});

export function buildMemoryEntityTools(opts: MemoryToolsOpts): PortalTool[] {
  return [
    {
      name: "memory_get_entity",
      description:
        "Fetch canonical durable state for one entity (by id or key), including active facts and recent events.",
      argsSchema: EntityArgs,
      permissionBehavior: "never-prompt",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Entity id or symbolic key, e.g. character.elias.",
          },
          fields: FIELDS_PARAM,
        },
        required: ["id"],
        additionalProperties: false,
      },
      async handler(args) {
        const { id, fields } = EntityArgs.parse(args);
        const entity = memoryRepo.getEntity(opts.conversationId, id);
        if (!entity) return ok({ entity: null });
        const facts = memoryRepo.listFacts(opts.conversationId, {
          entityId: entity.id,
          limit: 100,
        });
        const events = memoryRepo.listEvents(opts.conversationId, {
          entityId: entity.id,
          limit: 30,
        });
        assertFieldsKnown(fields, [
          { input: entity, keep: ENTITY_KEEP },
          { input: facts, keep: FACT_KEEP },
          { input: events, keep: EVENT_KEEP },
        ]);
        const entityP = project(
          entity,
          projectOptions(fields, ENTITY_KEEP, false),
        );
        const factsP = project(facts, projectOptions(fields, FACT_KEEP, false));
        const eventsP = project(
          events,
          projectOptions(fields, EVENT_KEEP, false),
        );
        const result = withOmitted(
          { entity: entityP.value, facts: factsP.value, events: eventsP.value },
          combineOmitted(entityP, factsP, eventsP),
        );
        memoryRepo.recordToolCall(opts.conversationId, {
          turnId: opts.getTurnId?.() ?? null,
          toolName: "memory_get_entity",
          arguments: { id },
          resultSummary: entity.displayName,
          resultIds: [memoryEntityId.parse(entity.id)],
        });
        return ok(result, entity.displayName);
      },
    },
  ];
}
