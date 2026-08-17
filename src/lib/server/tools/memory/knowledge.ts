import { z } from "zod";
import { memoryFactId } from "$lib/ids";
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
import {
  ENTITY_KEEP,
  EVENT_KEEP,
  FACT_KEEP,
  OPEN_LOOP_KEEP,
  projectOptions,
} from "./common";
import type { MemoryToolsOpts } from "./common";

export const ClueArgs = z
  .object({
    status: z
      .enum(["all", "open", "revealed", "resolved"])
      .optional()
      .default("all"),
    limit: z.number().int().min(1).max(100).optional().default(50),
    fields: FieldsArg,
  })
  .prefault({});

export const CharacterKnowledgeArgs = z.object({
  characterEntityKey: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional().default(50),
  fields: FieldsArg,
});

export const CheckClaimsArgs = z.object({
  claims: z
    .array(
      z.object({
        entityKey: z.string().trim().min(1).max(200).optional(),
        predicate: z.string().trim().min(1).max(100),
        value: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(50),
});

export function buildMemoryKnowledgeTools(opts: MemoryToolsOpts): PortalTool[] {
  return [
    {
      name: "memory_query_clues",
      description:
        "Return clue-ledger records (open loops or facts) for mystery/strict sessions.",
      argsSchema: ClueArgs,
      permissionBehavior: "never-prompt",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["all", "open", "revealed", "resolved"],
            description: "Clue status filter. Defaults to all.",
          },
          limit: { type: "number", description: "Clues 1-100, default 50." },
          fields: FIELDS_PARAM,
        },
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = ClueArgs.parse(args);
        const loops = memoryRepo
          .listOpenLoops(opts.conversationId, {
            loopType: "clue",
            status: parsed.status,
            limit: parsed.limit,
          })
          .filter(
            (loop) => parsed.status === "all" || loop.status === parsed.status,
          );
        const clueFacts = memoryRepo
          .listFacts(opts.conversationId, {
            predicate: "clue",
            limit: parsed.limit,
          })
          .filter(
            (fact) => parsed.status === "all" || fact.status === parsed.status,
          );
        const summary = `${loops.length + clueFacts.length} clue record(s)`;
        memoryRepo.recordToolCall(opts.conversationId, {
          turnId: opts.getTurnId?.() ?? null,
          toolName: "memory_query_clues",
          arguments: parsed,
          resultSummary: summary,
          resultIds: [
            ...loops.map((loop) => loop.id),
            ...clueFacts.map((fact) => memoryFactId.parse(fact.id)),
          ],
        });
        assertFieldsKnown(parsed.fields, [
          { input: loops, keep: OPEN_LOOP_KEEP },
          { input: clueFacts, keep: FACT_KEEP },
        ]);
        const loopsP = project(
          loops,
          projectOptions(parsed.fields, OPEN_LOOP_KEEP, false),
        );
        const factsP = project(
          clueFacts,
          projectOptions(parsed.fields, FACT_KEEP, false),
        );
        const result = withOmitted(
          { openLoops: loopsP.value, facts: factsP.value },
          combineOmitted(loopsP, factsP),
        );
        return ok(result, summary);
      },
    },
    {
      name: "memory_get_character_knowledge",
      description:
        "Return facts/events describing what a character or participant knows.",
      argsSchema: CharacterKnowledgeArgs,
      permissionBehavior: "never-prompt",
      parameters: {
        type: "object",
        properties: {
          characterEntityKey: {
            type: "string",
            description: "Character entity key, e.g. character.elias.",
          },
          limit: { type: "number", description: "Records 1-100, default 50." },
          fields: FIELDS_PARAM,
        },
        required: ["characterEntityKey"],
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = CharacterKnowledgeArgs.parse(args);
        const entity = memoryRepo.getEntity(
          opts.conversationId,
          parsed.characterEntityKey,
        );
        const knowledgePredicate = `knowledge:${parsed.characterEntityKey}`;
        const facts = memoryRepo.listFacts(opts.conversationId, {
          predicate: knowledgePredicate,
          limit: parsed.limit,
        });
        const events = entity
          ? memoryRepo.listEvents(opts.conversationId, {
              entityId: entity.id,
              limit: parsed.limit,
            })
          : [];
        const summary = `${facts.length + events.length} knowledge record(s)`;
        memoryRepo.recordToolCall(opts.conversationId, {
          turnId: opts.getTurnId?.() ?? null,
          toolName: "memory_get_character_knowledge",
          arguments: parsed,
          resultSummary: summary,
          resultIds: [
            ...facts.map((fact) => memoryFactId.parse(fact.id)),
            ...events.map((event) => event.id),
          ],
        });
        assertFieldsKnown(parsed.fields, [
          { input: entity, keep: ENTITY_KEEP },
          { input: facts, keep: FACT_KEEP },
          { input: events, keep: EVENT_KEEP },
        ]);
        const entityP = project(
          entity,
          projectOptions(parsed.fields, ENTITY_KEEP, false),
        );
        const factsP = project(
          facts,
          projectOptions(parsed.fields, FACT_KEEP, false),
        );
        const eventsP = project(
          events,
          projectOptions(parsed.fields, EVENT_KEEP, false),
        );
        const result = withOmitted(
          { entity: entityP.value, facts: factsP.value, events: eventsP.value },
          combineOmitted(entityP, factsP, eventsP),
        );
        return ok(result, summary);
      },
    },
    {
      name: "memory_check_claims",
      description: "Check proposed claims against active durable facts.",
      argsSchema: CheckClaimsArgs,
      permissionBehavior: "never-prompt",
      parameters: {
        type: "object",
        properties: {
          claims: {
            type: "array",
            items: {
              type: "object",
              properties: {
                entityKey: { type: "string" },
                predicate: { type: "string" },
                value: {},
              },
              required: ["predicate"],
              additionalProperties: false,
            },
          },
        },
        required: ["claims"],
        additionalProperties: false,
      },
      async handler(args) {
        const parsed = CheckClaimsArgs.parse(args);
        const results = parsed.claims.map((claim) =>
          checkClaim(opts.conversationId, claim),
        );
        const summary = `${results.length} claim(s) checked`;
        memoryRepo.recordToolCall(opts.conversationId, {
          turnId: opts.getTurnId?.() ?? null,
          toolName: "memory_check_claims",
          arguments: parsed,
          resultSummary: summary,
        });
        return ok({ results }, summary);
      },
    },
  ];
}

export function checkClaim(
  conversationId: string | number,
  claim: { entityKey?: string | undefined; predicate: string; value?: unknown },
) {
  const entity = claim.entityKey
    ? memoryRepo.getEntity(conversationId, claim.entityKey)
    : null;
  if (claim.entityKey && !entity) {
    return {
      claim,
      status: "unknown",
      sources: [],
      reason: `No memory entity found for ${claim.entityKey}.`,
    };
  }
  const facts = memoryRepo.listFacts(conversationId, {
    entityId: entity?.id,
    predicate: claim.predicate,
    limit: 50,
  });
  if (facts.length === 0) return { claim, status: "unknown", sources: [] };
  const exact = facts.find(
    (fact) => JSON.stringify(fact.value) === JSON.stringify(claim.value),
  );
  if (claim.value === undefined)
    return { claim, status: "supported", sources: facts };
  if (exact) return { claim, status: "supported", sources: [exact] };
  return { claim, status: "contradicted", sources: facts };
}
