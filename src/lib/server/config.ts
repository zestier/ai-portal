import { z } from 'zod';
import { BACKEND_PROVIDER_IDS } from '$lib/types';

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
		LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

		AUTH_MODE: z.enum(['github', 'shared-secret', 'none']).default('none'),
		SESSION_SECRET: z.string().min(32).optional(),
		ENCRYPTION_KEY: z.string().optional(), // base64, 32 bytes raw
		I_KNOW_THIS_IS_LOCAL: z
			.string()
			.optional()
			.transform((v) => v === '1' || v === 'true'),

		GITHUB_CLIENT_ID: z.string().optional(),
		GITHUB_CLIENT_SECRET: z.string().optional(),
		ALLOWED_GITHUB_LOGINS: commaList,
		REDEPLOY_ADMIN_GITHUB_LOGINS: commaList,

		SHARED_SECRET: z.string().optional(),

		COPILOT_GITHUB_TOKEN: z.string().optional(),
		DEFAULT_BACKEND_PROVIDER: z.enum(BACKEND_PROVIDER_IDS).default('copilot'),
		DEFAULT_MODEL: z.string().default('claude-sonnet-4.5'),
		OPENAI_COMPATIBLE_BASE_URL: optionalUrl,
		OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
		OPENAI_COMPATIBLE_MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(8),
		OPENAI_COMPATIBLE_CONTEXT_RESTORE_MESSAGES: z.coerce.number().int().positive().default(20),
		OPENAI_COMPATIBLE_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
		OPENAI_COMPATIBLE_TOP_P: z.coerce.number().min(0).max(1).optional(),
		OPENAI_COMPATIBLE_PRESENCE_PENALTY: z.coerce.number().min(-2).max(2).optional(),
		OPENAI_COMPATIBLE_FREQUENCY_PENALTY: z.coerce.number().min(-2).max(2).optional(),
		LMSTUDIO_BASE_URL: z.string().trim().url().default('http://127.0.0.1:1234'),
		LMSTUDIO_API_KEY: z.string().optional(),
		MEMORY_EXTRACTOR_BACKEND: z
			.enum(['heuristic', 'openai-compatible', 'openai-compatible-tools'])
			.default('heuristic'),
		MEMORY_EXTRACTOR_MODEL: z.string().trim().optional(),
		MEMORY_EXTRACTOR_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
		MEMORY_EXTRACTOR_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(12_000),
		MEMORY_EXTRACTOR_MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(6),
		MEMORY_EXTRACTOR_MAX_WALLCLOCK_MS: z.coerce.number().int().positive().default(60_000),
		MEMORY_EMBEDDING_PROVIDER: z.enum(['local-hash', 'openai-compatible']).default('local-hash'),
		MEMORY_EMBEDDING_MODEL: z.string().trim().optional(),
		MEMORY_EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

		IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(15),
		MAX_CONCURRENT_SESSIONS: z.coerce.number().int().positive().default(4),

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

		// Explicit override for the SQLite migrations directory. Useful for
		// tests / non-standard layouts where cwd isn't the repo root.
		DB_MIGRATIONS_DIR: z.string().optional()
	})
	.superRefine((cfg, ctx) => {
		if (cfg.AUTH_MODE === 'none') {
			// 127.0.0.1: loopback-only, the safe default.
			// 0.0.0.0: every interface — only acceptable when the operator
			// has fenced the listener off some other way (container with no
			// published port, private network, authenticating reverse proxy).
			// Still gated on the explicit I_KNOW_THIS_IS_LOCAL opt-in.
			const allowedHosts = new Set(['127.0.0.1', '0.0.0.0']);
			if (!cfg.I_KNOW_THIS_IS_LOCAL || !allowedHosts.has(cfg.HOST)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'AUTH_MODE=none requires HOST=127.0.0.1 (or 0.0.0.0) and I_KNOW_THIS_IS_LOCAL=1.'
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
	});

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
