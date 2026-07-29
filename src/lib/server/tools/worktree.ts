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
	listLeases,
	removeLease,
	touchLease,
	LeaseQuotaError,
	type Lease
} from '../leases';
import { WorktreeError } from '../worktrees';
import * as convs from '../db/repos/conversations';

// Model-relevant lease fields. Ids/timestamps stay recoverable via `fields`.
const LEASE_KEEP = ['leaseId', 'label', 'path', 'branch', 'dirtyCount'] as const;

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

/** Shape a lease + its dirty count into the model-facing record. */
function leaseView(lease: Lease, dirtyCount: number | null) {
	return {
		leaseId: lease.id,
		label: lease.label,
		path: lease.path,
		branch: lease.branch,
		baseSha: lease.baseSha,
		...(dirtyCount === null ? {} : { dirtyCount }),
		createdAt: lease.createdAt,
		lastUsedAt: lease.lastUsedAt
	};
}

function describeWorktreeError(cause: unknown): { message: string; code?: string } | null {
	if (cause instanceof LeaseQuotaError) return { message: cause.message, code: cause.code };
	if (cause instanceof WorktreeError) return { message: cause.message, code: cause.code };
	return null;
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
							`The directory ${lease.path} already exists and is writable. Hand that ABSOLUTE path to one sub-agent and tell it to do all of its work there and nowhere else. ` +
							'Do not point two sub-agents at the same worktree. When the work is done, report the branch name, then call worktree_remove.'
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
			description: `List the worktrees this conversation currently holds, with the number of uncommitted changes in each. ${FIELDS_NOTE}`,
			argsSchema: ListArgs,
			parameters: {
				type: 'object',
				properties: { fields: FIELDS_PARAM },
				additionalProperties: false
			},
			async handler(args) {
				const parsed = ListArgs.parse(args);
				const leases = listLeases(ctx.conversationId, ctx.userId);
				const views = [];
				for (const lease of leases) {
					// A checkout that has gone missing should not fail the whole listing —
					// report it with an unknown dirty count so the agent can still act.
					let dirtyCount: number | null;
					try {
						({ dirtyCount } = await inspectLease(lease));
					} catch {
						dirtyCount = null;
					}
					views.push(leaseView(lease, dirtyCount));
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
				const lease = getLease(leaseId, ctx.userId);
				if (!lease || lease.heldByConversationId !== ctx.conversationId) {
					return err(`no worktree with id ${leaseId} in this conversation`, {
						code: 'lease_not_found'
					});
				}
				touchLease(lease.id);
				try {
					const { dirtyCount } = await inspectLease(lease);
					return ok(leaseView(lease, dirtyCount));
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
								? `${described.message}. Commit the work first, or pass force: true to discard it.`
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
