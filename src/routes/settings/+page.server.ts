import { redirect, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad, Actions } from './$types';
import * as settings from '$lib/server/db/repos/settings';
import { effectiveWorkdir, resolveAndValidate } from '$lib/server/workdir';
import { loadConfig } from '$lib/server/config';
import { getDeployMetadata } from '$lib/server/deploy';
import { log } from '$lib/server/log';
import { audit } from '$lib/server/audit';
import { canRedeployUser } from '$lib/server/redeploy';
import { listBuiltInPromptTemplates } from '$lib/prompt-templates';
import { findUnknownPlaceholders, unknownPlaceholderMessage } from '$lib/prompt-templates';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import * as memoryProfiles from '$lib/server/memory/profiles';
import { PORTAL_TOOL_GROUP_IDS, sanitizeDisabledToolGroups } from '$lib/tools/groups';
import {
	normalizeThemeAccent,
	APPROVAL_MODES,
	SESSION_MODES,
	THEME_ACCENT_IDS,
	type ApprovalMode,
	type PermissionPolicy,
	type SessionMode,
	type UserSettings
} from '$lib/types';
import {
	GrantInputSchema,
	permissionKindForTool,
	persistedGrantTool
} from '$lib/permissions/scope-schema';
import { stableScopeKey } from '$lib/permissions/scope-codec';
import { defaultSeedGrants, restoreSeedGrantsForUser } from '$lib/server/permissions/seed-grants';
import { portalToolCatalog } from '$lib/server/tools/catalog';
import {
	applyWorkspaceFile,
	getWorkspaceFileStatus
} from '$lib/server/permissions/workspace-file-gate';
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.userId) throw redirect(302, '/login');
	const userId = locals.userId;
	const cfg = loadConfig();
	const currentSettings = settings.get(userId) ?? settings.defaults();

	// Make sure the ticket-action defaults exist so the Prompts tab can manage
	// them even before the user has visited a page that lazy-seeds them.
	promptTemplates.ensureTicketActionDefaults(userId);

	// Garbage-collect expired grants on load so the management table
	// doesn't show TTL'd rows the matcher is already ignoring.
	const purged = settings.pruneExpiredGrants();
	if (purged > 0) log.info('settings.grants_pruned', { count: purged });

	return {
		settings: currentSettings,
		recentDecisions: settings.listRecentDecisionsForUser(userId, 25),
		grants: markSeedGrants(settings.listGrantsForUser(userId)),
		workspaceFile: getWorkspaceFileStatus(userId, effectiveWorkdir(currentSettings.defaultWorkdir)),
		portalTools: portalToolCatalog(),
		builtInPromptTemplates: listBuiltInPromptTemplates(),
		promptTemplates: promptTemplates.list(userId, { status: 'all' }),
		customMemoryProfiles: memoryProfiles.listCustomProfiles(userId, { status: 'all' }),
		enableRedeploy: cfg.ENABLE_REDEPLOY && canRedeployUser(locals.user, cfg),
		deploy: getDeployMetadata()
	};
};

const SaveSchema = z.object({
	defaultModel: z.string().optional(),
	defaultWorkdir: z.string().optional(),
	defaultConversationMode: z.enum(SESSION_MODES),
	defaultApprovalMode: z.enum(APPROVAL_MODES),
	defaultPolicy: z.enum(['prompt', 'allow-all', 'deny-all']),
	theme: z.enum(['dark', 'light', 'system']),
	accent: z.enum(THEME_ACCENT_IDS as unknown as [string, ...string[]])
});

const PromptTemplateSchema = z
	.object({
		type: z.enum(['chat', 'ticket-action']).optional().default('chat'),
		title: z.string().trim().min(1).max(120),
		description: z.string().trim().max(500).optional(),
		prompt: z.string().trim().min(1).max(20_000),
		launchBehavior: z.enum(['send', 'draft', 'review']).optional(),
		conversationMode: z.enum(SESSION_MODES).optional(),
		approvalMode: z.enum(APPROVAL_MODES).optional(),
		model: z.string().trim().max(200).optional(),
		disabledToolGroups: z
			.array(z.enum(PORTAL_TOOL_GROUP_IDS as unknown as [string, ...string[]]))
			.optional(),
		workspaceMode: z.enum(['shared', 'worktree']).optional(),
		pinned: z.boolean().optional(),
		orderIndex: z.coerce.number().int().min(-1_000_000).max(1_000_000).optional()
	})
	.superRefine((body, ctx) => {
		const unknown = findUnknownPlaceholders(body.prompt, body.type);
		if (unknown.length > 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['prompt'],
				message: unknownPlaceholderMessage(body.type, unknown)
			});
		}
	});

const UpdatePromptTemplateSchema = z
	.object({
		id: z.string().min(1),
		type: z.enum(['chat', 'ticket-action']).optional().default('chat'),
		title: z.string().trim().min(1).max(120),
		description: z.string().trim().max(500).optional(),
		prompt: z.string().trim().min(1).max(20_000),
		launchBehavior: z.enum(['send', 'draft', 'review']).optional(),
		conversationMode: z.enum(SESSION_MODES).optional(),
		approvalMode: z.enum(APPROVAL_MODES).optional(),
		model: z.string().trim().max(200).optional(),
		disabledToolGroups: z
			.array(z.enum(PORTAL_TOOL_GROUP_IDS as unknown as [string, ...string[]]))
			.optional(),
		workspaceMode: z.enum(['shared', 'worktree']).optional(),
		pinned: z.boolean().optional(),
		orderIndex: z.coerce.number().int().min(-1_000_000).max(1_000_000).optional()
	})
	.superRefine((body, ctx) => {
		const unknown = findUnknownPlaceholders(body.prompt, body.type);
		if (unknown.length > 0) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['prompt'],
				message: unknownPlaceholderMessage(body.type, unknown)
			});
		}
	});

const MemoryProfileSchema = z.object({
	name: z.string().trim().min(1).max(120),
	description: z.string().trim().max(500).optional(),
	instructions: z.string().trim().min(1).max(8000),
	schemaJson: z.string().trim().min(2).max(20_000)
});

const UpdateMemoryProfileSchema = MemoryProfileSchema.extend({
	id: z.string().min(1)
});

export const actions: Actions = {
	save: async ({ request, locals, getClientAddress }) => {
		if (!locals.userId) return { ok: false, error: 'Not authenticated', formId: 'save' };
		const data = await request.formData();
		const parsed = SaveSchema.safeParse({
			defaultModel: (data.get('defaultModel') as string) || undefined,
			defaultWorkdir: (data.get('defaultWorkdir') as string) || undefined,
			defaultConversationMode: data.get('defaultConversationMode'),
			defaultApprovalMode: data.get('defaultApprovalMode'),
			defaultPolicy: data.get('defaultPolicy'),
			theme: data.get('theme'),
			accent: data.get('accent')
		});
		if (!parsed.success) {
			return {
				ok: false,
				error: parsed.error.issues[0]?.message ?? 'Invalid settings',
				formId: 'save'
			};
		}
		if (parsed.data.defaultWorkdir) {
			const res = resolveAndValidate(parsed.data.defaultWorkdir);
			if (!res.ok) {
				audit({
					event_type: 'workdir_override',
					actor_login: locals.user?.githubLogin ?? null,
					actor_ip: getClientAddress(),
					resource: parsed.data.defaultWorkdir,
					outcome: 'failure',
					detail: { context: 'settings_default_workdir', reason: res.reason }
				});
				return {
					ok: false,
					error: `Invalid default working directory: ${res.reason}`,
					formId: 'save'
				};
			}
			audit({
				event_type: 'workdir_override',
				actor_login: locals.user?.githubLogin ?? null,
				actor_ip: getClientAddress(),
				resource: res.path,
				outcome: 'success',
				detail: { context: 'settings_default_workdir' }
			});
		}
		const next: UserSettings = {
			defaultModel: parsed.data.defaultModel ?? null,
			defaultWorkdir: parsed.data.defaultWorkdir ?? null,
			defaultConversationMode: parsed.data.defaultConversationMode as SessionMode,
			defaultApprovalMode: parsed.data.defaultApprovalMode as ApprovalMode,
			defaultPolicy: parsed.data.defaultPolicy as PermissionPolicy,
			theme: parsed.data.theme,
			accent: normalizeThemeAccent(parsed.data.accent)
		};
		settings.save(locals.userId, next);
		return { ok: true, formId: 'save' };
	},
	createPromptTemplate: async ({ request, locals }) => {
		if (!locals.userId)
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'createPromptTemplate' });
		const data = await request.formData();
		const type = data.get('type') === 'ticket-action' ? 'ticket-action' : 'chat';
		const parsed = PromptTemplateSchema.safeParse({
			type,
			title: data.get('title'),
			description: (data.get('description') as string) || undefined,
			prompt: data.get('prompt'),
			launchBehavior: (data.get('launchBehavior') as string) || undefined,
			conversationMode: (data.get('conversationMode') as string) || undefined,
			approvalMode: (data.get('approvalMode') as string) || undefined,
			model: (data.get('model') as string) || undefined,
			disabledToolGroups:
				type === 'chat' ? data.getAll('disabledToolGroups').map(String) : undefined,
			workspaceMode: (data.get('workspaceMode') as string) || undefined,
			pinned: data.get('pinned') === 'on',
			orderIndex: (data.get('orderIndex') as string) || undefined
		});
		if (!parsed.success) {
			return fail(400, {
				ok: false,
				error: parsed.error.issues[0]?.message ?? 'Invalid prompt template',
				formId: 'createPromptTemplate'
			});
		}
		promptTemplates.create(locals.userId, {
			type: parsed.data.type,
			title: parsed.data.title,
			prompt: parsed.data.prompt,
			conversationMode: parsed.data.conversationMode ?? null,
			approvalMode: parsed.data.approvalMode ?? null,
			model: parsed.data.model ?? null,
			...(parsed.data.type === 'chat'
				? { disabledToolGroups: sanitizeDisabledToolGroups(parsed.data.disabledToolGroups) }
				: {}),
			...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
			workspaceMode: parsed.data.workspaceMode ?? null,
			...(parsed.data.launchBehavior !== undefined
				? { launchBehavior: parsed.data.launchBehavior }
				: {}),
			...(parsed.data.pinned !== undefined ? { pinned: parsed.data.pinned } : {}),
			...(parsed.data.orderIndex !== undefined ? { orderIndex: parsed.data.orderIndex } : {})
		});
		return { ok: true, formId: 'createPromptTemplate' };
	},
	updatePromptTemplate: async ({ request, locals }) => {
		if (!locals.userId)
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'updatePromptTemplate' });
		const data = await request.formData();
		const type = data.get('type') === 'ticket-action' ? 'ticket-action' : 'chat';
		const parsed = UpdatePromptTemplateSchema.safeParse({
			id: data.get('id'),
			type,
			title: data.get('title'),
			description: (data.get('description') as string) || undefined,
			prompt: data.get('prompt'),
			launchBehavior: (data.get('launchBehavior') as string) || undefined,
			conversationMode: (data.get('conversationMode') as string) || undefined,
			approvalMode: (data.get('approvalMode') as string) || undefined,
			model: (data.get('model') as string) || undefined,
			disabledToolGroups:
				type === 'chat' ? data.getAll('disabledToolGroups').map(String) : undefined,
			workspaceMode: (data.get('workspaceMode') as string) || undefined,
			pinned: data.get('pinned') === 'on',
			orderIndex: (data.get('orderIndex') as string) || undefined
		});
		if (!parsed.success) {
			return fail(400, {
				ok: false,
				error: parsed.error.issues[0]?.message ?? 'Invalid prompt template',
				formId: 'updatePromptTemplate'
			});
		}
		const { id, type: parsedType, ...patch } = parsed.data;
		const updated = promptTemplates.update(id, locals.userId, {
			title: patch.title,
			prompt: patch.prompt,
			...(patch.description !== undefined ? { description: patch.description } : {}),
			workspaceMode: patch.workspaceMode ?? null,
			...(patch.launchBehavior !== undefined ? { launchBehavior: patch.launchBehavior } : {}),
			conversationMode: patch.conversationMode ?? null,
			approvalMode: patch.approvalMode ?? null,
			model: patch.model ?? null,
			...(parsedType === 'chat'
				? { disabledToolGroups: sanitizeDisabledToolGroups(patch.disabledToolGroups) }
				: {}),
			...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
			...(patch.orderIndex !== undefined ? { orderIndex: patch.orderIndex } : {})
		});
		if (!updated)
			return fail(404, {
				ok: false,
				error: 'Prompt template not found',
				formId: 'updatePromptTemplate'
			});
		return { ok: true, formId: 'updatePromptTemplate' };
	},
	restorePromptTicketActions: async ({ locals }) => {
		if (!locals.userId)
			return fail(401, {
				ok: false,
				error: 'Not authenticated',
				formId: 'restorePromptTicketActions'
			});
		const restored = promptTemplates.restoreTicketActionDefaults(locals.userId);
		return { ok: true, restored, formId: 'restorePromptTicketActions' };
	},
	archivePromptTemplate: async ({ request, locals }) => {
		if (!locals.userId)
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'archivePromptTemplate' });
		const data = await request.formData();
		const id = data.get('id');
		if (typeof id !== 'string' || id.length === 0) {
			return fail(400, {
				ok: false,
				error: 'Invalid prompt template id',
				formId: 'archivePromptTemplate'
			});
		}
		const archived = promptTemplates.archive(id, locals.userId);
		if (!archived)
			return fail(404, {
				ok: false,
				error: 'Prompt template not found',
				formId: 'archivePromptTemplate'
			});
		return { ok: true, formId: 'archivePromptTemplate' };
	},
	createMemoryProfile: async ({ request, locals }) => {
		if (!locals.userId)
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'createMemoryProfile' });
		const data = await request.formData();
		const parsed = MemoryProfileSchema.safeParse({
			name: data.get('name'),
			description: (data.get('description') as string) || undefined,
			instructions: data.get('instructions'),
			schemaJson: data.get('schemaJson')
		});
		if (!parsed.success) {
			return fail(400, {
				ok: false,
				error: parsed.error.issues[0]?.message ?? 'Invalid memory profile',
				formId: 'createMemoryProfile'
			});
		}
		const schema = parseProfileSchema(parsed.data.schemaJson);
		if (!schema.ok)
			return fail(400, { ok: false, error: schema.error, formId: 'createMemoryProfile' });
		memoryProfiles.createCustomProfile(locals.userId, {
			name: parsed.data.name,
			instructions: parsed.data.instructions,
			schema: schema.value,
			...(parsed.data.description !== undefined ? { description: parsed.data.description } : {})
		});
		return { ok: true, formId: 'createMemoryProfile' };
	},
	updateMemoryProfile: async ({ request, locals }) => {
		if (!locals.userId)
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'updateMemoryProfile' });
		const data = await request.formData();
		const parsed = UpdateMemoryProfileSchema.safeParse({
			id: data.get('id'),
			name: data.get('name'),
			description: (data.get('description') as string) || undefined,
			instructions: data.get('instructions'),
			schemaJson: data.get('schemaJson')
		});
		if (!parsed.success) {
			return fail(400, {
				ok: false,
				error: parsed.error.issues[0]?.message ?? 'Invalid memory profile',
				formId: 'updateMemoryProfile'
			});
		}
		const schema = parseProfileSchema(parsed.data.schemaJson);
		if (!schema.ok)
			return fail(400, { ok: false, error: schema.error, formId: 'updateMemoryProfile' });
		const updated = memoryProfiles.updateCustomProfile(parsed.data.id, locals.userId, {
			name: parsed.data.name,
			instructions: parsed.data.instructions,
			schema: schema.value,
			...(parsed.data.description !== undefined ? { description: parsed.data.description } : {})
		});
		if (!updated)
			return fail(404, {
				ok: false,
				error: 'Memory profile not found',
				formId: 'updateMemoryProfile'
			});
		return { ok: true, formId: 'updateMemoryProfile' };
	},
	archiveMemoryProfile: async ({ request, locals }) => {
		if (!locals.userId)
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'archiveMemoryProfile' });
		const data = await request.formData();
		const id = data.get('id');
		if (typeof id !== 'string' || id.length === 0) {
			return fail(400, {
				ok: false,
				error: 'Invalid memory profile id',
				formId: 'archiveMemoryProfile'
			});
		}
		const archived = memoryProfiles.archiveCustomProfile(id, locals.userId);
		if (!archived)
			return fail(404, {
				ok: false,
				error: 'Memory profile not found',
				formId: 'archiveMemoryProfile'
			});
		return { ok: true, formId: 'archiveMemoryProfile' };
	},
	revokeGrant: async ({ request, locals }) => {
		if (!locals.userId)
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'revokeGrant' });
		const data = await request.formData();
		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) {
			return fail(400, { ok: false, error: 'Invalid grant id', formId: 'revokeGrant' });
		}
		const removed = settings.revokeGrant(locals.userId, id);
		if (!removed) return fail(404, { ok: false, error: 'Grant not found', formId: 'revokeGrant' });
		log.info('settings.grant_revoked', { userId: locals.userId, id });
		return { ok: true, formId: 'revokeGrant' };
	},
	revokeAllGrants: async ({ locals }) => {
		if (!locals.userId) {
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'revokeAllGrants' });
		}
		const removed = settings.revokeAllGrantsForUser(locals.userId);
		log.info('settings.grants_revoked_all', { userId: locals.userId, count: removed });
		return { ok: true, removed, formId: 'revokeAllGrants' };
	},

	/**
	 * Replace identifiable default seed grants with the current default set.
	 * This lets users recover after "Revoke all grants" and swap stale default
	 * rows (for example old hard-deny prompt seeds) for the current defaults without
	 * rewriting unrelated user-created grants.
	 */
	restoreSeedGrants: async ({ locals }) => {
		if (!locals.userId) {
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'restoreSeedGrants' });
		}
		const result = restoreSeedGrantsForUser(locals.userId);
		log.info('settings.seed_grants_restored', { userId: locals.userId, ...result });
		return { ok: true, ...result, formId: 'restoreSeedGrants' };
	},

	/**
	 * Manually import the current `.zap/permissions.toml` from the Settings
	 * page. Unlike the interactive gate, this is an explicit human gesture on
	 * a page that shows the current diff, so the current file is applied
	 * unconditionally (after parse validation). Applies to the user's
	 * effective workdir, never to a client-supplied path.
	 */
	workspaceFileApprove: async ({ locals }) => {
		if (!locals.userId) {
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'workspaceFileApprove' });
		}
		const current = settings.get(locals.userId) ?? settings.defaults();
		const root = effectiveWorkdir(current.defaultWorkdir);
		const result = applyWorkspaceFile({ userId: locals.userId, workspaceRoot: root });
		if (!result.ok) {
			return fail(400, {
				ok: false,
				error: `Could not import workspace permissions: ${result.error}`,
				formId: 'workspaceFileApprove'
			});
		}
		log.info('settings.workspace_file_applied', {
			userId: locals.userId,
			workspaceRoot: root,
			applied: result.applied
		});
		return { ok: true, applied: result.applied, formId: 'workspaceFileApprove' };
	},

	/** Keep the previously approved state; the gate re-nags on the next request. */
	workspaceFileReject: async ({ locals }) => {
		if (!locals.userId) {
			return fail(401, { ok: false, error: 'Not authenticated', formId: 'workspaceFileReject' });
		}
		return { ok: true, formId: 'workspaceFileReject' };
	},

	/**
	 * Author a new user-global grant from the Settings form. The dialog
	 * still owns conversation-scoped + interactive-prompt grant creation;
	 * this action exists to cover the long tail of structured scopes
	 * (shell `workspace-paths`, fs `prefix`, url `host-suffix`, etc.) that
	 * the dialog has no UI for.
	 */
	createGrant: async ({ request, locals }) => {
		if (!locals.userId) return fail(401, { ok: false, error: 'Not authenticated' });
		const data = await request.formData();

		const parsedInput = parseGrantFormData(data, 'createGrant');
		if (!parsedInput.ok) return parsedInput.failure;
		const { input } = parsedInput;

		// Dedup against existing user-global grants with identical
		// (tool, kind, scope_json). Mirrors `ensureSeedGrantsForUser`.
		const tool = persistedGrantTool(input);
		const permissionKind = permissionKindForTool(input.tool);
		const scopeKey = stableScopeKey(input.scope);
		const existing = settings.listGrantsForUser(locals.userId);
		const duplicate = existing.find(
			(g) =>
				g.conversationId === null &&
				g.tool === tool &&
				g.permissionKind === permissionKind &&
				g.scope !== null &&
				stableScopeKey(g.scope) === scopeKey &&
				g.decision === input.decision
		);
		if (duplicate) {
			return { ok: true, formId: 'createGrant', duplicate: true };
		}

		settings.addGrant({
			userId: locals.userId,
			conversationId: null,
			tool,
			permissionKind,
			scope: input.scope,
			decision: input.decision,
			expiresAt: input.expiresAt,
			denyReason: input.denyReason,
			source: 'settings'
		});
		log.info('settings.grant_created', {
			userId: locals.userId,
			tool,
			permissionKind,
			decision: input.decision,
			scopeKind: input.scope.kind
		});
		return { ok: true, formId: 'createGrant' };
	},

	/**
	 * Edit an existing grant in place. Preserves the row's
	 * `conversation_id` and `granted_at`; only the matchable fields
	 * (tool/kind/scope/decision/expiry) change. Used by the "Edit" button
	 * on each grant row.
	 */
	updateGrant: async ({ request, locals }) => {
		if (!locals.userId) return fail(401, { ok: false, error: 'Not authenticated' });
		const data = await request.formData();

		const id = Number(data.get('id'));
		if (!Number.isInteger(id) || id <= 0) {
			return fail(400, { ok: false, error: 'Invalid grant id', formId: 'updateGrant' });
		}

		const parsedInput = parseGrantFormData(data, 'updateGrant');
		if (!parsedInput.ok) return parsedInput.failure;
		const { input } = parsedInput;

		const tool = persistedGrantTool(input);
		const permissionKind = permissionKindForTool(input.tool);
		const updated = settings.updateGrant(locals.userId, id, {
			tool,
			permissionKind,
			scopePattern: null,
			scope: input.scope,
			decision: input.decision,
			expiresAt: input.expiresAt,
			denyReason: input.denyReason
		});
		if (!updated) {
			return fail(404, { ok: false, error: 'Grant not found', formId: 'updateGrant' });
		}
		log.info('settings.grant_updated', {
			userId: locals.userId,
			id,
			tool,
			permissionKind,
			decision: input.decision,
			scopeKind: input.scope.kind
		});
		return { ok: true, formId: 'updateGrant' };
	}
};

type ParseGrantResult =
	| { ok: true; input: import('$lib/permissions/scope-schema').GrantInput }
	| { ok: false; failure: ReturnType<typeof fail> };

function parseGrantFormData(data: FormData, formId: string): ParseGrantResult {
	let scope: unknown;
	const scopeJson = data.get('scopeJson');
	if (typeof scopeJson !== 'string' || scopeJson.length === 0) {
		return { ok: false, failure: fail(400, { ok: false, error: 'Missing scope payload', formId }) };
	}
	try {
		scope = JSON.parse(scopeJson);
	} catch {
		return {
			ok: false,
			failure: fail(400, { ok: false, error: 'Scope payload was not valid JSON', formId })
		};
	}

	const expiresRaw = data.get('expiresAt');
	const expiresAt =
		typeof expiresRaw === 'string' && expiresRaw.length > 0 ? Date.parse(expiresRaw) : null;
	if (expiresAt !== null && Number.isNaN(expiresAt)) {
		return { ok: false, failure: fail(400, { ok: false, error: 'Invalid expiry date', formId }) };
	}

	const denyReasonRaw = data.get('denyReason');
	const denyReason = typeof denyReasonRaw === 'string' ? denyReasonRaw : null;

	const parsed = GrantInputSchema.safeParse({
		tool: data.get('tool'),
		toolName: data.get('toolName'),
		decision: data.get('decision'),
		scope,
		expiresAt,
		denyReason
	});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
		return {
			ok: false,
			failure: fail(400, {
				ok: false,
				error: `${issue?.message ?? 'Invalid grant'}${where}`,
				formId
			})
		};
	}
	return { ok: true, input: parsed.data };
}

function parseProfileSchema(
	raw: string
): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { ok: false, error: 'Profile schema must be a JSON object.' };
		}
		return { ok: true, value: parsed };
	} catch (e) {
		return {
			ok: false,
			error: `Profile schema must be valid JSON: ${e instanceof Error ? e.message : String(e)}`
		};
	}
}

function markSeedGrants(grants: settings.GrantSummary[]) {
	const seedKeys = new Set(
		defaultSeedGrants().map((seed) =>
			defaultSeedGrantKey(
				seed.tool,
				seed.permissionKind,
				seed.scope ?? null,
				seed.scopePattern ?? null,
				seed.decision ?? 'allow'
			)
		)
	);

	return grants.map((grant) => ({
		...grant,
		isSeedGrant:
			// Workspace-file rows are checked-in workspace policy, not seeds —
			// even when their scope happens to match a default seed key.
			grant.source !== 'workspace-file' &&
			(grant.source === 'seed' ||
				(grant.conversationId === null &&
					seedKeys.has(
						defaultSeedGrantKey(
							grant.tool,
							grant.permissionKind,
							grant.scope,
							grant.scopePattern,
							grant.decision
						)
					)))
	}));
}

function defaultSeedGrantKey(
	tool: string,
	permissionKind: string | null,
	scope: import('$lib/permissions/scope-types').GrantScope | null,
	scopePattern: string | null,
	decision: string
) {
	return `${tool}\u0000${permissionKind ?? ''}\u0000${decision}\u0000${scope ? stableScopeKey(scope) : `pattern:${scopePattern ?? ''}`}`;
}
