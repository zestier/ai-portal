import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { conversationId as convCodec, promptTemplateId } from '$lib/ids';
import { getDb } from '$lib/server/db';
import * as convs from '$lib/server/db/repos/conversations';
import * as settings from '$lib/server/db/repos/settings';
import * as promptTemplates from '$lib/server/db/repos/prompt-templates';
import { loadConfig } from '$lib/server/config';
import { APPROVAL_MODES, SESSION_MODES } from '$lib/types';
import { PORTAL_TOOL_GROUP_IDS, sanitizeDisabledToolGroups } from '$lib/tools/groups';
import { projectRoot, resolveAndValidate } from '$lib/server/workdir';
import { parseBody } from '$lib/server/validate';
import { audit } from '$lib/server/audit';
import { createManagedWorktree, WorktreeError } from '$lib/server/worktrees';

const WorkspaceInput = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('shared'), path: z.string().min(1).optional() }),
	z.object({
		kind: z.literal('worktree'),
		sourcePath: z.string().min(1).optional(),
		baseRef: z.string().min(1).max(500).optional()
	})
]);

export const GET: RequestHandler = ({ locals, url }) => {
	const userId = locals.userId;
	const includeArchived = url.searchParams.get('archived') === '1';
	return json({ conversations: convs.list(userId, { includeArchived }) });
};

const CreateBody = z
	.object({
		title: z.string().min(1).max(200).default('New chat'),
		model: z.string().min(1).optional(),
		workdir: z.string().min(1).optional(),
		mode: z.enum(SESSION_MODES).optional(),
		approvalMode: z.enum(APPROVAL_MODES).optional(),
		memoryExtractorModel: z.string().min(1).optional(),
		adversaryModel: z.string().min(1).optional(),
		/**
		 * Optional chat prompt-template to seed conversation settings from. When it
		 * resolves to one of the caller's own templates (chat or ticket-action),
		 * its `disabledToolGroups` preset is copied onto the new conversation
		 * unless the request carries an explicit `disabledToolGroups` body field
		 * (which always wins).
		 */
		promptTemplateId: z.string().optional(),
		/**
		 * Explicit tool groups to disable on the new conversation. When present,
		 * WINS over any preset seeded from `promptTemplateId`; clients always
		 * send this from their resolved launch options (possibly `[]`) so a
		 * review-dialog edit can clear a template preset.
		 */
		disabledToolGroups: z
			.array(z.enum(PORTAL_TOOL_GROUP_IDS as unknown as [string, ...string[]]))
			.optional(),
		workspace: WorkspaceInput.optional()
	})
	.refine((body) => !(body.workdir && body.workspace), {
		message: 'workdir and workspace cannot both be supplied'
	});

export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
	const userId = locals.userId;
	const body = await parseBody(request, CreateBody);
	const cfg = loadConfig();
	const userSettings = settings.get(userId) ?? settings.defaults();
	const model = body.model ?? userSettings.defaultModel ?? cfg.DEFAULT_MODEL;

	// Seed tool-group scoping from a supplied template when one is owned by the
	// caller (chat OR ticket-action — both support a preset). Missing /
	// other-user templates seed nothing. An explicit `disabledToolGroups` body
	// field always wins over the template preset (that's how a review-dialog
	// edit clears or replaces it). A template that pins
	// `workspaceMode: 'worktree'` also seeds the workspace when the request
	// didn't state one explicitly (an explicit `workspace` always wins — that's
	// how a resolved `ask` launch is expressed).
	const tplId = body.promptTemplateId ? promptTemplateId.tryParse(body.promptTemplateId) : null;
	const tpl = tplId ? promptTemplates.get(tplId, userId) : null;
	const disabledToolGroups =
		body.disabledToolGroups !== undefined
			? sanitizeDisabledToolGroups(body.disabledToolGroups)
			: tpl
				? tpl.disabledToolGroups
				: [];
	let workspace = body.workspace;
	if (tpl && !workspace && !body.workdir && tpl.workspaceMode === 'worktree') {
		workspace = { kind: 'worktree' };
	}

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

	// With integer PKs the conversation id can no longer be minted ahead of the
	// insert, and the managed-worktree path/branch derive from it. So the row is
	// created first against the source workdir; a worktree conversation is then
	// built against its id and the row promoted to the checkout's path.
	const createRow = (workdir: string) =>
		convs.create(userId, {
			title: body.title,
			workdir,
			workspaceKind: 'shared',
			workspaceKey: workdir,
			model,
			mode: body.mode ?? userSettings.defaultConversationMode,
			approvalMode: body.approvalMode ?? userSettings.defaultApprovalMode,
			memoryExtractorModel: body.memoryExtractorModel ?? null,
			adversaryModel: body.adversaryModel ?? null,
			disabledToolGroups,
			systemPrompt: tpl?.systemPrompt ?? null,
			appendSystemPrompt: tpl?.appendSystemPrompt ?? null
		});

	if (workspace?.kind !== 'worktree') {
		return json({ ok: true, conversation: createRow(workdir) }, { status: 201 });
	}

	const conv = createRow(workdir);
	const convId = convCodec.parse(conv.id);
	let managedWorktree;
	try {
		managedWorktree = await createManagedWorktree({
			sourceWorkdir: workdir,
			userId: String(userId),
			conversationId: conv.id,
			...(workspace.baseRef ? { baseRef: workspace.baseRef } : {})
		});
	} catch (cause) {
		convs.remove(convId, userId);
		if (cause instanceof WorktreeError) {
			audit({
				event_type: 'worktree_create',
				actor_login: locals.user?.githubLogin ?? null,
				actor_ip: getClientAddress(),
				resource: workdir,
				outcome: 'failure',
				detail: { conversationId: conv.id, code: cause.code }
			});
			throw error(cause.code === 'git_failed' ? 500 : 400, {
				message: cause.message,
				code: cause.code
			});
		}
		throw cause;
	}
	getDb().transaction(() => {
		convs.setManagedWorktree(convId, managedWorktree);
		getDb()
			.prepare(
				`UPDATE conversations SET workdir = ?, workspace_kind = ?, workspace_key = ? WHERE id = ?`
			)
			.run(managedWorktree.path, 'managed-worktree', managedWorktree.sourceWorkdir, convId);
	})();
	const promoted = convs.get(convId, userId)!;
	audit({
		event_type: 'worktree_create',
		actor_login: locals.user?.githubLogin ?? null,
		actor_ip: getClientAddress(),
		resource: managedWorktree.path,
		outcome: 'success',
		detail: { conversationId: conv.id, branch: managedWorktree.branch }
	});
	return json({ ok: true, conversation: promoted }, { status: 201 });
};
