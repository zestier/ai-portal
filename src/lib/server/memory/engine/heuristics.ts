import type { MemoryMode, Message } from "$lib/types";
import { cleanSentence } from "./render";
import type { MemoryPatchProposal } from "./types";

export function extractHeuristicPatch(params: {
  userMsg: Message;
  assistantContent: string;
  mode: MemoryMode;
}): MemoryPatchProposal {
  const combined =
    `${params.userMsg.content}\n\n${params.assistantContent}`.trim();
  const patch: MemoryPatchProposal = { events: [], facts: [], openLoops: [] };
  if (!combined) return patch;

  if (
    /\b(todo|follow[- ]?up|open question|remember to|next step)\b/i.test(
      combined,
    )
  ) {
    patch.openLoops?.push({
      loopType: params.mode === "project" ? "project_task" : "follow_up",
      title: cleanSentence(params.userMsg.content).slice(0, 160),
      description:
        "Heuristically extracted as an unresolved loop from the latest turn.",
      priority: 0,
    });
  }

  if (params.mode === "story" || params.mode === "strict") {
    const nameMatch = combined.match(
      /\b(character|npc|person)\s+([A-Z][A-Za-z0-9_-]{1,40})\b/,
    );
    if (nameMatch) {
      const entityKey = `character.${nameMatch[2].toLowerCase()}`;
      patch.entities?.push({
        entityKey,
        entityType: "character",
        displayName: nameMatch[2],
        summary: "Mentioned in the story session.",
      });
      patch.facts?.push({
        entityKey,
        predicate: "mentioned",
        value: true,
        confidence: 0.55,
      });
    }
  }

  patch.events?.push({
    eventType: "turn_observed",
    summary: cleanSentence(params.userMsg.content).slice(0, 240),
    payload: { mode: params.mode },
    confidence: 1,
  });

  return patch;
}
