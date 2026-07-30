// Agent-facing worktree tools.
//
// These let an ORCHESTRATOR — an agent that fans work out to parallel
// sub-agents — give each unit of work its own checkout, instead of having every
// sub-agent edit one shared tree and clobber each other.
//
// The intended flow is deliberately narrow:
//   worktree_create → hand the absolute `path` to a sub-agent → worktree_remove
//
// Two invariants worth knowing before changing anything here:
//   - The source repository is NEVER a tool argument. `leases.ts` derives it
//     from the holding conversation, because accepting it here would turn this
//     group into an ALLOWED_WORKDIRS bypass.
//   - The checkout already exists by the time the model sees its path. The
//     Phase 0 spike found sub-agents cannot reliably create directories outside
//     their allowed roots, so `worktree_create` pre-creating the tree (via
//     `git worktree add`) is what makes the whole pattern work.

import { z } from 'zod';
import { err, ok, type PortalTool } from './types';
import { project, withOmitted, FieldsArg, FIELDS_PARAM, FIELDS_NOTE } from './project';
import {
	createLease,
	getLease,
	inspectLease,
	leaseIntegrationStatus,
	listLeases,
	mergeLease,
	removeLease,
	touchLease,
	LeaseQuotaError,
	type Lease
} from '../leases';
import { WorktreeError } from '../worktrees';
import { WorktreeIntegrationError } from '../worktree-integration';
import { mergeInProgressFollowUpHint } from './follow-up-hints';
import * as convs from '../db/repos/conversations';

// Model-relevant lease fields. Ids/timestamps stay recoverable via `fields`.
// `ahead` is in the compact view because it is the orchestrator's cue that a
// worktree has finished work waiting to be merged back, and `unavailable`
// because an absent count must not be mistaken for a zero one.
const LEASE_KEEP = [
	'leaseId',
	'label',
	'path',
	'branch',
	'dirtyCount',
	'ahead',
	'unavailable'
] as const;

const CreateArgs = z
	.object({
		label: z
			.string()
			.trim()
			.min(1)
			.max(33)
			.describe('Short slug identifying the unit of work, e.g. "api" or "auth-refactor".'),
		baseRef: z.string().trim().min(1).max(500).optional()
	})
	.strict();

const ListArgs = z.object({ fields: FieldsArg }).strict();

const StatusArgs = z.object({ leaseId: z.string().trim().min(1).max(64) }).strict();

const RemoveArgs = z
	.object({
		leaseId: z.string().trim().min(1).max(64),
		force: z.boolean().optional()
	})
	.strict();

const MergeArgs = z
	.object({
		leaseId: z.string().trim().min(1).max(64),
		direction: z.enum(['to-source', 'from-source']).optional(),
		allowMergeCommit: z.boolean().optional(),
		onConflict: z.enum(['abort', 'keep']).optional()
	})
	.strict();

/**
 * Shape a lease + its live counts into the model-facing record.
 *
 * `unavailable: true` is set when the checkout could not be inspected. It
 * exists because counts are reported by ABSENCE rather than as zero: a bare row
 * with no `ahead` would otherwise read as "nothing to merge", and an agent
 * would move on having silently abandoned whatever was committed there. Present
 * only when something is wrong, so its mere presence is the signal.
 */
function leaseView(
	lease: Lease,
	dirtyCount: number | null,
	counts?: { ahead: number; behind: number }
) {
	const unavailable = dirtyCount === null || counts === undefined;
	return {
		leaseId: lease.id,
		label: lease.label,
		path: lease.path,
		branch: lease.branch,
		baseSha: lease.baseSha,
		...(dirtyCount === null ? {} : { dirtyCount }),
		...(counts ? { ahead: counts.ahead, behind: counts.behind } : {}),
		...(unavailable ? { unavailable: true } : {}),
		createdAt: lease.createdAt,
		lastUsedAt: lease.lastUsedAt
	};
}

function describeWorktreeError(
	cause: unknown
): { message: string; code?: string; dirtyCount?: number } | null {
	if (cause instanceof LeaseQuotaError) return { message: cause.message, code: cause.code };
	if (cause instanceof WorktreeError) return { message: cause.message, code: cause.code };
	if (cause instanceof WorktreeIntegrationError) {
		return {
			message: cause.message,
			code: cause.code,
			...(cause.detail?.dirtyCount === undefined ? {} : { dirtyCount: cause.detail.dirtyCount })
		};
	}
	return null;
}

/**
 * Rewrite an integration failure into something the orchestrator can act on
 * without another round trip.
 *
 * `worktree_dirty` is the load-bearing one: uncommitted work in a lease is
 * unmergeable, and the whole point of the fan-out is that it gets collected. The
 * message therefore names the count AND the exact call that fixes it — a
 * sub-agent that never committed is the common cause, and `git_commit` with this
 * lease's id is the only sanctioned way to fix it (shell git is not granted).
 */
function mergeErrorMessage(
	described: { message: string; code?: string; dirtyCount?: number },
	leaseId: string,
	kept: boolean
): string {
	if (described.code === 'not_fast_forwardable') {
		return `${described.message}. When collecting several worktrees, retry with allowMergeCommit: true.`;
	}
	if (described.code === 'merge_conflict' && kept) {
		// Only a KEPT from-source conflict leaves state behind; every other
		// conflict has already been rolled back, and telling the agent to resolve
		// a tree that is no longer mid-merge would send it chasing nothing. The
		// calls that finish or discard the kept merge each need this lease's id,
		// so name them with it.
		return `${described.message}. ${mergeInProgressFollowUpHint(leaseId)}`;
	}
	if (described.code === 'worktree_dirty') {
		const count = described.dirtyCount;
		return (
			`worktree ${leaseId} has ${count === undefined ? '' : `${count} `}uncommitted file(s); ` +
			`commit them before merging with git_commit { worktree: "${leaseId}", paths: "all", subject: "<message>" }, or discard them. ` +
			'Merging now would silently leave that work behind.'
		);
	}
	return described.message;
}

export function buildWorktreeTools(ctx: { userId: string; conversationId: string }): PortalTool[] {
	// Re-read the conversation per call rather than capturing it: a lease may be
	// created many turns after the session was established.
	const conversation = () => convs.get(ctx.conversationId, ctx.userId);

	return [
		{
			name: 'worktree_create',
			description:
				"Create an isolated Git worktree (a separate checkout of this conversation's repository on its own branch) for parallel work. Use this when delegating work to sub-agents so they do not edit the same files at once: create one worktree per unit of work and give each sub-agent its own. The returned `path` is an absolute directory that ALREADY EXISTS and is writable — the sub-agent should work there directly and must not try to create it. Changes made in a worktree do not affect the main working tree until you merge its branch. The repository is always this conversation's own; it cannot be chosen.",
			argsSchema: CreateArgs,
			parameters: {
				type: 'object',
				properties: {
					label: {
						type: 'string',
						description:
							'Short slug naming the unit of work (lowercase letters, digits, dashes; e.g. "api" or "auth-refactor"). Used in the branch name.'
					},
					baseRef: {
						type: 'string',
						description: 'Optional commit/branch/tag to branch from. Defaults to the current HEAD.'
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
		},
		{
			name: 'worktree_list',
			description: `List the worktrees this conversation currently holds. \`dirtyCount\` is uncommitted files; \`ahead\` is committed work waiting to be merged back into this conversation with worktree_merge. ${FIELDS_NOTE}`,
			argsSchema: ListArgs,
			parameters: {
				type: 'object',
				properties: { fields: FIELDS_PARAM },
				additionalProperties: false
			},
			async handler(args) {
				const parsed = ListArgs.parse(args);
				const conv = conversation();
				// Without the conversation there is no counterpart to measure against,
				// so every row would report unknown counts. Fail loudly instead —
				// matching worktree_create — rather than returning a listing whose
				// numbers are all missing for a reason the model cannot see.
				if (!conv) return err('conversation not found', { code: 'conversation_not_found' });
				const leases = listLeases(ctx.conversationId, ctx.userId);
				const views = [];
				for (const lease of leases) {
					// A checkout that has gone missing should not fail the whole listing —
					// report it as unavailable so the agent can still act on the rest.
					let dirtyCount: number | null;
					let counts: { ahead: number; behind: number } | undefined;
					try {
						({ dirtyCount } = await inspectLease(lease));
						const status = await leaseIntegrationStatus(lease, conv);
						counts = { ahead: status.ahead, behind: status.behind };
					} catch {
						dirtyCount = null;
						counts = undefined;
					}
					views.push(leaseView(lease, dirtyCount, counts));
				}
				const projected = project(views, {
					keep: [...LEASE_KEEP],
					...(parsed.fields ? { fields: parsed.fields } : {})
				});
				return ok(
					withOmitted({ worktrees: projected.value }, projected.omitted),
					`${views.length} worktree(s)`
				);
			}
		},
		{
			name: 'worktree_status',
			description:
				'Report one worktree: its path, branch, and how many files have uncommitted changes.',
			argsSchema: StatusArgs,
			parameters: {
				type: 'object',
				properties: {
					leaseId: { type: 'string', description: 'The worktree id returned by worktree_create.' }
				},
				required: ['leaseId'],
				additionalProperties: false
			},
			async handler(args) {
				const { leaseId } = StatusArgs.parse(args);
				const conv = conversation();
				if (!conv) return err('conversation not found', { code: 'conversation_not_found' });
				const lease = getLease(leaseId, ctx.userId);
				if (!lease || lease.heldByConversationId !== ctx.conversationId) {
					return err(`no worktree with id ${leaseId} in this conversation`, {
						code: 'lease_not_found'
					});
				}
				touchLease(lease.id);
				try {
					const { dirtyCount } = await inspectLease(lease);
					const status = await leaseIntegrationStatus(lease, conv);
					return ok(leaseView(lease, dirtyCount, { ahead: status.ahead, behind: status.behind }));
				} catch (cause) {
					const described = describeWorktreeError(cause);
					if (described) {
						return err(described.message, described.code ? { code: described.code } : undefined);
					}
					throw cause;
				}
			}
		},
		{
			name: 'worktree_merge',
			description:
				'Bring a worktree\'s commits back into this conversation\'s own workspace — the step that makes parallel work useful. Use direction "to-source" (the default) once a sub-agent has finished and COMMITTED its work: its branch is merged into this conversation\'s branch so results from several worktrees gather in one place to be reviewed and tested together. Use "from-source" to refresh a worktree with newer commits from this conversation before continuing in it. Refuses while either side has uncommitted changes. Merging into this conversation always rolls back on conflict; a "from-source" conflict can optionally be left in the worktree, where a sub-agent resolves the files and concludes the merge with git_commit (paths: "all") or discards it with git_merge_abort.',
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
					leaseId: { type: 'string', description: 'The worktree id returned by worktree_create.' },
					direction: {
						type: 'string',
						enum: ['to-source', 'from-source'],
						description:
							'"to-source" (default) merges the worktree into this conversation; "from-source" merges this conversation into the worktree.'
					},
					allowMergeCommit: {
						type: 'boolean',
						description:
							'direction="to-source" only. Defaults to false, requiring a fast-forward. Set true to allow a merge commit when this conversation has moved on — usually needed when collecting the second and later worktrees.'
					},
					onConflict: {
						type: 'string',
						enum: ['abort', 'keep'],
						description:
							'direction="from-source" only. "abort" (default) rolls a conflicted merge back; "keep" leaves the conflict in the worktree, which a sub-agent finishes by editing each conflicted file and calling git_commit { worktree: "<leaseId>", paths: "all" }, or discards with git_merge_abort { worktree: "<leaseId>" }.'
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
				if (!lease || lease.heldByConversationId !== ctx.conversationId) {
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
						...(parsed.onConflict ? { onConflict: parsed.onConflict } : {})
					});
					if (!result.merged) {
						return ok(result, `Already up to date: nothing to merge into ${result.into}`);
					}
					return ok(
						result,
						`Merged ${result.from} into ${result.into}${result.fastForward ? ' (fast-forward)' : ''}`,
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
		},
		{
			name: 'worktree_remove',
			description:
				'Remove a worktree created by worktree_create. Refuses if it has uncommitted changes unless `force` is true (which DISCARDS those changes permanently). Committed work is never lost: if the branch still holds unmerged commits it is kept, and its name is returned so it can be merged later.',
			argsSchema: RemoveArgs,
			// Always prompts. PortalTool exposes a static behavior rather than an
			// arg-dependent one, so the only way to guarantee `force: true` (which
			// destroys uncommitted work) is confirmed is to confirm every removal.
			permissionBehavior: 'always-prompt',
			parameters: {
				type: 'object',
				properties: {
					leaseId: { type: 'string', description: 'The worktree id returned by worktree_create.' },
					force: {
						type: 'boolean',
						description:
							'Discard uncommitted changes and remove anyway. Destructive; defaults to false.'
					}
				},
				required: ['leaseId'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = RemoveArgs.parse(args);
				const lease = getLease(parsed.leaseId, ctx.userId);
				if (!lease || lease.heldByConversationId !== ctx.conversationId) {
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
		}
	];
}
