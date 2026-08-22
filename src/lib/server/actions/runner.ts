// Generic streamed command runner.
//
// Extracted from the original redeploy implementation so it can back BOTH the
// privileged built-in redeploy (admin-only, cwd = portal source, with a
// process rollover) AND user-defined project actions loaded from
// `.zap/actions.toml` (conversation-scoped, cwd = the conversation workdir,
// default-deny env). The only redeploy-special behavior — the
// `process.exit(0)` rollover that hands control to the `pnpm serve`
// supervisor — is gated behind an explicit `rollover` flag the config path
// can never set (see config.ts / the actions API).
//
// Invariants that are load-bearing for the multi-user trust gap and are kept
// here so every caller inherits them:
//   - `shell: false` always: steps are `command` + `args[]`, never a string
//     interpolated into a shell.
//   - All streamed stdout/stderr is scrubbed (`scrubLog`) for secret-shaped
//     strings before it leaves the process.
//   - Env is opt-in for project actions (`inheritEnv: false` + an explicit
//     env object); the full `process.env` is only spread for callers that
//     opt in (`inheritEnv` defaulting to true preserves redeploy's behavior).

import { spawn } from "node:child_process";
import { isolatedChildEnv } from "../child-env";
import { log } from "../log";

export type Step = {
  label: string;
  command: string;
  args: string[];
  display: string;
  // Working directory for the child. Defaults to `process.cwd()` (the portal
  // source tree) — reserved to built-ins. Project actions set this to the
  // conversation workdir.
  cwd?: string;
  // Extra/explicit env for the child.
  env?: NodeJS.ProcessEnv;
  // When false, the child env is EXACTLY `env` (default-deny): the ambient
  // `process.env` — including the portal's own secrets — is NOT inherited.
  // Defaults to true so the built-in redeploy keeps spreading `process.env`.
  inheritEnv?: boolean;
};

export type ActionEvent =
  | { type: "step"; label: string; cmd: string }
  | { type: "log"; stream: "stdout" | "stderr"; text: string }
  | { type: "step-done"; label: string; code: number }
  | { type: "done"; ok: true; restarting?: true }
  | {
      type: "done";
      ok: false;
      failedStep?: string;
      code?: number;
      message?: string;
    };

const SENSITIVE_ENV_NAME =
  /(?:auth|copilot|credential|cookie|key|password|passwd|secret|shared|token)/i;

// Newline-less output is buffered until a newline so a secret split across Node
// chunks is scrubbed whole. Cap that buffer to bound memory, but keep a tail
// overlap (longer than any plausible secret) so a forced flush can't split one.
const MAX_BUFFERED_LINE = 256 * 1024;
const SCRUB_TAIL = 1024;

// Grace period after a SIGTERM-on-abort before escalating to SIGKILL. A step
// that traps/ignores SIGTERM must still be force-killed so it cannot outlive
// the request that authorized it (and, via never resolving, wedge the
// per-action in-flight guard).
export const ABORT_KILL_GRACE_MS = 2000;

// The portal's OWN secret-bearing config env vars (see src/lib/server/config.ts).
// A project action's `env` allowlist can name an operator-provisioned project
// secret (e.g. VERCEL_TOKEN), but it must NEVER be able to name one of these and
// pull the portal's encryption credentials into a child it otherwise can't read.
// These names look just like legitimate project secrets (they match the
// secret-shaped name heuristic too), so the only correct gate is an explicit
// denylist of the portal's own names rather than a pattern. This is the
// load-bearing half of "default-deny env": it keeps the allowlist from
// re-widening the exfil surface the design exists to shrink. Names are compared
// case-insensitively. Keep in sync with the secret fields in config.ts.
export const PORTAL_SECRET_ENV_NAMES: readonly string[] = [
  "ENCRYPTION_KEY",
] as const;

const PORTAL_SECRET_ENV_SET = new Set(
  PORTAL_SECRET_ENV_NAMES.map((n) => n.toUpperCase()),
);

/** Whether `name` is one of the portal's own secret env vars (denylisted from
 * any project-action allowlist). Case-insensitive. */
export function isPortalSecretEnvName(name: string): boolean {
  return PORTAL_SECRET_ENV_SET.has(name.toUpperCase());
}

/**
 * Build the env for a default-deny project action: a curated, non-sensitive
 * base (so the toolchain resolves) plus the action's explicit allowlist of
 * env var NAMES resolved against `source` (defaults to `process.env`). Secrets
 * the action did not name are never copied in. Allowlisted names that are
 * unset in the source are simply omitted.
 *
 * The portal's own secret names ({@link PORTAL_SECRET_ENV_NAMES}) are dropped
 * even if allowlisted — config validation already rejects such a file, but this
 * is a defense-in-depth backstop so a bypass of that path can't leak them.
 */
export function buildActionEnv(
  allowlist: readonly string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = isolatedChildEnv(source);
  for (const name of allowlist) {
    if (isPortalSecretEnvName(name)) continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function scrubLog(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let scrubbed = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 4 || !SENSITIVE_ENV_NAME.test(name)) continue;
    scrubbed = scrubbed.split(value).join(`[redacted:${name}]`);
  }
  return scrubbed
    .replace(/\bgh[psuor]_[A-Za-z0-9_]{20,}\b/g, "[redacted:github-token]")
    .replace(
      /\b(?:sk-|sk_live_|sk_test_)[A-Za-z0-9_-]{20,}\b/g,
      "[redacted:api-key]",
    )
    .replace(
      /\b((?:bearer|token)\s+)[A-Za-z0-9._~+/=-]{20,}/gi,
      "$1[redacted]",
    );
}

/**
 * Spawn one step, streaming scrubbed stdout/stderr as `log` events and
 * resolving with the exit code. When `signal` is provided and aborts (e.g. the
 * client disconnected), the child is killed so a long-running action does not
 * outlive the request that triggered it.
 */
export function runStep(
  step: Step,
  emit: (ev: ActionEvent) => void,
  signal?: AbortSignal,
): Promise<number> {
  return new Promise<number>((resolve) => {
    emit({ type: "step", label: step.label, cmd: step.display });
    const childEnv =
      step.inheritEnv === false
        ? (step.env ?? {})
        : { ...process.env, ...step.env };
    // `detached: true` makes the child its own process-group leader so a
    // kill can target the whole tree (`pnpm run x` forks the real work into
    // grandchildren). We deliberately do NOT `unref()` — the parent still
    // awaits the child and pipes its stdio.
    const p = spawn(step.command, step.args, {
      cwd: step.cwd ?? process.cwd(),
      env: childEnv,
      shell: false,
      detached: true,
    });
    // Kill the child's whole process group if the request is aborted
    // mid-run, escalating to SIGKILL so a SIGTERM-trapping step still dies
    // (and can't outlive the request or wedge the in-flight guard).
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const killTree = (sig: NodeJS.Signals) => {
      if (p.pid === undefined) return;
      try {
        process.kill(-p.pid, sig);
      } catch {
        // Group already gone (or pid reused) — fall back to the direct child.
        try {
          p.kill(sig);
        } catch {
          /* already dead */
        }
      }
    };
    const onAbort = () => {
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), ABORT_KILL_GRACE_MS);
      (killTimer as { unref?: () => void }).unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    };
    // Buffer incomplete lines so a secret split across arbitrary-length Node
    // chunks is scrubbed against a whole line, not two half-matches.
    const emitStream = (stream: "stdout" | "stderr", text: string) => {
      if (text) emit({ type: "log", stream, text: scrubLog(text) });
    };
    const buffers: Record<"stdout" | "stderr", string> = {
      stdout: "",
      stderr: "",
    };
    const onChunk = (stream: "stdout" | "stderr", b: Buffer) => {
      const merged = buffers[stream] + b.toString();
      const lastBreak = merged.lastIndexOf("\n");
      if (lastBreak === -1) {
        // No newline yet. Cap memory for newline-less output (progress bars,
        // huge single-line blobs) but retain a tail so a secret can't straddle
        // the forced flush boundary and leak as two half-matches.
        if (merged.length > MAX_BUFFERED_LINE) {
          emitStream(stream, merged.slice(0, -SCRUB_TAIL));
          buffers[stream] = merged.slice(-SCRUB_TAIL);
        } else {
          buffers[stream] = merged;
        }
        return;
      }
      buffers[stream] = merged.slice(lastBreak + 1);
      emitStream(stream, merged.slice(0, lastBreak + 1));
    };
    const flushStream = (stream: "stdout" | "stderr") => {
      emitStream(stream, buffers[stream]);
      buffers[stream] = "";
    };
    p.stdout.on("data", (b: Buffer) => onChunk("stdout", b));
    p.stderr.on("data", (b: Buffer) => onChunk("stderr", b));
    // A spawn failure (e.g. ENOENT) fires 'error'; depending on the Node
    // version 'close' may also follow. Guard so the stream gets exactly one
    // terminal `step-done` and the promise resolves once.
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      flushStream("stdout");
      flushStream("stderr");
      emit({ type: "step-done", label: step.label, code });
      resolve(code);
    };
    p.on("error", (err) => {
      emit({
        type: "log",
        stream: "stderr",
        text: scrubLog(`spawn error: ${err.message}\n`),
      });
      finish(1);
    });
    p.on("close", (code) => finish(code ?? 1));
  });
}

export interface RunSequenceOptions {
  // When true (built-ins only), a fully-successful sequence schedules a
  // process exit and reports `restarting: true` so the `pnpm serve`
  // supervisor relaunches on refreshed code. The config path NEVER sets this.
  rollover?: boolean;
  // Override the per-step runner (tests inject a fake).
  runner?: (
    step: Step,
    emit: (ev: ActionEvent) => void,
    signal?: AbortSignal,
  ) => Promise<number>;
  // Abort signal threaded down to each step's child (kill-on-disconnect).
  signal?: AbortSignal;
  // Label used in the structured failure log line.
  logLabel?: string;
}

/**
 * Run `steps` in order, stopping at the first non-zero exit, streaming each
 * step's events as they arrive. Yields a terminal `done` event describing the
 * outcome. With `rollover: true`, a full success schedules `process.exit(0)`
 * BEFORE yielding the final event so a client disconnect cannot block the
 * restart.
 */
export async function* runSequence(
  steps: Step[],
  opts: RunSequenceOptions = {},
): AsyncGenerator<ActionEvent> {
  const {
    rollover = false,
    runner = runStep,
    signal,
    logLabel = "action",
  } = opts;
  const queue: ActionEvent[] = [];
  let wake: (() => void) | null = null;
  const emit = (ev: ActionEvent) => {
    queue.push(ev);
    wake?.();
  };

  try {
    let failedStep: string | undefined;
    let failedCode = 0;
    for (const step of steps) {
      const done = runner(step, emit, signal);
      let code: number | undefined;
      done.then(
        (c) => {
          code = c;
          wake?.();
        },
        (err) => {
          emit({
            type: "log",
            stream: "stderr",
            text: scrubLog(`step error: ${String(err)}\n`),
          });
          code = 1;
          wake?.();
        },
      );
      while (code === undefined || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            wake = r;
          });
          wake = null;
          continue;
        }
        yield queue.shift()!;
      }
      if (code !== 0) {
        failedStep = step.label;
        failedCode = code;
        log.warn(`${logLabel}.failed`, { step: step.label, code });
        break;
      }
    }
    if (failedStep) {
      yield { type: "done", ok: false, failedStep, code: failedCode };
    } else if (rollover) {
      // Schedule the rollover exit BEFORE yielding `done`. The yield suspends
      // this generator until the consumer pulls again; if the client
      // disconnects in between, the SSE layer calls `.return()` and any code
      // after the yield never runs. Scheduling first makes the restart
      // unconditional — a successful build always rolls over, even if nobody
      // is listening for the final event.
      log.info(`${logLabel}.ok.exiting`);
      setTimeout(() => process.exit(0), 500).unref();
      yield { type: "done", ok: true, restarting: true };
    } else {
      yield { type: "done", ok: true };
    }
  } catch (err) {
    const message = scrubLog(String(err));
    log.error(`${logLabel}.crash`, { err: message });
    yield { type: "done", ok: false, message };
  }
}
