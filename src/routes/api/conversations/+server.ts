import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import * as convs from '$lib/server/db/repos/conversations';
import * as settings from '$lib/server/db/repos/settings';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import { loadConfig } from '$lib/server/config';
import { getDefaultProviderId } from '$lib/server/providers';
import { APPROVAL_MODES, MEMORY_EXTRACTOR_BACKEND_IDS, SESSION_MODES } from '$lib/types';
import { normalizeProviderInstance } from '$lib/server/providers/registry';
import { projectRoot, resolveAndValidate } from '$lib/server/workdir';
import { parseBody } from '$lib/server/validate';
import { requireUserId } from '$lib/server/auth/require';
import { audit } from '$lib/server/audit';
import {
	createManagedWorktree,
	rollbackManagedWorktree,
	WorktreeError
} from '$lib/server/worktrees';

const WorkspaceInput = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('shared'), path: z.string().min(1).optional() }),
	z.object({
		kind: z.literal('worktree'),
		sourcePath: z.string().min(1).optional(),
		baseRef: z.string().min(1).max(500).optional()
	})
]);

export const GET: RequestHandler = ({ locals, url }) => {
	const userId = requireUserId(locals);
	const includeArchived = url.searchParams.get('archived') === '1';
	return json({ conversations: convs.list(userId, { includeArchived }) });
};

const CreateBody = z
	.object({
		title: z.string().min(1).max(200).default('New chat'),
		provider: z.string().trim().min(1).optional(),
		model: z.string().min(1).optional(),
		workdir: z.string().min(1).optional(),
		mode: z.enum(SESSION_MODES).optional(),
		approvalMode: z.enum(APPROVAL_MODES).optional(),
		memoryExtractorModel: z.string().min(1).optional(),
		memoryExtractorBackend: z.enum(MEMORY_EXTRACTOR_BACKEND_IDS).optional(),
		adversaryModel: z.string().min(1).optional(),
		adversaryBackend: z.string().min(1).optional(),
		/**
		 * Optional chat prompt-template to seed conversation settings from. When it
		 * resolves to one of the caller's own chat templates, its
		 * `disabledToolGroups` preset is copied onto the new conversation.
		 */
		promptTemplateId: z.string().min(1).optional(),
		workspace: WorkspaceInput.optional()
	})
	.refine((body) => !(body.workdir && body.workspace), {
		message: 'workdir and workspace cannot both be supplied'
	});

export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
	const userId = requireUserId(locals);
	const body = await parseBody(request, CreateBody);
	const cfg = loadConfig();
	const userSettings = settings.get(userId) ?? settings.defaults();
	const provider = body.provider ?? userSettings.defaultProvider ?? getDefaultProviderId();
	const model = body.model ?? userSettings.defaultModel ?? cfg.DEFAULT_MODEL;

	// Seed tool-group scoping from a chat template when one is supplied and owned
	// by the caller. Non-chat / missing / other-user templates seed nothing.
	// A template that pins `workspaceMode: 'worktree'` also seeds the workspace
	// when the request didn't state one explicitly (an explicit `workspace`
	// always wins — that's how a resolved `ask` launch is expressed).
	let disabledToolGroups: string[] = [];
	let workspace = body.workspace;
	if (body.promptTemplateId) {
		const tpl = promptTemplates.get(body.promptTemplateId, userId);
		if (tpl && tpl.type === 'chat') disabledToolGroups = tpl.disabledToolGroups;
		if (tpl && !workspace && !body.workdir && tpl.workspaceMode === 'worktree') {
			workspace = { kind: 'worktree' };
		}
	}

	const id = convs.newId();
	// Precedence: explicit body.workdir > user's defaultWorkdir > PROJECT_ROOT.
	const requested =
		workspace?.kind === 'shared'
			? (workspace.path ?? userSettings.defaultWorkdir ?? null)
			: workspace?.kind === 'worktree'
				? (workspace.sourcePath ?? userSettings.defaultWorkdir ?? null)
				: (body.workdir ?? userSettings.defaultWorkdir ?? null);
	let workdir: string;
	if (requested) {
		const res = resolveAndValidate(requested);
		if (!res.ok) {
			audit({
				event_type: 'workdir_override',
				actor_login: locals.user?.githubLogin ?? null,
				actor_ip: getClientAddress(),
				resource: requested,
				outcome: 'failure',
				detail: { context: 'conversation_create', reason: res.reason }
			});
			throw error(400, res.reason);
		}
		workdir = res.path;
		audit({
			event_type: 'workdir_override',
			actor_login: locals.user?.githubLogin ?? null,
			actor_ip: getClientAddress(),
			resource: workdir,
			outcome: 'success',
			detail: { context: 'conversation_create', source: body.workdir ? 'explicit' : 'user_default' }
		});
	} else {
		workdir = projectRoot();
	}

	let managedWorktree;
	if (workspace?.kind === 'worktree') {
		try {
			managedWorktree = await createManagedWorktree({
				sourceWorkdir: workdir,
				userId,
				conversationId: id,
				...(workspace.baseRef ? { baseRef: workspace.baseRef } : {})
			});
		} catch (cause) {
			if (cause instanceof WorktreeError) {
				audit({
					event_type: 'worktree_create',
					actor_login: locals.user?.githubLogin ?? null,
					actor_ip: getClientAddress(),
					resource: workdir,
					outcome: 'failure',
					detail: { conversationId: id, code: cause.code }
				});
				throw error(cause.code === 'git_failed' ? 500 : 400, {
					message: cause.message,
					code: cause.code
				});
			}
			throw cause;
		}
	}
	let conv;
	try {
		conv = convs.create(userId, {
			id,
			title: body.title,
			workdir: managedWorktree?.path ?? workdir,
			workspaceKind: managedWorktree ? 'managed-worktree' : 'shared',
			workspaceKey: managedWorktree?.sourceWorkdir ?? workdir,
			...(managedWorktree ? { managedWorktree } : {}),
			provider: normalizeProviderInstance(provider),
			model,
			mode: body.mode ?? userSettings.defaultConversationMode,
			approvalMode: body.approvalMode ?? userSettings.defaultApprovalMode,
			// Seed-only, mirroring model/mode precedence: explicit create-body field
			// wins, else the user's default, else NULL (resolved from env at runtime).
			memoryExtractorModel:
				body.memoryExtractorModel ?? userSettings.defaultMemoryExtractorModel ?? null,
			memoryExtractorBackend:
				body.memoryExtractorBackend ?? userSettings.defaultMemoryExtractorBackend ?? null,
			adversaryModel: body.adversaryModel ?? userSettings.defaultAdversaryModel ?? null,
			adversaryBackend: body.adversaryBackend ?? userSettings.defaultAdversaryBackend ?? null,
			disabledToolGroups
		});
	} catch (cause) {
		if (managedWorktree) await rollbackManagedWorktree(managedWorktree).catch(() => undefined);
		throw cause;
	}
	if (managedWorktree) {
		audit({
			event_type: 'worktree_create',
			actor_login: locals.user?.githubLogin ?? null,
			actor_ip: getClientAddress(),
			resource: managedWorktree.path,
			outcome: 'success',
			detail: { conversationId: id, branch: managedWorktree.branch }
		});
	}
	return json({ ok: true, conversation: conv }, { status: 201 });
};
