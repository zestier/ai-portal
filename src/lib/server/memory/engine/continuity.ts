import * as memoryRepo from "$lib/server/db/repos/memory";
import { isTimelineEvent, timelinePoint } from "./loops";
import type { MemoryPatchProposal } from "./types";

export function solveStrictContinuity(
  patch: MemoryPatchProposal,
  conversationId?: string | number,
): Array<{ severity: "warning" | "error"; code: string; message: string }> {
  const issues: Array<{
    severity: "warning" | "error";
    code: string;
    message: string;
  }> = [];
  const seen = new Map<string, { location: string; summary: string }>();
  for (const event of patch.events ?? []) {
    if (!isTimelineEvent(event.eventType)) continue;
    const point = timelinePoint(event.payload);
    if (!event.entityKey || !point) continue;
    const key = `${event.entityKey}\u0000${point.at}`;
    const existing = seen.get(key);
    if (existing && existing.location !== point.location) {
      issues.push({
        severity: "error",
        code: "strict_timeline_location_conflict",
        message: `${event.entityKey} has conflicting locations at ${point.at}: ${existing.location} and ${point.location}.`,
      });
    } else {
      seen.set(key, { location: point.location, summary: event.summary });
    }
    if (conversationId) {
      const entity = memoryRepo.getEntity(conversationId, event.entityKey);
      if (!entity) continue;
      const conflict = memoryRepo
        .listEvents(conversationId, { entityId: entity.id, limit: 200 })
        .find((row) => {
          if (!isTimelineEvent(row.eventType)) return false;
          const prior = timelinePoint(row.payload);
          return prior?.at === point.at && prior.location !== point.location;
        });
      if (conflict) {
        issues.push({
          severity: "error",
          code: "strict_timeline_existing_conflict",
          message: `${event.entityKey} conflicts with existing timeline event ${conflict.id} at ${point.at}.`,
        });
      }
    }
  }
  return issues;
}
