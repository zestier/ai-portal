import { z } from 'zod';
import { conversationId as convCodec } from '$lib/ids';
import { getLease, removeLease } from '../../leases';
import { err, ok, type PortalTool } from '../types';
import { describeWorktreeError } from './common';

export const RemoveArgs = z
	.object({
		leaseId: z.string().trim().min(1).max(64),
		force: z.boolean().optional()
	})
	.strict();

export function buildWorktreeRemoveTool(ctx: {
	userId: number;
	conversationId: number;
}): PortalTool {
	return {
		name: 'worktree_remove',
		description:
			'Remove a worktree created by worktree_create. Refuses with uncommitted changes unless `force: true` (permanently discards them).',
		promptGuidelines: [
			'Committed unmerged work is never lost: the branch is kept and its name returned.'
		],
		argsSchema: RemoveArgs,
		// Always prompts. PortalTool exposes a static behavior rather than an
		// arg-dependent one, so the only way to guarantee `force: true` (which
		// destroys uncommitted work) is confirmed is to confirm every removal.
		// Because `always-prompt` is evaluated before grant matching, no grant
		// or policy can ever relax this — unlike `worktree_create`, which is
		// grant-matchable.
		//
		// It over-confirms, but less than it looks: a removal WITHOUT `force`
		// keeps status-visible changes (refuses while dirty) and never deletes
		// an unmerged branch, yet it still drops ignored files with the tree
		// and — unlike `removeLeasesForConversation` and the reaper — carries
		// no unmerged guard, so it can leave committed work reachable only via
		// an obscure branch name. Making the behavior arg-aware is the fix, but
		// it has to close that gap first: ticket 01KYRQ6D493JHNRVSJY4VW7S15.
		permissionBehavior: 'always-prompt',
		parameters: {
			type: 'object',
			properties: {
				leaseId: { type: 'string', description: 'Worktree id.' },
				force: {
					type: 'boolean',
					description: 'Discard uncommitted changes and remove anyway. Destructive.'
				}
			},
			required: ['leaseId'],
			additionalProperties: false
		},
		async handler(args) {
			const parsed = RemoveArgs.parse(args);
			const lease = getLease(parsed.leaseId, ctx.userId);
			if (!lease || lease.heldByConversationId !== convCodec.encode(ctx.conversationId)) {
				return err(`no worktree with id ${parsed.leaseId} in this conversation`, {
					code: 'lease_not_found'
				});
			}
			try {
				const result = await removeLease(lease, parsed.force ? { force: true } : {});
				return ok(
					{ removed: true, branch: result.branch, branchDeleted: result.branchDeleted },
					result.branchDeleted
						? `Removed worktree ${lease.label} and its merged branch`
						: `Removed worktree ${lease.label}; branch ${result.branch} kept`,
					result.branchDeleted
						? undefined
						: {
								followUpHint: `Branch ${result.branch} still has unmerged commits and was kept. Merge or delete it deliberately.`
							}
				);
			} catch (cause) {
				const described = describeWorktreeError(cause);
				if (described) {
					return err(
						described.code === 'worktree_dirty'
							? `${described.message}. Commit the work first with git_commit { worktree: "${parsed.leaseId}", paths: "all", subject: "<message>" }, or pass force: true to discard it.`
							: described.message,
						described.code ? { code: described.code } : undefined
					);
				}
				throw cause;
			}
		}
	};
}
