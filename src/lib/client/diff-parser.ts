// Parses unified diff text (e.g. `git diff` output) into rows annotated with
// old/new line numbers. Kept in a plain .ts module so it can be unit tested.

export type DiffLineKind =
  "add" | "del" | "context" | "hunk" | "meta" | "nonewline";

export interface DiffLine {
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

export const MAX_RENDERABLE_DIFF_CHARS = 2_000_000;

export function isRenderableDiff(diff: string): boolean {
  return diff.length <= MAX_RENDERABLE_DIFF_CHARS;
}

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = [];
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
        inHunk = true;
      }
      out.push({ kind: "hunk", oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (!inHunk) {
      out.push({ kind: "meta", oldNo: null, newNo: null, text: raw });
      continue;
    }
    if (raw.startsWith("\\")) {
      out.push({ kind: "nonewline", oldNo: null, newNo: null, text: raw });
      continue;
    }
    const first = raw.charAt(0);
    if (first === "+") {
      out.push({
        kind: "add",
        oldNo: null,
        newNo: newNo++,
        text: raw.slice(1),
      });
    } else if (first === "-") {
      out.push({
        kind: "del",
        oldNo: oldNo++,
        newNo: null,
        text: raw.slice(1),
      });
    } else {
      const text = first === " " ? raw.slice(1) : raw;
      out.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text });
    }
  }
  return out;
}

export function diffStats(parsed: DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const l of parsed) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
  }
  return { added, removed };
}
