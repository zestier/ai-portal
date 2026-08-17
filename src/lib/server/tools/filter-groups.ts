import type { PortalTool } from "./types";
import {
  PORTAL_TOOL_GROUP_IDS,
  type PortalToolGroupId,
} from "$lib/tools/groups";

export type GroupedPortalTools = Record<PortalToolGroupId, PortalTool[]>;

/**
 * Flatten per-group tool builder outputs into the single `portalTools` array a
 * provider hands to the SDK, dropping any group whose id appears in
 * `disabledGroupIds`. Groups are emitted in the canonical
 * `PORTAL_TOOL_GROUP_IDS` order so the resulting tool list is deterministic and
 * independent of the order the caller populated `grouped`.
 *
 * Unknown ids in `disabledGroupIds` are ignored (they simply match no group),
 * so callers may pass raw persisted values without pre-sanitizing.
 */
export function filterPortalToolGroups(
  grouped: GroupedPortalTools,
  disabledGroupIds: readonly string[] = [],
): PortalTool[] {
  const disabled = new Set(disabledGroupIds);
  const out: PortalTool[] = [];
  for (const id of PORTAL_TOOL_GROUP_IDS) {
    if (disabled.has(id)) continue;
    out.push(...grouped[id]);
  }
  return out;
}
