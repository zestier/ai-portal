import type {
  WorkspaceTicketPriority,
  WorkspaceTicketStatus,
} from "$lib/types";

/**
 * Canonical model-relevant ticket fields. Single source of truth shared by the
 * `ticket_get` tool's projection (compact view = this set minus `plan`) and the
 * ticket-action launch prompt's `{{ticket.all}}` block, so the two can never
 * drift apart. `blockedBy`/`blocks` are edge lists the server attaches only
 * when non-empty; the client's plain ticket row omits them.
 */
export const TICKET_MODEL_FIELDS = [
  "id",
  "title",
  "priority",
  "status",
  "body",
  "plan",
  "blockedBy",
  "blocks",
] as const;

export interface TicketModelLike {
  id: string;
  title: string;
  body: string;
  plan: string;
  priority?: WorkspaceTicketPriority;
  status?: WorkspaceTicketStatus;
  blockedBy?: unknown[];
  blocks?: unknown[];
}

/**
 * Full model-facing view of a ticket, dropping empty fields — the same shape
 * `ticket_get` returns with `plan` included. Reused verbatim by the action
 * launch so the prompt shows exactly what the tool would have returned.
 */
export function ticketModelView(
  ticket: TicketModelLike,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of TICKET_MODEL_FIELDS) {
    const value = (ticket as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null || value === "") continue;
    out[field] = value;
  }
  return out;
}
