import { getMode } from "./common";
import { convInt, type MemorySnapshot } from "./rows";
import { listEntities } from "./entities";
import { listFacts } from "./facts";
import { listOpenLoops } from "./loops";
import { listEvents } from "./events";
import { listPatches } from "./patches";
import { listPatchItems } from "./patches";
import { listIssues } from "./issues";
import { listToolCalls } from "./tool-calls";
import { listGlobalMemories } from "./global";

export function listSnapshot(
  conversationId: string | number,
  opts: { userId?: number } = {},
): MemorySnapshot {
  const intConv = convInt(conversationId);
  return {
    mode: getMode(intConv),
    entities: listEntities(intConv, { limit: 200 }),
    facts: listFacts(intConv, { limit: 300 }),
    openLoops: listOpenLoops(intConv, { status: "open", limit: 100 }),
    events: listEvents(intConv, { limit: 100 }),
    patches: listPatches(intConv, { limit: 50 }),
    issues: listIssues(intConv, { limit: 100 }),
    toolCalls: listToolCalls(intConv, { limit: 50 }),
    patchItems: listPatchItems(intConv, { limit: 200 }),
    globalMemories: opts.userId
      ? listGlobalMemories(opts.userId, { limit: 100 })
      : undefined,
  };
}
