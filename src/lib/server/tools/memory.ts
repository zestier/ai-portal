import type { PortalTool } from "./types";
import { buildMemorySearchTools } from "./memory/search";
import { buildMemoryEntityTools } from "./memory/entities";
import { buildMemoryLoopsTools } from "./memory/loops";
import { buildMemoryEventsTools } from "./memory/events";
import { buildMemoryTranscriptTools } from "./memory/transcript";
import { buildMemoryKnowledgeTools } from "./memory/knowledge";
import { buildMemoryMergeTools } from "./memory/merge";
import { buildMemoryGlobalTools } from "./memory/global";
import { buildMemoryPacketTools } from "./memory/packet";
import type { MemoryToolsOpts } from "./memory/common";

export * from "./memory/common";
export * from "./memory/search";
export * from "./memory/entities";
export * from "./memory/loops";
export * from "./memory/events";
export * from "./memory/transcript";
export * from "./memory/knowledge";
export * from "./memory/merge";
export * from "./memory/global";
export * from "./memory/packet";
export type { MemoryToolsOpts } from "./memory/common";

export function buildMemoryTools(opts: MemoryToolsOpts): PortalTool[] {
  if (opts.mode === "off") return [];
  const tools: PortalTool[] = [
    ...buildMemorySearchTools(opts),
    ...buildMemoryEntityTools(opts),
    ...buildMemoryLoopsTools(opts),
    ...buildMemoryEventsTools(opts),
    ...buildMemoryTranscriptTools(opts),
    ...buildMemoryKnowledgeTools(opts),
    ...buildMemoryMergeTools(opts),
    ...buildMemoryGlobalTools(opts),
    ...buildMemoryPacketTools(opts),
  ];
  return opts.globalMemoryEnabled
    ? tools
    : tools.filter((tool) => !tool.name.startsWith("memory_global_"));
}
