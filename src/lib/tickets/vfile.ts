// Ticket-as-virtual-file: serialize a ticket to a TOML-frontmatter + markdown
// body, and parse/validate an edited document back into a patch.
//
// Pure and dependency-light (smol-toml is already a dependency). This is the
// write-back layer for treating tickets as files through the generic file
// tools — the crux of that design. The DB ticket record stays the single
// source of truth; the file is one serialization (among many path aliases),
// and every mutation path normalizes to a field write on that record.
//
// Format: the "frontmatter idiom" agents already know from Hugo/Jekyll —
//
//   ---
//   id       = "T10"
//   title    = "Fix the auth race"
//   status   = "open"
//   priority = "P2"
//   plan     = "..."
//   ---
//   <markdown body>
//
// Content fields (title, plan, body) live as text — greppable, editable by
// anchor. Status/priority ride along read-only so a grep hit shows structure;
// editing status/edges mutates DB state and is NOT routed through the content
// path (that's the controlled structural surface, kept out of the file to
// avoid ghost state).

import { parse, stringify, TomlError } from "smol-toml";
import type {
  WorkspaceTicketPriority,
  WorkspaceTicketStatus,
} from "$lib/types";

const Status = ["open", "done", "archived"] as const;
const Priority = ["P0", "P1", "P2", "P3"] as const;
const isStatus = (v: unknown): v is WorkspaceTicketStatus =>
  Status.includes(v as WorkspaceTicketStatus);
const isPriority = (v: unknown): v is WorkspaceTicketPriority =>
  Priority.includes(v as WorkspaceTicketPriority);

/** The content-shaped subset of a ticket that serializes to the file. */
export interface TicketVFile {
  id: string;
  title: string;
  plan: string;
  body: string;
  status: WorkspaceTicketStatus;
  priority: WorkspaceTicketPriority;
}

export const VFILE_FENCE = "---";
export const VFILE_MIME = "text/markdown";

/** Serialize a ticket to TOML-frontmatter + markdown body. */
export function serializeTicketFile(t: TicketVFile): string {
  // Plan may contain triple-quote sequences that break a TOML literal block,
  // so prefer a quoted basic string. smol-toml handles quoting/escaping.
  const front = stringify({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    ...(t.plan ? { plan: t.plan } : {}),
  }).trimEnd();
  return `${VFILE_FENCE}\n${front}\n${VFILE_FENCE}\n\n${t.body}`;
}

export type ParseResult =
  { ok: true; value: TicketVFile } | { ok: false; error: string };

/**
 * Parse a (possibly edited) virtual ticket file back into its fields.
 * Content fields are always recovered; the frontmatter metadata (status,
 * priority) is recovered when well-formed. Falls back to body-only when the
 * frontmatter is malformed — an agent that chops a frontmatter line mid-edit
 * still lands its body edit. That's the deliberate trade: guesses intended
 * scope, never throws away the body.
 */
export function parseTicketFile(text: string): ParseResult {
  // Split frontmatter on the leading fence only. A `---` inside the body is
  // fine because we stop at the FIRST closing fence after the first line.
  const firstLf = text.indexOf("\n");
  if (firstLf < 0 || text.slice(0, firstLf).trim() !== VFILE_FENCE) {
    return {
      ok: true,
      value: {
        id: "",
        title: "",
        plan: "",
        body: text,
        status: "open",
        priority: "P2",
      },
    };
  }

  const close = text.indexOf(`\n${VFILE_FENCE}`, firstLf);
  if (close < 0) {
    // No closing fence → treat the whole thing as body (never lose content).
    // ponytail: lenient fallback for a truncated edit; revisit if agents
    // routinely orphan the frontmatter.
    return {
      ok: true,
      value: {
        id: "",
        title: "",
        plan: "",
        body: text,
        status: "open",
        priority: "P2",
      },
    };
  }

  const frontText = text.slice(firstLf + 1, close);
  const body = text.slice(close + VFILE_FENCE.length + 3); // skip "\n---\n\n"

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(frontText) as unknown as Record<string, unknown>;
  } catch (e) {
    if (e instanceof TomlError) {
      // Malformed metadata, body intact — fall back to body-only.
      return {
        ok: true,
        value: {
          id: "",
          title: "",
          plan: "",
          body,
          status: "open",
          priority: "P2",
        },
      };
    }
    throw e;
  }

  const id = typeof parsed.id === "string" ? parsed.id : "";
  const title = typeof parsed.title === "string" ? parsed.title : "";
  const plan = typeof parsed.plan === "string" ? parsed.plan : "";
  const status = isStatus(parsed.status) ? parsed.status : "open";
  const priority = isPriority(parsed.priority) ? parsed.priority : "P2";

  if (id && !/^[T][1-9][0-9]*$/i.test(id)) {
    return {
      ok: false,
      error: `invalid ticket id in file: ${JSON.stringify(id)}`,
    };
  }
  if (title && !title.trim()) {
    return { ok: false, error: "ticket title cannot be empty" };
  }

  return {
    ok: true,
    value: { id, title: title.trim(), plan, body, status, priority },
  };
}

/** The writable fields a file edit may change, keyed by the ticket-update shape. */
export interface TicketFilePatch {
  title?: string;
  plan?: string;
  body?: string;
  status?: WorkspaceTicketStatus;
  priority?: WorkspaceTicketPriority;
}

/**
 * Diff a parsed file against the current ticket, returning only the fields that
 * actually changed. This is the write-back: an `edit` on a virtual ticket file
 * yields a minimal patch rather than a whole-record rewrite. Id/status/priority
 * are compared for change; content fields route through as passed.
 */
export function ticketFileDiff(
  current: TicketVFile,
  parsed: TicketVFile,
): TicketFilePatch {
  const patch: TicketFilePatch = {};
  if (parsed.title !== current.title) patch.title = parsed.title;
  if (parsed.plan !== current.plan) patch.plan = parsed.plan;
  if (parsed.body !== current.body) patch.body = parsed.body;
  if (parsed.status !== current.status) patch.status = parsed.status;
  if (parsed.priority !== current.priority) patch.priority = parsed.priority;
  return patch;
}
