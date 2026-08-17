// Pure helpers for the "code review" feature: collecting per-line feedback in
// the file browser and assembling it into a chat message. Kept in a plain .ts
// module (no runes) so the formatting logic stays trivially unit-testable.

export type ReviewSide = "new" | "old" | "file";

export interface ReviewLocation {
  /** Repo-relative file path the comment is attached to. */
  path: string;
  /**
   * Which side of the code the line belongs to: `new`/`old` for a diff
   * hunk, or `file` for the plain content view.
   */
  side: ReviewSide;
  /** 1-based line number, or null when it can't be determined. */
  lineNo: number | null;
  /** The code on that line, for context in the assembled message. */
  lineText: string;
  /** Commit SHA when the comment targets a commit diff; null otherwise. */
  sha?: string | null;
}

export interface ReviewComment extends ReviewLocation {
  id: string;
  /** The reviewer's free-text feedback. */
  body: string;
}

/**
 * Stable identity for a single reviewable line, used to mark already-commented
 * lines in the UI and to avoid attaching two drafts to the same spot.
 */
export function lineKey(
  loc: Pick<ReviewLocation, "path" | "side" | "lineNo" | "sha">,
): string {
  return `${loc.sha ?? ""}\u0000${loc.path}\u0000${loc.side}\u0000${loc.lineNo ?? ""}`;
}

function locationLabel(c: ReviewComment): string {
  if (c.lineNo == null) return "general";
  const sidePrefix = c.side === "old" ? "old line " : "line ";
  return `${sidePrefix}${c.lineNo}`;
}

function truncate(text: string, max = 200): string {
  const oneLine = text.replace(/\s+$/u, "");
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + "…";
}

/**
 * Assemble collected review comments into a single Markdown message suitable
 * for dropping into the chat composer. Comments are grouped by file (and
 * commit, when present) and ordered by line number so the agent gets a tidy,
 * review-style summary.
 */
export function formatReviewMessage(comments: ReviewComment[]): string {
  if (comments.length === 0) return "";

  type Group = { heading: string; items: ReviewComment[] };
  const groups = new Map<string, Group>();
  for (const c of comments) {
    const groupKey = `${c.sha ?? ""}\u0000${c.path}`;
    const heading = c.sha ? `${c.path} (commit ${c.sha.slice(0, 8)})` : c.path;
    let group = groups.get(groupKey);
    if (!group) {
      group = { heading, items: [] };
      groups.set(groupKey, group);
    }
    group.items.push(c);
  }

  const total = comments.length;
  const lines: string[] = [
    `Here is my code review with ${total} comment${total === 1 ? "" : "s"}. ` +
      `Please address each item and explain any you disagree with.`,
    "",
  ];

  for (const group of groups.values()) {
    lines.push(`### \`${group.heading}\``);
    const sorted = [...group.items].sort(
      (a, b) => (a.lineNo ?? 0) - (b.lineNo ?? 0),
    );
    for (const c of sorted) {
      lines.push(`- **${locationLabel(c)}** — \`${truncate(c.lineText)}\``);
      for (const bodyLine of c.body.trim().split("\n")) {
        lines.push(`  ${bodyLine}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
