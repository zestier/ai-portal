import { conversationId as convCodec } from "$lib/ids";
import * as memoryRepo from "$lib/server/db/repos/memory";
import type { AgeOpenLoopsResult } from "./types";

/**
 * Open-loop liveness ("touch-to-keep"). LLMs reliably notice what is present but
 * are poor at noticing what is *absent*, which is why open loops historically
 * accumulate forever — closing one requires spotting that a thread is no longer
 * live. This inverts the burden: every model-backed extraction the model lists
 * the loops that are still live (`keptLoopIds`); a loop that was presented to
 * the extractor but is neither kept nor closed accrues an idle turn, and once it
 * has been ignored for `baseThreshold + max(0, priority)` consecutive passes it
 * is auto-dropped.
 *
 * Only loops in `presentedLoopIds` are eligible — a loop the extractor never saw
 * (e.g. beyond the packet's open-loop cap) is never silently culled. The whole
 * mechanism is event-sourced (see `memoryRepo.recordOpenLoopLiveness`): the idle
 * counter and auto-drop are derived by replaying the liveness events, so
 * fork/rewind reconstruct them faithfully, and the drop is audited and
 * reversible like any other memory mutation.
 */
export function ageOpenLoops(
  conversationId: string | number,
  opts: {
    presentedLoopIds: Iterable<number>;
    keptLoopIds?: Iterable<number> | undefined;
    baseThreshold: number;
    sourceMessageId?: string | number | null | undefined;
    turnId?: string | null | undefined;
  },
): AgeOpenLoopsResult {
  const intConv =
    typeof conversationId === "number"
      ? conversationId
      : convCodec.parse(conversationId);
  return memoryRepo.recordOpenLoopLiveness(intConv, {
    presentedLoopIds: [...opts.presentedLoopIds],
    keptLoopIds: opts.keptLoopIds ? [...opts.keptLoopIds] : [],
    baseThreshold: opts.baseThreshold,
    sourceMessageId: opts.sourceMessageId,
    turnId: opts.turnId,
  });
}

export function isHiddenVisibility(visibility: string | undefined): boolean {
  return (
    visibility === "hidden" || visibility === "private" || visibility === "gm"
  );
}

export function isSecretPredicate(predicate: string): boolean {
  return /(^|[:._-])(secret|gm_secret|hidden|private)([:._-]|$)/i.test(
    predicate,
  );
}

export function hasObjectStringFields(
  value: unknown,
  fields: string[],
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return fields.every(
    (field) =>
      typeof record[field] === "string" && record[field].trim().length > 0,
  );
}

export function isTimelineEvent(eventType: string): boolean {
  return (
    eventType === "timeline" ||
    eventType === "alibi" ||
    eventType === "location"
  );
}

export function timelinePoint(
  payload: unknown,
): { at: string; location: string } | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const record = payload as Record<string, unknown>;
  const at =
    typeof record.at === "string"
      ? record.at
      : typeof record.time === "string"
        ? record.time
        : "";
  const location =
    typeof record.location === "string"
      ? record.location
      : typeof record.place === "string"
        ? record.place
        : "";
  if (!at.trim() || !location.trim()) return null;
  return { at: at.trim(), location: location.trim() };
}
