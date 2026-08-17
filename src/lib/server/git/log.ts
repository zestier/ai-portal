import { emptyResult, GitError, runGitOk } from "./run";
import { isSafeRef } from "./repo";
import { safeResolve } from "../files";

export interface LogEntry {
  sha: string;
  shortSha: string;
  author: string;
  email: string;
  timestamp: number;
  subject: string;
}

const LOG_SEP = "\x1f";
const LOG_REC = "\x1e";
const LOG_FORMAT =
  ["%H", "%h", "%an", "%ae", "%at", "%s"].join(LOG_SEP) + LOG_REC;

export async function log(
  cwd: string,
  opts: {
    limit?: number | undefined;
    skip?: number | undefined;
    ref?: string | undefined;
    path?: string | undefined;
  } = {},
): Promise<LogEntry[]> {
  const limit = Math.min(opts.limit ?? 20, 200);
  const skip = Math.max(opts.skip ?? 0, 0);
  const args = [
    "log",
    `--max-count=${limit}`,
    `--skip=${skip}`,
    `--pretty=format:${LOG_FORMAT}`,
  ];
  if (opts.ref) {
    // Only allow refs matching a conservative pattern (no spaces, no
    // flags, no shell metacharacters).
    if (!isSafeRef(opts.ref)) {
      throw new GitError("invalid ref", {
        stdout: "",
        stderr: "invalid ref",
        code: -1,
        timedOut: false,
        truncated: false,
      });
    }
    args.push(opts.ref);
  }
  if (opts.path !== undefined && opts.path !== "") {
    const r = safeResolve(cwd, opts.path);
    if (!r.ok) throw new GitError(`invalid path: ${r.reason}`, emptyResult());
    args.push("--", r.rel);
  }
  const out = await runGitOk(args, { cwd });
  const records = out.split(LOG_REC).filter((s) => s.length > 0);
  return records.map((rec) => {
    const [sha, shortSha, author, email, ts, ...subjectParts] = rec
      .trim()
      .split(LOG_SEP);
    return {
      sha,
      shortSha,
      author,
      email,
      timestamp: Number(ts) * 1000,
      subject: subjectParts.join(LOG_SEP),
    };
  });
}
