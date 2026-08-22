import * as tickets from "../db/repos/tickets";
import type { UpdateInput } from "../db/repos/tickets";
import type { WorkspaceTicket } from "$lib/types";
import {
  serializeTicketFile,
  parseTicketFile,
  ticketFileDiff,
  type TicketVFile,
  type TicketFilePatch,
} from "$lib/tickets/vfile";

const TICKET_PREFIX = "ticket:";

export type TicketPathKind = "single" | "scoped" | "folder";

export interface TicketPathResolution {
  kind: TicketPathKind;
  ticketId?: string;
  /** For single/scoped: the resolved ticket. For folder: undefined. */
  ticket?: WorkspaceTicket;
  /** For single/scoped: true when the ticket exists but status doesn't match the scope. */
  statusMismatch?: boolean;
}

/**
 * Parse a `ticket:` path into its components.
 * Returns null for non-ticket paths.
 *
 * Formats:
 *   ticket:T5        → kind: "single"
 *   ticket:open/T5   → kind: "scoped"
 *   ticket:open      → kind: "folder"
 */
export function parseTicketPath(filePath: string): TicketPathResolution | null {
  if (!filePath.startsWith(TICKET_PREFIX)) return null;
  const rest = filePath.slice(TICKET_PREFIX.length);

  if (rest === "open") {
    return { kind: "folder" };
  }

  if (rest.startsWith("open/")) {
    const ticketId = rest.slice(5);
    if (!ticketId) return { kind: "folder" };
    return { kind: "scoped", ticketId };
  }

  // Any other ticket: prefix is a direct id lookup
  return { kind: "single", ticketId: rest };
}

/**
 * Resolve a parsed ticket path to a ticket record.
 * Returns the ticket and a status-mismatch flag for scoped lookups.
 */
export function resolveTicketPath(
  resolution: TicketPathResolution,
  userId: number,
): { ticket: WorkspaceTicket | null; statusMismatch: boolean } {
  if (resolution.kind === "folder") {
    return { ticket: null, statusMismatch: false };
  }

  const id = resolution.ticketId!;
  const ticket = tickets.get(tickets.ticketInt(id), userId);

  if (!ticket) {
    return { ticket: null, statusMismatch: false };
  }

  // Scope check: ticket:open/T5 only resolves open tickets
  if (resolution.kind === "scoped" && ticket.status !== "open") {
    return { ticket, statusMismatch: true };
  }

  return { ticket, statusMismatch: false };
}

/**
 * Serialize a ticket as virtual file content for the read tool.
 */
export function ticketFileContent(ticket: TicketVFile): string {
  return serializeTicketFile(ticket);
}

/**
 * Apply an edit to a ticket virtual file: parse the edited content,
 * diff it against the current ticket, and write the patch back to the DB.
 * Returns the patch result or an error message.
 */
export function applyTicketFileEdit(
  editedText: string,
  currentTicket: WorkspaceTicket,
  userId: number,
):
  | { ok: true; patch: TicketFilePatch; ticket: WorkspaceTicket }
  | { ok: false; error: string } {
  const parsed = parseTicketFile(editedText);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }

  const currentVFile: TicketVFile = {
    id: currentTicket.id,
    title: currentTicket.title,
    plan: currentTicket.plan,
    body: currentTicket.body,
    status: currentTicket.status,
    priority: currentTicket.priority,
  };

  const patch = ticketFileDiff(currentVFile, parsed.value);
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      error: "No changes detected in the edited ticket file",
    };
  }

  const updateInput: UpdateInput = {};
  if (patch.title !== undefined) updateInput.title = patch.title;
  if (patch.body !== undefined) updateInput.body = patch.body;
  if (patch.plan !== undefined) updateInput.plan = patch.plan;
  if (patch.status !== undefined) updateInput.status = patch.status;
  if (patch.priority !== undefined) updateInput.priority = patch.priority;

  const updated = tickets.update(
    tickets.ticketInt(currentTicket.id),
    userId,
    updateInput,
  );
  if (!updated) {
    return { ok: false, error: `Failed to update ticket ${currentTicket.id}` };
  }

  return { ok: true, patch, ticket: updated };
}

/**
 * Search ticket content for a grep pattern. Returns matches grouped by ticket.
 */
export interface TicketGrepMatch {
  ticketId: string;
  ticketTitle: string;
  lineNumber: number;
  lineContent: string;
}

export function grepTicketFolder(
  pattern: string,
  userId: number,
  workspaceKey: string,
  args: {
    output_mode: "content" | "files_with_matches" | "count";
    "-i"?: boolean;
    "-n"?: boolean;
    head_limit?: number;
    offset?: number;
  },
): TicketGrepMatch[] | { count: number } {
  const openTickets = tickets.list(userId, workspaceKey, { status: "open" });

  const matches: TicketGrepMatch[] = [];
  for (const ticket of openTickets) {
    const lines = ticket.body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const matched = args["-i"]
        ? line.toLowerCase().includes(pattern.toLowerCase())
        : line.includes(pattern);
      if (matched) {
        matches.push({
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          lineNumber: i + 1,
          lineContent: line,
        });
      }
    }
  }

  if (args.output_mode === "count") {
    return { count: matches.length };
  }

  const start = args.offset ?? 0;
  const limit = args.head_limit ?? matches.length;
  const sliced = matches.slice(start, start + limit);

  if (args.output_mode === "files_with_matches") {
    // Return deduplicated ticket references (one entry per matching ticket).
    const seen = new Set<string>();
    const deduped: TicketGrepMatch[] = [];
    for (const m of matches) {
      if (!seen.has(m.ticketId)) {
        seen.add(m.ticketId);
        deduped.push(m);
      }
    }
    return deduped;
  }

  return sliced;
}

/**
 * Grep a single ticket's content for a pattern.
 */
export function grepSingleTicket(
  ticket: WorkspaceTicket,
  pattern: string,
  args: {
    output_mode: "content" | "files_with_matches" | "count";
    "-i"?: boolean;
    "-n"?: boolean;
    head_limit?: number;
    offset?: number;
  },
): TicketGrepMatch[] | { count: number } {
  const lines = ticket.body.split("\n");
  const matches: TicketGrepMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const matched = args["-i"]
      ? line.toLowerCase().includes(pattern.toLowerCase())
      : line.includes(pattern);
    if (matched) {
      matches.push({
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        lineNumber: i + 1,
        lineContent: line,
      });
    }
  }

  if (args.output_mode === "count") {
    return { count: matches.length };
  }

  const start = args.offset ?? 0;
  const limit = args.head_limit ?? matches.length;
  return matches.slice(start, start + limit);
}
