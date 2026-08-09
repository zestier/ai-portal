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
//
// Every tool here is deliberately SINGULAR — no `leaseIds: string[]`. An
// orchestrator fans out in batches, but batching these earns little: the
// dominant mutation is serialized by the repository lock either way, so the
// saving is turn overhead rather than wall-clock. The strongest thing a batch
// would buy that parallel calls cannot is fewer approval dialogs on
// `worktree_remove` — a symptom of static permission behavior (see the note on
// that tool), and one that should not be paid for by folding N destructive
// approvals into one. A force-less batch limited to clean, fully-merged leases
// is the variant NOT ruled out; it belongs with a future collect tool. Reasoning
// in full: docs/plan-orchestrator-worktrees.md §5, "Why these tools stay
// singular".

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
import { SquashArg, SQUASH_PARAM } from './commit-message-args';
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
		label: z.string().trim().min(1).max(33).describe('Unit-of-work slug.'),
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
		onConflict: z.enum(['abort', 'keep']).optional(),
		squash: SquashArg
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
		return `${described.message}. When collecting several worktrees, either sync this one with direction: "from-source" and retry with squash, or retry with allowMergeCommit: true.`;
	}
	if (described.code === 'squash_behind_source') {
		return `${described.message}: worktree_merge { leaseId: "${leaseId}", direction: "from-source" } first, then retry this call unchanged.`;
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
				"Create an isolated Git worktree of this conversation's repository on its own branch, for parallel sub-agent work. Returns an absolute `path` that already exists and is writable. Changes stay isolated until the branch is merged. One worktree per unit of work; the repo is always this conversation's own.",
			argsSchema: CreateArgs,
			parameters: {
				type: 'object',
				properties: {
					label: {
						type: 'string',
						description:
							'Short slug for the unit of work (lowercase, digits, dashes); used in the branch name.'
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
			description: `List the worktrees this conversation currently holds. \`dirtyCount\` is uncommitted files; \`ahead\` is committed work waiting to be merged back. ${FIELDS_NOTE}`,
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
					leaseId: { type: 'string', description: 'Worktree id from worktree_create.' }
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
				'Merge a worktree back into this conversation. "to-source" (default) merges its branch in after a sub-agent has COMMITTED work; pass `squash` with a subject to collapse commits into one. "from-source" refreshes the worktree with newer commits from this conversation. Refuses with uncommitted changes on either side. "to-source" always rolls back on conflict; a "from-source" conflict can be left ("keep") for a sub-agent to finish with git_commit { paths: "all" } or discard with git_merge_abort.',
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
					leaseId: { type: 'string', description: 'Worktree id from worktree_create.' },
					direction: {
						type: 'string',
						enum: ['to-source', 'from-source'],
						description:
							'"to-source" (default) worktree into this conversation; "from-source" this conversation into the worktree.'
					},
					allowMergeCommit: {
						type: 'boolean',
						description:
							'direction="to-source" only. Default false (fast-forward). Set true to allow a merge commit when collecting multiple worktrees; prefer `squash` for linear history.'
					},
					squash: SQUASH_PARAM,
					onConflict: {
						type: 'string',
						enum: ['abort', 'keep'],
						description:
							'direction="from-source" only. "abort" (default) rolls back; "keep" leaves the conflict for a sub-agent to finish with git_commit { paths: "all" } or discard with git_merge_abort.'
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
		},
		{
			name: 'worktree_remove',
			description:
				'Remove a worktree created by worktree_create. Refuses with uncommitted changes unless `force: true` (permanently discards them). Committed unmerged work is never lost: the branch is kept and its name returned.',
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
					leaseId: { type: 'string', description: 'Worktree id from worktree_create.' },
					force: {
						type: 'boolean',
						description:
							'Discard uncommitted changes and remove anyway. Destructive. Default false.'
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
