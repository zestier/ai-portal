import type { FileEditRecord, Message, ReasoningBlockRecord } from "$lib/types";

/**
 * A message as rendered in the transcript. Persisted rows carry INTEGER ids
 * straight from the API, but the client also shows ephemeral bubbles —
 * optimistic `local-`/`err-` messages and a `thinking-placeholder` — and
 * reasoning / file-edit records only get their real INTEGER ids once the
 * server persists them. Those ephemeral ids are strings, so the rendered
 * shapes widen `id` to `number | string`. Display-only: the API layer and the
 * shared types stay INTEGER end to end.
 */
export type DisplayId = number | string;

export type DisplayReasoningBlock = Omit<ReasoningBlockRecord, "id"> & {
  id: DisplayId;
};
export type DisplayFileEdit = Omit<FileEditRecord, "id"> & { id: DisplayId };

export type DisplayMessage = Omit<
  Message,
  "id" | "reasoningBlocks" | "fileEdits"
> & {
  id: DisplayId;
  reasoningBlocks?: DisplayReasoningBlock[];
  fileEdits?: DisplayFileEdit[];
};
