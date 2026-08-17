import type { MemoryMode } from "$lib/types";
import type { FieldSelector } from "../project";

export interface MemoryToolsOpts {
  userId: number;
  conversationId: string | number;
  getTurnId?: () => string | null;
  mode: MemoryMode;
  globalMemoryEnabled?: boolean;
}

// Per-shape allowlists of model-relevant fields. Everything else (provenance
// ids, timestamps, raw payloads, confidence/visibility, etc.) is dropped from
// the compact-by-default result; pass `fields` with specific names to
// recover more.
export const ENTITY_KEEP = [
  "id",
  "entityKey",
  "entityType",
  "displayName",
  "summary",
  "status",
] as const;
export const EVENT_KEEP = [
  "id",
  "eventType",
  "occurredAt",
  "actorEntityId",
  "targetEntityId",
  "summary",
] as const;
export const FACT_KEEP = [
  "id",
  "entityId",
  "predicate",
  "value",
  "status",
] as const;
export const OPEN_LOOP_KEEP = [
  "id",
  "loopKey",
  "loopType",
  "title",
  "description",
  "status",
  "priority",
] as const;
export const SEARCH_HIT_KEEP = ["itemType", "itemId", "text"] as const;

export function projectOptions<K extends readonly string[]>(
  fields: FieldSelector | string | string[] | undefined,
  keep: K,
  validate?: boolean,
): { keep: K; fields?: FieldSelector | string; validate?: boolean } {
  return {
    keep,
    ...(fields !== undefined ? { fields } : {}),
    ...(validate !== undefined ? { validate } : {}),
  };
}
