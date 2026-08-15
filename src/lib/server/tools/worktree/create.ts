import { z } from 'zod';
import { createLease } from '../../leases';
import { err, ok, type PortalTool } from '../types';
import * as convs from '../../db/repos/conversations';
import { describeWorktreeError, leaseView } from './common';

export const CreateArgs = z
	.object({
		label: z.string().trim().min(1).max(33).describe('Unit-of-work slug.'),
		baseRef: z.string().trim().min(1).max(500).optional()
	})
	.strict();

export function buildWorktreeCreateTool(ctx: {
	userId: number;
	conversationId: number;
}): PortalTool {
	// Re-read the conversation per call rather than capturing it: a lease may be
	// created many turns after the session was established.
	const conversation = () => convs.get(ctx.conversationId, ctx.userId);
	return {
		name: 'worktree_create',
		description:
			"Create an isolated Git worktree of this conversation's repository on its own branch.",
		promptGuidelines: [
			"Returns an absolute `path` that already exists and is writable; changes stay isolated until the branch is merged. One worktree per unit of work; the repo is always this conversation's own.",
			'Never point two sub-agents at the same worktree. Tell each sub-agent to `git_commit` when done (uncommitted changes cannot be merged), then merge it back with `worktree_merge` + `squash` and `worktree_remove` it. Worktrees are for parallelism — a single sequential task belongs in the normal workspace.'
		],
		argsSchema: CreateArgs,
		parameters: {
			type: 'object',
			properties: {
				label: {
					type: 'string',
					description: 'Slug for the unit of work (lowercase, digits, dashes).'
				},
				baseRef: {
					type: 'string',
					description: 'Optional base commit/branch/tag. Defaults to current HEAD.'
				}
			},
			required: ['label'],
			additionalProperties: false
		},
		async handler(args) {
			const parsed = CreateArgs.parse(args);
			const conv = conversation();
			if (!conv) return err('conversation not found', { code: 'conversation_not_found' });
			try {
				const lease = await createLease({
					conversation: conv,
					label: parsed.label,
					...(parsed.baseRef ? { baseRef: parsed.baseRef } : {})
				});
				return ok(leaseView(lease, 0), `Created worktree ${lease.label} on ${lease.branch}`, {
					followUpHint:
						`The directory ${lease.path} already exists and is writable. Hand that ABSOLUTE path to one sub-agent and tell it to do all of its work there and nowhere else, and to COMMIT when it is done. ` +
						'Do not point two sub-agents at the same worktree. When it finishes, worktree_merge the work back into this conversation, then worktree_remove the worktree.'
				});
			} catch (cause) {
				const described = describeWorktreeError(cause);
				if (described) {
					return err(described.message, described.code ? { code: described.code } : undefined);
				}
				throw cause;
			}
		}
	};
}
