import { spawn } from "node:child_process";
import { isolatedChildEnv } from "../child-env";
import { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS } from "./common";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  truncated: boolean;
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly result: GitRunResult,
  ) {
    super(message);
    this.name = "GitError";
  }
}

// pre-commit/commit-msg/test hooks can dump huge stderr into a GitError.message,
// which is rendered verbatim to the model. Keep the TRAILING stderr (hook/test
// failure reasons print last) at a bounded size so a roaring hook can't pump
// tens of KiB into context.
export const MAX_ERROR_STDERR_CHARS = 8_192;

function gitErrorStderrTail(stderr: string): string {
  const trimmed = stderr.trim();
  if (trimmed.length <= MAX_ERROR_STDERR_CHARS) return trimmed;
  const omitted = trimmed.length - MAX_ERROR_STDERR_CHARS;
  const tail = trimmed.slice(-MAX_ERROR_STDERR_CHARS);
  return `[${omitted} bytes of stderr omitted — showing tail]\n${tail}`;
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  // Optional streaming hook. When provided, invoked with the full cumulative
  // combined (stdout+stderr, in arrival order) snapshot each time child output
  // arrives. The snapshot is bounded by `maxBytes`, so emission size stays
  // capped. Callers that omit this stay fully buffered/silent (unchanged).
  onData?: ((snapshot: string) => void) | undefined;
  // Optional abort signal. When it fires, the child is SIGKILLed and no further
  // `onData` snapshots are emitted (mirrors the existing timeout kill path).
  signal?: AbortSignal | undefined;
}

// Streaming context for `commitChanges`. Structurally satisfied by the tool
// layer's `ToolStreamContext`, but kept independent here to avoid a server→tools
// import cycle. All fields optional so non-streaming callers pass nothing.
export interface CommitProgress {
  progress?(message: string): void;
  partial?(snapshot: string): void;
  readonly signal?: AbortSignal | undefined;
}

function runGit(args: string[], opts: RunOptions): Promise<GitRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      shell: false,
      env: isolatedChildEnv(process.env, {
        // Disable interactive prompts and pagers. Git hooks still run for commits.
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_OPTIONAL_LOCKS: "0",
        LC_ALL: "C",
      }),
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const settle = (result: GitRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSignal();
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // Combined stdout+stderr buffer in arrival order, only maintained when a
    // streaming consumer is attached. Emitting the full current string each
    // time matches `tool.partial_output` replace-not-append semantics. Bounded
    // by `maxBytes` so snapshot (and downstream queue) growth stays capped.
    const onData = opts.onData;
    let combined = onData ? Buffer.alloc(0) : null;
    const emitSnapshot = (chunk: Buffer) => {
      if (!onData || combined === null || aborted) return;
      if (combined.length >= maxBytes) return;
      const room = maxBytes - combined.length;
      combined = Buffer.concat([combined, chunk.subarray(0, room)]);
      onData(combined.toString("utf-8"));
    };

    let aborted = false;
    const signal = opts.signal;
    const killForAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
      // Resolve promptly rather than waiting for `close`: an orphaned hook
      // process can keep the stdio pipes open after the git child is killed,
      // which would otherwise stall `close` until the hook itself exits.
      settle({
        stdout: stdout.toString("utf-8"),
        stderr: stderr.toString("utf-8"),
        code: -1,
        timedOut,
        truncated,
      });
    };
    const cleanupSignal = () => {
      if (signal) signal.removeEventListener("abort", killForAbort);
    };
    if (signal) {
      if (signal.aborted) {
        killForAbort();
      } else {
        signal.addEventListener("abort", killForAbort, { once: true });
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - stdout.length;
      const slice = chunk.subarray(0, room);
      stdout = Buffer.concat([stdout, slice]);
      emitSnapshot(slice);
      if (chunk.length > room) {
        truncated = true;
        child.stdout.destroy();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Cap stderr at 64 KiB to avoid runaway logs.
      if (stderr.length < 65_536) {
        const slice = chunk.subarray(0, 65_536 - stderr.length);
        stderr = Buffer.concat([stderr, slice]);
        emitSnapshot(slice);
      }
    });
    child.on("error", (err) => {
      settle({
        stdout: stdout.toString("utf-8"),
        stderr: (stderr.toString("utf-8") + "\n" + err.message).trim(),
        code: -1,
        timedOut,
        truncated,
      });
    });
    child.on("close", (code) => {
      settle({
        stdout: stdout.toString("utf-8"),
        stderr: stderr.toString("utf-8"),
        code: code ?? -1,
        timedOut,
        truncated,
      });
    });
  });
}

// Exposed for sibling server modules (e.g. `worktree-integration`) that need the
// same hardened spawn wrapper — no shell, explicit cwd, hard timeout, capped
// output — rather than re-implementing it. Not for route/tool code, which should
// use the typed helpers below.
export { runGit as runGitRaw };

async function runGitOk(args: string[], opts: RunOptions): Promise<string> {
  const r = await runGit(args, opts);
  if (r.timedOut) throw new GitError("git command timed out", r);
  if (r.code !== 0)
    throw new GitError(
      `git ${args[0]} exited ${r.code}: ${gitErrorStderrTail(r.stderr)}`,
      r,
    );
  return r.stdout;
}

function emptyResult(): GitRunResult {
  return {
    stdout: "",
    stderr: "",
    code: -1,
    timedOut: false,
    truncated: false,
  };
}

export { runGit, runGitOk, emptyResult };
