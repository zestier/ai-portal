import { z } from 'zod';
import { resolve } from 'node:path';
import {
	BACKEND_PROVIDER_IDS,
	MEMORY_EXTRACTOR_BACKEND_IDS,
	type BackendProviderId,
	type ProviderInstance
} from '$lib/types';

const optionalUrl = z
	.string()
	.trim()
	.optional()
	.transform((v) => (v ? v : undefined))
	.pipe(z.string().url().optional());

const commaList = z
	.string()
	.optional()
	.transform((v) =>
		v
			? v
					.split(',')
					.map((s) => s.trim().toLowerCase())
					.filter(Boolean)
			: []
	);

// Like commaList but preserves case — filesystem paths are case-sensitive on
// the platforms we target, so lowercasing them would silently break the
// allowlist on a case-sensitive root.
const pathList = z
	.string()
	.optional()
	.transform((v) =>
		v
			? v
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			: []
	);

// One entry of `ZAP_PROVIDERS_JSON`: a second (or third…) configured backend
// instance. `type` picks the implementation; `id` is the identity stored on
// conversations and settings. `copilot` is rejected as a type below — it stays
// a single built-in.
const providerInstanceSchema = z.object({
	id: z.string().trim().min(1, 'id is required'),
	type: z.enum(BACKEND_PROVIDER_IDS),
	label: z.string().trim().min(1).optional(),
	baseUrl: z.string().trim().url().optional(),
	apiKey: z.string().trim().min(1).optional(),
	models: z.array(z.string().trim().min(1, 'model id is required')).optional()
});

// Cross-entry constraints that only make sense once the whole array is parsed:
// no duplicate ids (including collisions with the built-in instances, which own
// the bare type ids), no copilot duplicates, and url-backed instances must
// declare an endpoint (they have no env fallback to inherit).
const providerInstancesSchema = z.array(providerInstanceSchema).superRefine((list, ctx) => {
	const seen = new Set<string>();
	for (const [i, inst] of list.entries()) {
		if (inst.type === 'copilot') {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [i, 'type'],
				message: `type 'copilot' cannot be duplicated; copilot stays a single built-in instance`
			});
		}
		if (BACKEND_PROVIDER_IDS.includes(inst.id as BackendProviderId)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [i, 'id'],
				message: `'${inst.id}' is a built-in provider id; give this instance a different id`
			});
		} else if (seen.has(inst.id)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [i, 'id'],
				message: `duplicate provider instance id '${inst.id}'`
			});
		}
		seen.add(inst.id);
		if (inst.type !== 'copilot' && !inst.baseUrl) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [i, 'baseUrl'],
				message: `baseUrl is required for a '${inst.type}' instance`
			});
		}
	}
});

// `ZAP_PROVIDERS_JSON` holds extra configured backend instances as a JSON
// array. The `transform` parses the string; `.pipe` then validates the shape
// and the cross-entry constraints. Both failure modes report under the
// `ZAP_PROVIDERS_JSON[...]` path so `loadConfig`'s error output names the
// offending field.
const providersJson = z
	.string()
	.trim()
	.optional()
	.transform((raw, ctx) => {
		if (!raw) return [] as ProviderInstance[];
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: `not valid JSON: ${e instanceof Error ? e.message : String(e)}`
			});
			return z.NEVER;
		}
		return parsed;
	})
	.pipe(providerInstancesSchema);

const Schema = z
	.object({
		HOST: z.string().default('127.0.0.1'),
		PORT: z.coerce.number().int().min(1).max(65535).default(3000),
		DATA_DIR: z.string().default('./data'),
		// Default working directory the Copilot SDK operates inside. This
		// is the actual project tree the agent reads and edits — not a
		// per-conversation sandbox. Falls back to the server's cwd when
		// unset, which for a `pnpm dev`/`pnpm serve` run is the portal
		// checkout (or whatever real project the user is running it from).
		PROJECT_ROOT: z.string().default(process.cwd()),
		// Allowlist of roots a user-supplied workdir may resolve inside. Empty
		// (the default) means "only PROJECT_ROOT". Comma-separated absolute
		// paths widen it for a trusted single operator who wants to point
		// conversations at several project trees. In multi-user GitHub mode
		// (AUTH_MODE=github with >1 allowed login) the effective roots are
		// always clamped to PROJECT_ROOT regardless of this value, so one
		// operator can never browse another's data or the host's secrets.
		ALLOWED_WORKDIRS: pathList,
		// Portal-owned linked worktrees live outside the user-selectable workdir
		// allowlist. The final default is derived from DATA_DIR after parsing.
		WORKTREE_ROOT: z.string().trim().optional(),
		WORKTREE_CREATE_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
		// Quotas on agent-created worktree leases. A runaway orchestrator that
		// fans out without bound would otherwise fill the disk with checkouts.
		WORKTREE_MAX_LEASES_PER_CONVERSATION: z.coerce.number().int().positive().default(8),
		WORKTREE_MAX_LEASES_PER_USER: z.coerce.number().int().positive().default(32),
		// Idle leases with no uncommitted changes are reaped after this long.
		// Dirty leases are never auto-removed regardless of age.
		WORKTREE_LEASE_TTL_MS: z.coerce
			.number()
			.int()
			.positive()
			.default(24 * 60 * 60_000),
		LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

		AUTH_MODE: z.enum(['github', 'shared-secret', 'none']).default('none'),
		SESSION_SECRET: z.string().min(32).optional(),
		// Lifetime of an issued session cookie, in seconds. Security-sensitive
		// deployments can shorten this; the default is 30 days. Existing cookies
		// carry their own `exp` claim, so changing this only affects newly issued
		// sessions and never invalidates already-valid cookies early.
		SESSION_TTL_SECONDS: z.coerce
			.number()
			.int()
			.positive()
			.default(60 * 60 * 24 * 30),
		ENCRYPTION_KEY: z.string().optional(), // base64, 32 bytes raw
		I_KNOW_THIS_IS_LOCAL: z
			.string()
			.optional()
			.transform((v) => v === '1' || v === 'true'),
		// Opt-in required to bind every interface (HOST=0.0.0.0) under
		// AUTH_MODE=none. Binding all interfaces with zero auth is far riskier
		// than loopback, so it demands its own unmistakable acknowledgement.
		// It is the *stronger* assertion and stands alone — operators on
		// 0.0.0.0 set this instead of (not in addition to) I_KNOW_THIS_IS_LOCAL.
		I_KNOW_THIS_IS_NETWORK_ACCESSIBLE: z
			.string()
			.optional()
			.transform((v) => v === '1' || v === 'true'),

		GITHUB_CLIENT_ID: z.string().optional(),
		GITHUB_CLIENT_SECRET: z.string().optional(),
		ALLOWED_GITHUB_LOGINS: commaList,
		REDEPLOY_ADMIN_GITHUB_LOGINS: commaList,

		SHARED_SECRET: z.string().min(32).optional(),

		COPILOT_GITHUB_TOKEN: z.string().optional(),
		// Pin the session context window tier. The 1M ("long_context") window is
		// a premium, separately-billed tier that newer Copilot CLIs gate behind
		// an explicit opt-in; sessions otherwise default to the standard (~200k)
		// window. Set to "long_context" to request the large window on every
		// session. Forwarded as the SDK's `contextTier` session-config field.
		COPILOT_CONTEXT_TIER: z.enum(['default', 'long_context']).default('default'),
		// Per-call timeout (ms) for Copilot SDK lifecycle calls (client start,
		// session metadata lookup, create/resume). A hung CLI subprocess must not
		// pin a request — and the per-user `starting` dedupe lock — open forever.
		// 0 disables the guard.
		COPILOT_SDK_CALL_TIMEOUT_MS: z.coerce.number().int().min(0).default(60_000),
		// Connection token for a token-protected remote CLI reached via
		// COPILOT_CLI_URL. Must match the COPILOT_CONNECTION_TOKEN set on the
		// `copilot --headless` server. Forwarded to the SDK as the
		// `RuntimeConnection.forUri` connection token; the SDK does not read
		// this from the environment for URI connections, so the portal must
		// pass it explicitly or the connect handshake is rejected.
		COPILOT_CONNECTION_TOKEN: z
			.string()
			.trim()
			.optional()
			.transform((v) => (v ? v : undefined)),
		// Names the default provider INSTANCE. Any configured instance id works
		// (a bare type id means that type's built-in instance); an unknown value
		// is coerced to the copilot built-in by `normalizeProviderInstance`.
		DEFAULT_BACKEND_PROVIDER: z.string().trim().default('copilot'),
		// Extra configured backend instances beyond the env-fed built-ins.
		ZAP_PROVIDERS_JSON: providersJson,
		DEFAULT_MODEL: z.string().default('claude-sonnet-4.5'),
		CLAUDE_AGENT_BASE_URL: optionalUrl,
		CLAUDE_AGENT_API_KEY: z.string().optional(),
		CLAUDE_AGENT_MAX_TURNS: z.coerce.number().int().positive().default(50),
		OPENAI_COMPATIBLE_BASE_URL: optionalUrl,
		OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
		OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(8),
		OPENAI_COMPATIBLE_CONTEXT_RESTORE_MESSAGES: z.coerce.number().int().positive().default(20),
		OPENAI_COMPATIBLE_CONTEXT_TOKEN_LIMIT: z.coerce.number().int().positive().optional(),
		OPENAI_COMPATIBLE_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
		OPENAI_COMPATIBLE_TOP_P: z.coerce.number().min(0).max(1).optional(),
		OPENAI_COMPATIBLE_PRESENCE_PENALTY: z.coerce.number().min(-2).max(2).optional(),
		OPENAI_COMPATIBLE_FREQUENCY_PENALTY: z.coerce.number().min(-2).max(2).optional(),
		LMSTUDIO_BASE_URL: z.string().trim().url().default('http://127.0.0.1:1234'),
		LMSTUDIO_API_KEY: z.string().optional(),
		MEMORY_EXTRACTOR_BACKEND: z.enum(MEMORY_EXTRACTOR_BACKEND_IDS).default('heuristic'),
		MEMORY_EXTRACTOR_MODEL: z.string().trim().optional(),
		MEMORY_EXTRACTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
		MEMORY_EXTRACTOR_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(12_000),
		MEMORY_EXTRACTOR_MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(6),
		MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS: z.coerce.number().int().positive().default(60_000),
		// Grace added on top of the extractor wall-clock budget before the
		// turn-runner watchdog force-finalizes the post-turn extraction phase.
		// The ceiling (wallclock + grace) bounds ONLY the post-turn extraction
		// phase so an abort-ignoring provider can never hold the turn open; the
		// main agent turn stays unbounded.
		MEMORY_EXTRACTOR_WATCHDOG_GRACE_MS: z.coerce.number().int().min(0).default(15_000),
		// Tool-calling extractor: how the backend is told to choose tools.
		// 'auto' lets the model decide each step; 'required' forces a tool call
		// per step (useful for ramble-prone local models that otherwise narrate
		// without acting). Backends that ignore tool_choice are unaffected.
		MEMORY_EXTRACTOR_TOOL_CHOICE: z.enum(['auto', 'required']).default('auto'),
		// Tool-calling extractor: how many times `memory_end_extraction` may be
		// blocked because the model has write failures it neither fixed (via a
		// threaded retry) nor acknowledged. Independent of the empty-turn nudge
		// budget. Once spent, the next call is accepted, staged work commits, and a
		// diagnostic records the still-unacknowledged failure ids (salvage the
		// run rather than loop forever). Kept small so the gate trips well before
		// the iteration and wall-clock caps so force-finish actually fires.
		MEMORY_EXTRACTOR_MAX_FAILED_CALL_NUDGES: z.coerce.number().int().min(0).default(2),
		// Open-loop liveness: a presented-but-untouched loop is auto-dropped
		// after this many consecutive model-backed extraction passes (higher
		// priority loops get proportionally more grace). 0 disables aging.
		MEMORY_OPEN_LOOP_MAX_IDLE_TURNS: z.coerce.number().int().min(0).default(6),

		// Retention for the append-only memory_event_log + FTS index. Caps the
		// number of events kept per conversation; the periodic maintenance sweep
		// trims the oldest events beyond this and VACUUMs reclaimed pages. 0
		// disables retention (unbounded growth).
		MEMORY_LOG_RETENTION_MAX_EVENTS: z.coerce.number().int().min(0).default(5000),
		// How often the memory maintenance task (retention sweep + vacuum) runs,
		// in minutes. Must be positive.
		MEMORY_MAINTENANCE_INTERVAL_MIN: z.coerce.number().int().positive().default(720),

		// Kill switch (default on) for post-extraction main-model priming. On
		// local load/unload backends (Ollama via openai-compatible, LM Studio)
		// the model-backed memory extractor can evict the main chat model from
		// VRAM; when enabled the runtime re-warms the main model after extraction
		// so the next user turn skips the cold model-load stall. Set to "0"/
		// "false" to disable globally. Only fires when priming is useful (local
		// backend, model-backed extractor, and extractor model ≠ main model).
		MEMORY_PRIME_MAIN_MODEL: z
			.string()
			.optional()
			.transform((v) => v !== '0' && v !== 'false'),

		// --- Adversarial approval mode, Phase 0 (shadow measurement) ---
		//
		// A second model reads prompt-worthy permission requests and records
		// what it *would* have decided, with NO authority: it cannot allow,
		// deny, delay, or alter anything. The recorded verdicts are compared
		// against the human's actual clicks to get a real precision/recall
		// number for adversary denials before the idea is allowed to gate
		// anything.
		//
		// This is the SERVER DEFAULT only. The effective model is resolved
		// per conversation: conversation override -> user default -> this.
		// Unset everywhere (the default) means the shadow never runs.
		//
		// There is deliberately no separate on/off switch: a configured model
		// IS the enablement, mirroring the model-backed memory extractor. Two
		// switches that can disagree is a bug surface, not a feature.
		ADVERSARY_SHADOW_MODEL: z.string().trim().optional(),
		// Which backend serves the reviewer, resolved independently of the
		// model: conversation override -> user default -> this -> the
		// conversation's OWN backend.
		//
		// That last fallback is deliberate. Requiring a separate endpoint
		// conflated two unrelated things — the reviewer needs to be a different
		// MODEL from the agent, which says nothing about needing a different
		// BACKEND — and confined the experiment to deployments that had stood a
		// second one up. It also added a data-egress destination the chat
		// backend, which already receives every tool call and its arguments,
		// did not need.
		ADVERSARY_SHADOW_BACKEND: z.string().trim().optional(),
		ADVERSARY_SHADOW_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
		ADVERSARY_SHADOW_MAX_ARG_CHARS: z.coerce.number().int().positive().default(4_000),
		// Ceiling on simultaneous in-flight adversary calls per conversation.
		// Matters most in `auto-approve` conversations, where there are no
		// dialogs to pace the requests: an agent issuing dozens of distinct
		// shell commands in a turn would otherwise open dozens of concurrent
		// completions against the operator's provider quota. Requests over the
		// cap are recorded as skipped rows rather than silently dropped, so the
		// resulting hole in the sample is visible in the readout instead of
		// being mistaken for a representative collection.
		ADVERSARY_SHADOW_MAX_IN_FLIGHT: z.coerce.number().int().positive().default(4),
		IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(15),
		MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(4),
		// After a user Stop, the turn must reach a terminal state and free the
		// conversation within this deadline even if post-turn memory extraction
		// hasn't unwound — the stuck extraction is abandoned past this point.
		TURN_ABORT_FINALIZE_DEADLINE_MS: z.coerce.number().int().positive().default(5_000),

		// Set to "1" to enable POST /api/admin/redeploy (rebuilds and restarts
		// the process; requires the supervisor `pnpm run serve` to relaunch).
		ENABLE_REDEPLOY: z
			.string()
			.optional()
			.transform((v) => v === '1' || v === 'true'),

		// When "1", `copilot-provider.ts` swaps the real Copilot SDK for the
		// in-process stub in `bridge-stub.ts`. Used by e2e tests.
		COPILOT_STUB: z
			.string()
			.optional()
			.transform((v) => v === '1' || v === 'true'),

		// --- pi SDK session plumbing (T1) ---
		// When "1", the turn-runner swaps the provider layer for an in-process
		// pi `createAgentSession` backed by a tiny OpenAI-compatible stub model
		// (`stub-server.ts`). Used by e2e tests; mirrors COPILOT_STUB.
		PI_STUB: z
			.string()
			.optional()
			.transform((v) => v === '1' || v === 'true'),
		// Default model id (providerId/modelId) for pi sessions. Only consulted
		// when the conversation has no pi-specific model; the stub overrides it
		// with the registered `pi-stub` model regardless.
		PI_MODEL: z.string().trim().default('anthropic/claude-sonnet-4-5'),

		// Explicit override for the SQLite migrations directory. Useful for
		// tests / non-standard layouts where cwd isn't the repo root.
		DB_MIGRATIONS_DIR: z.string().optional()
	})
	.superRefine((cfg, ctx) => {
		if (cfg.AUTH_MODE === 'none') {
			// Each bind address has exactly one acknowledgement flag:
			//   127.0.0.1 (loopback, the safe default) -> I_KNOW_THIS_IS_LOCAL
			//   0.0.0.0   (every interface)             -> I_KNOW_THIS_IS_NETWORK_ACCESSIBLE
			// The network flag is the stronger assertion and stands on its own
			// (no need to also set I_KNOW_THIS_IS_LOCAL). 0.0.0.0 is only
			// acceptable when reachability is fenced off some other way — a
			// container with no published port, a private network, or an
			// authenticating reverse proxy in front. Any other HOST is rejected.
			if (cfg.HOST === '0.0.0.0') {
				if (!cfg.I_KNOW_THIS_IS_NETWORK_ACCESSIBLE) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message:
							'AUTH_MODE=none with HOST=0.0.0.0 binds every interface with no auth; ' +
							'set I_KNOW_THIS_IS_NETWORK_ACCESSIBLE=1 to acknowledge, or use ' +
							'HOST=127.0.0.1 with I_KNOW_THIS_IS_LOCAL=1 for loopback-only access.'
					});
				}
			} else if (cfg.HOST === '127.0.0.1') {
				if (!cfg.I_KNOW_THIS_IS_LOCAL) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: 'AUTH_MODE=none (loopback, no auth) requires I_KNOW_THIS_IS_LOCAL=1.'
					});
				}
			} else {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message:
						'AUTH_MODE=none requires HOST=127.0.0.1 (with I_KNOW_THIS_IS_LOCAL=1) ' +
						'or HOST=0.0.0.0 (with I_KNOW_THIS_IS_NETWORK_ACCESSIBLE=1).'
				});
			}
		} else {
			if (!cfg.SESSION_SECRET) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'SESSION_SECRET is required unless AUTH_MODE=none.'
				});
			}
		}
		if (cfg.AUTH_MODE === 'github') {
			if (!cfg.GITHUB_CLIENT_ID || !cfg.GITHUB_CLIENT_SECRET) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required for AUTH_MODE=github.'
				});
			}
			if (!cfg.ALLOWED_GITHUB_LOGINS || cfg.ALLOWED_GITHUB_LOGINS.length === 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'ALLOWED_GITHUB_LOGINS must be a non-empty list for AUTH_MODE=github.'
				});
			}
			const unknownRedeployAdmins = cfg.REDEPLOY_ADMIN_GITHUB_LOGINS.filter(
				(login) => !cfg.ALLOWED_GITHUB_LOGINS.includes(login)
			);
			if (unknownRedeployAdmins.length > 0) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['REDEPLOY_ADMIN_GITHUB_LOGINS'],
					message:
						'REDEPLOY_ADMIN_GITHUB_LOGINS entries must also be present in ALLOWED_GITHUB_LOGINS.'
				});
			}
			if (
				cfg.ENABLE_REDEPLOY &&
				cfg.ALLOWED_GITHUB_LOGINS.length > 1 &&
				cfg.REDEPLOY_ADMIN_GITHUB_LOGINS.length === 0
			) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['REDEPLOY_ADMIN_GITHUB_LOGINS'],
					message:
						'REDEPLOY_ADMIN_GITHUB_LOGINS is required when ENABLE_REDEPLOY=1 and multiple GitHub logins are allowed.'
				});
			}
		}
		if (cfg.AUTH_MODE === 'shared-secret' && !cfg.SHARED_SECRET) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'SHARED_SECRET is required for AUTH_MODE=shared-secret.'
			});
		}
		if (cfg.ENCRYPTION_KEY) {
			try {
				const raw = Buffer.from(cfg.ENCRYPTION_KEY, 'base64');
				if (raw.length !== 32) {
					ctx.addIssue({
						code: z.ZodIssueCode.custom,
						message: 'ENCRYPTION_KEY must decode to exactly 32 bytes (base64).'
					});
				}
			} catch {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'ENCRYPTION_KEY must be valid base64.'
				});
			}
		} else if (cfg.AUTH_MODE === 'github') {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'ENCRYPTION_KEY is required for AUTH_MODE=github (encrypts stored tokens).'
			});
		}
	})
	.transform((cfg) => ({
		...cfg,
		WORKTREE_ROOT: resolve(cfg.WORKTREE_ROOT ?? resolve(cfg.DATA_DIR, 'worktrees'))
	}));

export type AppConfig = z.infer<typeof Schema>;

let cached: AppConfig | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	if (cached) return cached;
	const result = Schema.safeParse(env);
	if (!result.success) {
		const msg = result.error.issues
			.map((i) => `  - ${i.path.join('.') || '<env>'}: ${i.message}`)
			.join('\n');
		throw new Error(`Invalid configuration:\n${msg}`);
	}
	cached = result.data;
	return cached;
}

export function resetConfigForTests() {
	cached = null;
}
