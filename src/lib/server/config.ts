import { z } from "zod";
import { resolve } from "node:path";

// Comma-separated list of absolute paths, preserving case (filesystem paths
// are case-sensitive on the platforms we target).
const pathList = z
  .string()
  .optional()
  .transform((v) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [],
  );

// `ZAP_PROVIDERS_JSON`/provider instances were deleted with the backend-provider
// layer; the config below is the remaining portal-domain surface.

const Schema = z
  .object({
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATA_DIR: z.string().default("./data"),
    // Default working directory the pi agent session operates inside. This
    // is the actual project tree the agent reads and edits — not a
    // per-conversation sandbox. Falls back to the server's cwd when
    // unset, which for a `pnpm dev`/`pnpm serve` run is the portal
    // checkout (or whatever real project the user is running it from).
    PROJECT_ROOT: z.string().default(process.cwd()),
    // Allowlist of roots a user-supplied workdir may resolve inside. Empty
    // (the default) means "only PROJECT_ROOT". Comma-separated absolute
    // paths widen it for a trusted single operator who wants to point
    // conversations at several project trees.
    ALLOWED_WORKDIRS: pathList,
    // Portal-owned linked worktrees live outside the user-selectable workdir
    // allowlist. The final default is derived from DATA_DIR after parsing.
    WORKTREE_ROOT: z.string().trim().optional(),
    WORKTREE_CREATE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(120_000),
    // Quotas on agent-created worktree leases. A runaway orchestrator that
    // fans out without bound would otherwise fill the disk with checkouts.
    WORKTREE_MAX_LEASES_PER_CONVERSATION: z.coerce
      .number()
      .int()
      .positive()
      .default(8),
    WORKTREE_MAX_LEASES_PER_USER: z.coerce
      .number()
      .int()
      .positive()
      .default(32),
    // Idle leases with no uncommitted changes are reaped after this long.
    // Dirty leases are never auto-removed regardless of age.
    WORKTREE_LEASE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(24 * 60 * 60_000),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // AES-256-GCM key (base64, 32 raw bytes) for encrypting provider/BYOK
    // API secrets at rest in the DB. Not authentication — the app ships no
    // auth layer; this only keeps stored keys non-plaintext on disk.
    ENCRYPTION_KEY: z.string().optional(),
    I_KNOW_THIS_IS_LOCAL: z
      .string()
      .optional()
      .transform((v) => v === "1" || v === "true"),
    // Opt-in required to bind every interface (HOST=0.0.0.0). The app has
    // NO auth layer, so binding all interfaces is far riskier than loopback
    // and demands its own unmistakable acknowledgement. It is the *stronger*
    // assertion and stands alone — operators on 0.0.0.0 set this instead of
    // (not in addition to) I_KNOW_THIS_IS_LOCAL. Only acceptable when
    // reachability is fenced off another way (no published port, a private
    // network, or an authenticating reverse proxy / Tailscale in front) —
    // 0.0.0.0 must never be reachable publicly as-is.
    I_KNOW_THIS_IS_NETWORK_ACCESSIBLE: z
      .string()
      .optional()
      .transform((v) => v === "1" || v === "true"),

    // Default model id when a conversation has no model of its own. Display
    // default on the pi path: the runtime maps a conversation model equal to
    // this value to PI_MODEL (see pi/index.ts), never using it verbatim.
    DEFAULT_MODEL: z.string().default("claude-sonnet-4.5"),
    // Model-backed memory extraction. This is a pi model selection
    // (`providerId/modelId`, e.g. `anthropic/claude-sonnet-4-5`), resolved
    // against the shared ModelRuntime; the per-conversation
    // `memory_extractor_model` override wins over this env value. `heuristic`
    // (the default) is the local, offline extractor.
    MEMORY_EXTRACTOR_BACKEND: z.string().trim().default("heuristic"),
    MEMORY_EXTRACTOR_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(20_000),
    MEMORY_EXTRACTOR_MAX_INPUT_CHARS: z.coerce
      .number()
      .int()
      .positive()
      .default(12_000),
    MEMORY_EXTRACTOR_MAX_TOOL_ITERATIONS: z.coerce
      .number()
      .int()
      .positive()
      .default(6),
    MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(60_000),
    // Grace added on top of the extractor wall-clock budget before the
    // turn-runner watchdog force-finalizes the post-turn extraction phase.
    // The ceiling (wallclock + grace) bounds ONLY the post-turn extraction
    // phase so an abort-ignoring completion can never hold the turn open;
    // the main agent turn stays unbounded.
    MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS: z.coerce
      .number()
      .int()
      .min(0)
      .default(15_000),
    // Tool-calling extractor: how the backend is told to choose tools.
    // 'auto' lets the model decide each step; 'required' forces a tool call
    // per step (useful for ramble-prone local models that otherwise narrate
    // without acting). Backends that ignore tool_choice are unaffected.
    MEMORY_EXTRACTOR_TOOL_CHOICE: z.enum(["auto", "required"]).default("auto"),
    // Tool-calling extractor: how many times `memory_end_extraction` may be
    // blocked because the model has write failures it neither fixed (via a
    // threaded retry) nor acknowledged. Independent of the empty-turn nudge
    // budget. Once spent, the next call is accepted, staged work commits, and a
    // diagnostic records the still-unacknowledged failure ids (salvage the
    // run rather than loop forever). Kept small so the gate trips well before
    // the iteration and wall-clock caps so force-finish actually fires.
    MEMORY_EXTRACTOR_MAX_FAILED_CALL_NUDGES: z.coerce
      .number()
      .int()
      .min(0)
      .default(2),
    // Open-loop liveness: a presented-but-untouched loop is auto-dropped
    // after this many consecutive model-backed extraction passes (higher
    // priority loops get proportionally more grace). 0 disables aging.
    MEMORY_OPEN_LOOP_MAX_IDLE_TURNS: z.coerce.number().int().min(0).default(6),

    // Retention for the append-only memory_event_log + FTS index. Caps the
    // number of events kept per conversation; the periodic maintenance sweep
    // trims the oldest events beyond this and VACUUMs reclaimed pages. 0
    // disables retention (unbounded growth).
    MEMORY_LOG_RETENTION_MAX_EVENTS: z.coerce
      .number()
      .int()
      .min(0)
      .default(5000),
    // How often the memory maintenance task (retention sweep + vacuum) runs,
    // in minutes. Must be positive.
    MEMORY_MAINTENANCE_INTERVAL_MIN: z.coerce
      .number()
      .int()
      .positive()
      .default(720),

    // --- Adversarial approval mode, Phase 0 (shadow measurement) ---
    //
    // A second model reads prompt-worthy permission requests and records
    // what it *would* have decided, with NO authority: it cannot allow,
    // deny, delay, or alter anything. The recorded verdicts are compared
    // against the human's actual clicks to get a real precision/recall
    // number for adversary denials before the idea is allowed to gate
    // anything.
    //
    // This is the SERVER DEFAULT only. The effective reviewer is resolved
    // per conversation: conversation override (`conversations.adversary_model`)
    // -> user default -> this. Unset everywhere (the default) means the
    // shadow never runs.
    //
    // There is deliberately no separate on/off switch: a configured model
    // IS the enablement, mirroring the model-backed memory extractor. Two
    // switches that can disagree is a bug surface, not a feature.
    //
    // The reviewer model is a pi model selection (`providerId/modelId`,
    // e.g. `anthropic/claude-sonnet-4-5`), resolved against the shared
    // ModelRuntime like the memory extractor. The separate backend concept
    // is gone: the provider layer that served out-of-band completions was
    // deleted, and model identity is now provider-qualified anyway.
    ADVERSARY_SHADOW_BACKEND: z.string().trim().optional(),
    ADVERSARY_SHADOW_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(20_000),
    ADVERSARY_SHADOW_MAX_ARG_CHARS: z.coerce
      .number()
      .int()
      .positive()
      .default(4_000),
    // Ceiling on simultaneous in-flight adversary calls per conversation.
    // Matters most in `auto-approve` conversations, where there are no
    // dialogs to pace the requests: an agent issuing dozens of distinct
    // shell commands in a turn would otherwise open dozens of concurrent
    // completions against the operator's provider quota. Requests over the
    // cap are recorded as skipped rows rather than silently dropped, so the
    // resulting hole in the sample is visible in the readout instead of
    // being mistaken for a representative collection.
    ADVERSARY_SHADOW_MAX_IN_FLIGHT: z.coerce
      .number()
      .int()
      .positive()
      .default(4),
    IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(15),
    MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(4),
    // After a user Stop, the turn must reach a terminal state and free the
    // conversation within this deadline even if post-turn memory extraction
    // hasn't unwound — the stuck extraction is abandoned past this point.
    TURN_ABORT_FINALIZE_DEADLINE_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5_000),

    // Set to "1" to enable POST /api/admin/redeploy (rebuilds and restarts
    // the process; requires the supervisor `pnpm run serve` to relaunch).
    ENABLE_REDEPLOY: z
      .string()
      .optional()
      .transform((v) => v === "1" || v === "true"),

    // --- pi SDK session plumbing ---
    // When "1", the turn-runner uses an in-process pi `createAgentSession`
    // backed by a tiny OpenAI-compatible stub model (`stub-server.ts`). Used
    // by e2e tests so they don't need real pi-ai credentials.
    PI_STUB: z
      .string()
      .optional()
      .transform((v) => v === "1" || v === "true"),
    // Default model id (providerId/modelId) for pi sessions. Only consulted
    // when the conversation has no pi-specific model — the chat-header Model
    // field (saved to `conversations.model`) wins when it names a selection
    // other than the DEFAULT_MODEL default; the stub overrides it with the
    // registered `pi-stub` model regardless.
    PI_MODEL: z.string().trim().default("anthropic/claude-sonnet-4-5"),

    // Explicit override for the SQLite migrations directory. Useful for
    // tests / non-standard layouts where cwd isn't the repo root.
    DB_MIGRATIONS_DIR: z.string().optional(),
  })
  .superRefine((cfg, ctx) => {
    // The app ships NO auth layer, so each bind address demands an explicit
    // acknowledgement flag:
    //   127.0.0.1 (loopback, the safe default) -> I_KNOW_THIS_IS_LOCAL
    //   0.0.0.0   (every interface)             -> I_KNOW_THIS_IS_NETWORK_ACCESSIBLE
    // The network flag is the stronger assertion and stands on its own (no
    // need to also set I_KNOW_THIS_IS_LOCAL). 0.0.0.0 is only acceptable when
    // reachability is fenced off some other way — a container with no
    // published port, a private network, or an authenticating reverse proxy /
    // Tailscale in front. Any other HOST is rejected.
    if (cfg.HOST === "0.0.0.0") {
      if (!cfg.I_KNOW_THIS_IS_NETWORK_ACCESSIBLE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "HOST=0.0.0.0 binds every interface with no auth; set " +
            "I_KNOW_THIS_IS_NETWORK_ACCESSIBLE=1 to acknowledge, or use " +
            "HOST=127.0.0.1 with I_KNOW_THIS_IS_LOCAL=1 for loopback-only access.",
        });
      }
    } else if (cfg.HOST === "127.0.0.1") {
      if (!cfg.I_KNOW_THIS_IS_LOCAL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "No auth (loopback) requires I_KNOW_THIS_IS_LOCAL=1.",
        });
      }
    } else {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "No auth requires HOST=127.0.0.1 (with I_KNOW_THIS_IS_LOCAL=1) " +
          "or HOST=0.0.0.0 (with I_KNOW_THIS_IS_NETWORK_ACCESSIBLE=1).",
      });
    }
    if (cfg.ENCRYPTION_KEY) {
      try {
        const raw = Buffer.from(cfg.ENCRYPTION_KEY, "base64");
        if (raw.length !== 32) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "ENCRYPTION_KEY must decode to exactly 32 bytes (base64).",
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ENCRYPTION_KEY must be valid base64.",
        });
      }
    }
  })
  .transform((cfg) => ({
    ...cfg,
    WORKTREE_ROOT: resolve(
      cfg.WORKTREE_ROOT ?? resolve(cfg.DATA_DIR, "worktrees"),
    ),
  }));

export type AppConfig = z.infer<typeof Schema>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached) return cached;
  const result = Schema.safeParse(env);
  if (!result.success) {
    const msg = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<env>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  cached = result.data;
  return cached;
}

export function resetConfigForTests() {
  cached = null;
}
