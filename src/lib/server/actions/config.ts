// Loader + validator for `.zap/actions.json` — the committed, per-project file
// that declares user-facing action buttons for a conversation's workdir.
//
// Security posture (see the ticket): definitions live in the repo (not the
// UI), and the realistic adversary is prompt-injection steering the agent that
// writes this file, against the trust gap between portal users. So validation
// is fail-closed and the schema is *strict* — unknown keys are rejected rather
// than ignored, and the two privileged capabilities the generic runner can
// express (an arbitrary `cwd`, and the rollover/restart flag) are NOT part of
// this schema. A config that tries to smuggle them in is rejected with a clear
// message rather than silently stripped.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { zapSubdir } from '../tools/zap-dir';
import { isPortalSecretEnvName } from './runner';

export const ACTIONS_FILE = 'actions.json';

// Keys that map to privileged runner capabilities. They are meaningless (and
// dangerous) in committed project config, so their presence anywhere in the
// file is treated as an explicit error rather than ignored — a prompt-injected
// agent shouldn't be able to probe for them silently.
const FORBIDDEN_KEYS = ['cwd', 'rollover', 'restarting', 'restart', 'inheritEnv'] as const;

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const ACTION_ID = /^[a-z0-9][a-z0-9-]*$/;

const StepSchema = z
	.object({
		label: z.string().trim().min(1).optional(),
		command: z.string().trim().min(1, 'step command must be non-empty'),
		args: z.array(z.string()).default([])
	})
	.strict();

const ActionSchema = z
	.object({
		id: z.string().trim().min(1).regex(ACTION_ID, 'id must be a lowercase slug (a-z, 0-9, hyphen)'),
		label: z.string().trim().min(1, 'label must be non-empty'),
		description: z.string().trim().optional(),
		permission: z.enum(['user', 'admin']).default('user'),
		env: z
			.array(z.string().regex(ENV_NAME, 'env entries must be env var NAMES, not values'))
			.default([])
			.superRefine((names, ctx) => {
				for (const name of names) {
					// A project action may pull an operator-provisioned project secret
					// (e.g. VERCEL_TOKEN), but never the portal's OWN credentials —
					// that would defeat default-deny and hand a prompt-injected config
					// the session/encryption/OAuth/agent secrets it otherwise can't see.
					if (isPortalSecretEnvName(name)) {
						ctx.addIssue({
							code: z.ZodIssueCode.custom,
							message: `env entry "${name}" is a reserved portal secret and cannot be passed to a project action`
						});
					}
				}
			}),
		steps: z.array(StepSchema).min(1, 'an action needs at least one step')
	})
	.strict();

const ConfigSchema = z
	.object({
		version: z.literal(1, { message: 'version must be 1' }),
		actions: z.array(ActionSchema).default([])
	})
	.strict()
	.superRefine((cfg, ctx) => {
		const seen = new Set<string>();
		for (const action of cfg.actions) {
			if (seen.has(action.id)) {
				ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate action id: ${action.id}` });
			}
			seen.add(action.id);
		}
	});

export type ActionStep = z.infer<typeof StepSchema>;
export type ActionDef = z.infer<typeof ActionSchema>;
export type ActionsConfig = z.infer<typeof ConfigSchema>;

export type LoadActionsResult = { ok: true; actions: ActionDef[] } | { ok: false; error: string };

/**
 * Pre-flight scan for forbidden privileged keys at any depth. zod's `.strict()`
 * already rejects unknown keys, but this runs first so the *message* names the
 * capability the author tried to use (`cwd`/`rollover`/…) instead of a generic
 * "unrecognized key", which is the more useful signal when reviewing why a
 * config was refused.
 */
function findForbiddenKey(value: unknown): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findForbiddenKey(item);
			if (found) return found;
		}
		return null;
	}
	if (value && typeof value === 'object') {
		for (const key of Object.keys(value as Record<string, unknown>)) {
			if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) return key;
		}
		for (const v of Object.values(value as Record<string, unknown>)) {
			const found = findForbiddenKey(v);
			if (found) return found;
		}
	}
	return null;
}

/** Parse + validate already-decoded JSON. Exposed for unit testing. */
export function parseActionsConfig(raw: unknown): LoadActionsResult {
	const forbidden = findForbiddenKey(raw);
	if (forbidden) {
		return {
			ok: false,
			error: `actions config invalid: the "${forbidden}" field is reserved for built-in actions and cannot be set in ${zapSubdir(ACTIONS_FILE)}`
		};
	}
	const result = ConfigSchema.safeParse(raw);
	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue?.path.join('.');
		const message = issue?.message ?? 'invalid config';
		return { ok: false, error: `actions config invalid: ${path ? `${path}: ` : ''}${message}` };
	}
	return { ok: true, actions: result.data.actions };
}

/**
 * Read, parse and validate `<workdir>/.zap/actions.json`.
 *
 * Outcomes:
 *  - file missing  => `{ ok: true, actions: [] }` (a project with no actions
 *    is the common case, not an error).
 *  - parse/validation failure => `{ ok: false, error }` so the UI can surface
 *    "actions config invalid" instead of silently dropping the file.
 */
export async function loadActionsConfig(workdir: string): Promise<LoadActionsResult> {
	const path = join(workdir, zapSubdir(ACTIONS_FILE));
	let text: string;
	try {
		text = await readFile(path, 'utf8');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, actions: [] };
		return { ok: false, error: `actions config unreadable: ${(e as Error).message}` };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { ok: false, error: `actions config invalid: not valid JSON (${(e as Error).message})` };
	}
	return parseActionsConfig(raw);
}
