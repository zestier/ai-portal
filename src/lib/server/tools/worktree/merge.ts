import { z } from 'zod';
import { conversationId as convCodec } from '$lib/ids';
import { getLease, mergeLease } from '../../leases';
import { err, ok, type PortalTool } from '../types';
import * as convs from '../../db/repos/conversations';
import { SquashArg, SQUASH_PARAM } from '../commit-message-args';
import { describeWorktreeError, mergeErrorMessage } from './common';

export const MergeArgs = z
	.object({
		leaseId: z.string().trim().min(1).max(64),
		direction: z.enum(['to-source', 'from-source']).optional(),
		allowMergeCommit: z.boolean().optional(),
		onConflict: z.enum(['abort', 'keep']).optional(),
		squash: SquashArg
	})
	.strict();

export function buildWorktreeMergeTool(ctx: {
	userId: number;
	conversationId: number;
}): PortalTool {
	// Re-read the conversation per call rather than capturing it: a lease may be
	// created many turns after the session was established.
	const conversation = () => convs.get(ctx.conversationId, ctx.userId);
	return {
		name: 'worktree_merge',
		description: 'Merge a PORTAL worktree lease back into this conversation.',
		promptGuidelines: [
			"`to-source` (default) merges a sub-agent's committed work; pass `squash` with a subject to collapse commits into one.",
			'Refuses with uncommitted changes on either side. `to-source` always rolls back on conflict; a `from-source` conflict can be left (`keep`) for a sub-agent to finish with git_commit { paths: "all" } or discard with git_merge_abort.'
		],
		argsSchema: MergeArgs,
		// Always prompts, matching `git_worktree_merge` and `git_commit`.
		//
		// This is not merely symmetry: for a SHARED-workdir conversation the
		// counterpart is the repository's main checkout, so an unprompted
		// `worktree_merge` would mutate the human's tree via exactly the
		// operation `git_worktree_merge` gates. PortalTool exposes a static
		// behavior, so — as with `worktree_remove` and its `force` — the only
		// way to guarantee that case is confirmed is to confirm every merge.
		//
		// Relaxing this for isolated workspaces is plausible but is a decision
		// about how much approval an agent needs for its own actions; it belongs
		// to the open design ticket on that question, not to this tool.
		permissionBehavior: 'always-prompt',
		parameters: {
			type: 'object',
			properties: {
				leaseId: { type: 'string', description: 'Worktree id.' },
				direction: {
					type: 'string',
					enum: ['to-source', 'from-source'],
					description: 'to-source (default) | from-source.'
				},
				allowMergeCommit: {
					type: 'boolean',
					description: 'to-source only. Default false (fast-forward).'
				},
				squash: SQUASH_PARAM,
				onConflict: {
					type: 'string',
					enum: ['abort', 'keep'],
					description:
						'from-source only. abort (default) rolls back; keep leaves the conflict to finish with git_commit or discard with git_merge_abort.'
				}
			},
			required: ['leaseId'],
			additionalProperties: false
		},
		async handler(args) {
			const parsed = MergeArgs.parse(args);
			const conv = conversation();
			if (!conv) return err('conversation not found', { code: 'conversation_not_found' });
			const lease = getLease(parsed.leaseId, ctx.userId);
			if (!lease || lease.heldByConversationId !== convCodec.encode(ctx.conversationId)) {
				return err(`no worktree with id ${parsed.leaseId} in this conversation`, {
					code: 'lease_not_found'
				});
			}
			try {
				const result = await mergeLease(lease, conv, {
					...(parsed.direction ? { direction: parsed.direction } : {}),
					...(parsed.allowMergeCommit === undefined
						? {}
						: { allowMergeCommit: parsed.allowMergeCommit }),
					...(parsed.onConflict ? { onConflict: parsed.onConflict } : {}),
					...(parsed.squash === undefined ? {} : { squash: parsed.squash })
				});
				if (!result.merged) {
					return ok(result, `Already up to date: nothing to merge into ${result.into}`);
				}
				return ok(
					result,
					`Merged ${result.from} into ${result.into}${result.fastForward ? ' (fast-forward)' : ''}${
						result.squashedCommits === undefined
							? ''
							: `, squashed from ${result.squashedCommits} commit(s)`
					}`,
					result.direction === 'to-source'
						? {
								followUpHint: `${lease.label}'s work is now in this conversation. Remove the worktree with worktree_remove once you no longer need it.`
							}
						: undefined
				);
			} catch (cause) {
				const described = describeWorktreeError(cause);
				if (described) {
					return err(
						mergeErrorMessage(
							described,
							parsed.leaseId,
							parsed.direction === 'from-source' && parsed.onConflict === 'keep'
						),
						described.code ? { code: described.code } : undefined
					);
				}
				throw cause;
			}
		}
	};
}
