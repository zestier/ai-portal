// Header-line summary text for tool calls (e.g. "bash · echo hi" or
// "view · src/foo.ts [1-30]"). Pure: a function of the tool name and the
// JSON-encoded arguments. Kept out of the renderer so it can be unit
// tested without spinning up Svelte.
//
// Shared module (moved from $lib/client): the server computes collapsed
// summaries at read time for the backend-projected transcript, and the
// client still derives them for live streamed records.

function truncate(s: string, n = 80): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

function parseArgs(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

type SummaryHandler = (args: Record<string, unknown>) => string | null;

const summaryHandlers: Record<string, SummaryHandler> = {
  bash: commandSummary,
  task: taskSummary,
  resolve: semanticSummary,
  program: semanticSummary,
  read: readPathSummary,
  edit: pathSummary,
  write: pathSummary,
  grep: grepSummary,
  ls: pathSummary,
  find: patternSummary,
  git_diff: gitDiffSummary,
  git_log: gitLogSummary,
  git_show_commit: gitShowCommitSummary,
  git_commit: gitCommitSummary,
  git_show_file: gitShowFileSummary,
  git_worktree_merge: gitWorktreeMergeSummary,
  memory_search: memoryQuerySummary,
  memory_global_search: memoryQuerySummary,
  memory_get_transcript: memoryQuerySummary,
  memory_get_entity: entityIdSummary,
  memory_get_character_knowledge: characterKnowledgeSummary,
  memory_merge_entities: mergeEntitiesSummary,
  memory_global_record: globalRecordSummary,
  memory_get_recent_events: eventFilterSummary,
  memory_query_timeline: eventFilterSummary,
  memory_get_open_loops: loopTypeSummary,
  memory_query_clues: clueStatusSummary,
  memory_check_claims: checkClaimsSummary,
  ticket_add: ticketAddSummary,
  ticket_get: ticketIdSummary,
  ticket_update: ticketUpdateSummary,
  ticket_list: ticketListSummary,
  permission_capabilities: permissionCapabilitiesSummary,
  request_permission_grant: grantRequestSummary,
};

// Split a header summary into chunks that each end at a path separator
// ('/' or '\'), keeping the separator attached to the preceding chunk. The
// renderer inserts a `<wbr>` between chunks so a long path wraps *after* a
// slash (e.g. ".../messages/" → "[messageId]/" → "edit/+server.ts") rather
// than overflowing or snapping mid-segment. Pure + exported so it stays
// unit-testable without spinning up Svelte.
//
// Implemented with a global match rather than a lookbehind split so it runs
// on browsers without regex lookbehind support (e.g. Safari < 16.4): each
// match is either a run of non-separators ending in a separator, or a final
// trailing run with no separator.
export function splitSummaryForWrap(summary: string): string[] {
  return summary.match(/[^/\\]*[/\\]|[^/\\]+/g) ?? [];
}

export function summarizeToolCall(
  tool: string,
  argsJson: string | null,
): string | null {
  if (argsJson === null) return null;
  const t = tool.toLowerCase();
  const args = parseArgs(argsJson);
  // `multi_edit` summarizes by the unique files its `edits` array touches,
  // mirroring the "file.txt +N more" shape the removed apply_patch used.
  if (t === "multi_edit" && args && Array.isArray(args.edits)) {
    const paths = new Set<string>();
    for (const raw of args.edits) {
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const path = str((raw as Record<string, unknown>).file_path);
        if (path) paths.add(path);
      }
    }
    const unique = [...paths];
    if (unique.length === 1) return unique[0];
    if (unique.length > 1) return `${unique[0]} +${unique.length - 1} more`;
  }

  if (!args) return null;
  const handler = summaryHandlers[t];
  if (handler) return handler(args);
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length > 0) return truncate(v, 80);
  }
  return null;
}

function commandSummary(args: Record<string, unknown>): string | null {
  const desc = str(args.description);
  if (desc) return desc;
  const cmd = str(args.command) ?? str(args.cmd);
  return cmd ? truncate(cmd, 60) : null;
}

function pathSummary(args: Record<string, unknown>): string | null {
  return (
    str(args.path) ??
    str(args.file) ??
    str(args.filename) ??
    str(args.file_path)
  );
}

// `task` is the portal's sub-agent tool (turn-runner emits `task` calls for
// sub-agent and memory-extractor work); the description is the human-meaningful
// label for the collapsed row.
function taskSummary(args: Record<string, unknown>): string | null {
  return str(args.description) ?? str(args.name);
}

function semanticSummary(args: Record<string, unknown>): string | null {
  return str(args.summary);
}

function readPathSummary(args: Record<string, unknown>): string | null {
  const p = pathSummary(args);
  const range = Array.isArray(args.view_range) ? args.view_range : null;
  if (p && range && range.length === 2) return `${p} [${range[0]}-${range[1]}]`;
  return p;
}

function grepSummary(args: Record<string, unknown>): string | null {
  const pat = str(args.pattern);
  const glob = str(args.glob) ?? str(args.type);
  if (pat && glob) return `${pat}  (${glob})`;
  return pat;
}

function patternSummary(args: Record<string, unknown>): string | null {
  return str(args.pattern);
}

function gitDiffSummary(args: Record<string, unknown>): string {
  const output = str(args.output) ?? "patch";
  const target = str(args.target) ?? "worktree-vs-head";
  const path = str(args.path);
  return [output, target, path].filter(Boolean).join(" · ");
}

function gitLogSummary(args: Record<string, unknown>): string | null {
  const ref = str(args.ref);
  const path = str(args.path);
  if (ref && path) return `${ref} · ${path}`;
  return path ?? ref ?? null;
}

function gitShowCommitSummary(args: Record<string, unknown>): string | null {
  const sha = str(args.sha);
  return args.includePatch === true && sha ? `${sha} · patch` : sha;
}

// The bare `direction` value ("to-source") reads as jargon in a collapsed line,
// so spell out which way the work is moving.
function gitWorktreeMergeSummary(args: Record<string, unknown>): string | null {
  const direction = str(args.direction);
  if (!direction) return null;
  const label =
    direction === "to-source"
      ? "integrate into source branch"
      : "sync from source branch";
  return args.allowMergeCommit === true
    ? `${label} (allow merge commit)`
    : label;
}

function gitCommitSummary(args: Record<string, unknown>): string | null {
  const subject = str(args.subject);
  const paths = args.paths;
  const trailers = Array.isArray(args.trailers) ? args.trailers.length : 0;
  const hasBody = str(args.body) !== null;
  const target =
    paths === "all"
      ? "all changes"
      : Array.isArray(paths)
        ? paths.length === 1
          ? String(paths[0])
          : `${String(paths[0])} +${paths.length - 1} more`
        : null;
  const extras = [
    // The transcript row is the only place a reader sees that a commit went
    // somewhere other than this conversation's workspace.
    str(args.worktree)
      ? `in worktree ${truncate(String(args.worktree), 30)}`
      : null,
    hasBody ? "body" : null,
    trailers ? `${trailers} trailers` : null,
  ].filter(Boolean);
  const main = [subject ? truncate(subject, 50) : null, target]
    .filter(Boolean)
    .join(" · ");
  return [main || null, ...extras].filter(Boolean).join(" · ") || null;
}

function gitShowFileSummary(args: Record<string, unknown>): string | null {
  const path = str(args.path);
  const ref = str(args.ref);
  if (path && ref) return `${ref} · ${path}`;
  return path ?? ref ?? null;
}

function memoryQuerySummary(args: Record<string, unknown>): string | null {
  const query = str(args.query);
  return query ? truncate(query, 60) : null;
}

function entityIdSummary(args: Record<string, unknown>): string | null {
  return str(args.id);
}

function characterKnowledgeSummary(
  args: Record<string, unknown>,
): string | null {
  return str(args.characterEntityKey);
}

function mergeEntitiesSummary(args: Record<string, unknown>): string | null {
  const from = str(args.from);
  const into = str(args.into);
  if (from && into) return `${from} → ${into}`;
  return from ?? into ?? null;
}

function globalRecordSummary(args: Record<string, unknown>): string | null {
  const kind = str(args.kind);
  const key = str(args.key);
  if (kind && key) return `${kind} · ${key}`;
  return key ?? kind ?? null;
}

function eventFilterSummary(args: Record<string, unknown>): string | null {
  const eventType = str(args.eventType);
  const entityId = str(args.entityId);
  return [eventType, entityId].filter(Boolean).join(" · ") || null;
}

function loopTypeSummary(args: Record<string, unknown>): string | null {
  return str(args.loopType);
}

function clueStatusSummary(args: Record<string, unknown>): string | null {
  return str(args.status);
}

function checkClaimsSummary(args: Record<string, unknown>): string | null {
  const claims = Array.isArray(args.claims) ? args.claims.length : 0;
  return claims ? `${claims} claim(s)` : null;
}

function ticketAddSummary(args: Record<string, unknown>): string | null {
  const title = str(args.title);
  return title ? truncate(title, 60) : null;
}

function ticketIdSummary(args: Record<string, unknown>): string | null {
  return str(args.id);
}

function ticketUpdateSummary(args: Record<string, unknown>): string | null {
  const id = str(args.id);
  const status = str(args.status);
  if (id && status) return `${id} · ${status}`;
  return id;
}

function ticketListSummary(args: Record<string, unknown>): string {
  return str(args.status) ?? "all";
}

function permissionCapabilitiesSummary(
  args: Record<string, unknown>,
): string | null {
  const kind = str(args.permissionKind);
  const tool = str(args.toolName);
  if (kind && tool) return `${kind} · ${tool}`;
  return kind ?? tool ?? null;
}

function grantRequestSummary(args: Record<string, unknown>): string | null {
  const tool = str(args.tool);
  const scope = args.scope;
  let argv0: string | null = null;
  if (scope && typeof scope === "object") {
    const rule = (scope as Record<string, unknown>).rule;
    if (rule && typeof rule === "object") {
      const command = (rule as Record<string, unknown>).command;
      if (
        Array.isArray(command) &&
        command[0] &&
        typeof command[0] === "object"
      ) {
        argv0 = str((command[0] as Record<string, unknown>).token);
      }
      argv0 ??= str((rule as Record<string, unknown>).host);
    }
  }
  if (tool && argv0) return `${tool} · ${argv0}`;
  return tool ?? null;
}
