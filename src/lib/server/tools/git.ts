import { z } from 'zod';
import {
	abortMerge,
	aggregateStatus,
	commitChanges,
	diff,
	diffStat,
	headInfo,
	isGitRepo,
	log,
	mergeState,
	nameOnly,
	nameStatus,
	numstat,
	repositoryLockKey,
	showCommit,
	showFile,
	status,
	type DiffTarget,
	type MergeState
} from '../git';
import {
	COMMIT_TICKET_FOLLOW_UP_HINT,
	leaseIntegrateFollowUpHint,
	mergeInProgressFollowUpHint,
	sequencerFollowUpHint,
	unmergedPathsFollowUpHint,
	WORKTREE_INTEGRATE_FOLLOW_UP_HINT
} from './follow-up-hints';
import {
	listWorktrees,
	mergeWorktree,
	worktreeIntegrationStatus,
	WorktreeIntegrationError
} from '../worktree-integration';
import { withRepositoryLock } from '../repo-lock';
import {
	createTreeResolver,
	WorktreeSelector,
	WORKTREE_COMMIT_PARAM,
	WORKTREE_PARAM,
	type TreeSelection,
	type WorktreeToolContext
} from './worktree-selector';
import { ok, err, type PortalTool } from './types';
import {
	CommitBody,
	CommitSubject,
	CommitTrailers,
	SquashArg,
	SQUASH_PARAM
} from './commit-message-args';

// Re-exported so existing importers of these symbols from `./git` keep
// compiling now that the canonical definitions live in `./types`.
export { ok, err } from './types';
export type { PortalTool, ToolStreamContext, ToolResult, ToolError } from './types';

const TargetKind = z.enum([
	'worktree-vs-head',
	'worktree-vs-index',
	'index-vs-head',
	'commit',
	'commit-vs-parent'
]);
const DiffOutput = z.enum(['patch', 'stat', 'numstat', 'name-only', 'name-status']);

/**
 * Optional lease selector accepted by every git tool. Shared with the
 * filesystem tools — see `./worktree-selector` for why the resolution rules
 * live in one place.
 */

const GitStatusArgs = z
	.object({
		includeIgnored: z.boolean().optional().default(false),
		worktree: WorktreeSelector
	})
	.strict()
	.optional()
	.default({});

const GitDiffArgs = z
	.object({
		target: TargetKind.optional().default('worktree-vs-head'),
		sha: z.string().min(4).max(64).optional(),
		path: z.string().min(1).max(4096).optional(),
		output: DiffOutput.optional().default('patch'),
		worktree: WorktreeSelector
	})
	.strict()
	.refine((args) => !requiresSha(args.target) || args.sha !== undefined, {
		path: ['sha'],
		message: 'sha is required when target is commit or commit-vs-parent'
	})
	.optional()
	.default({});

const GitLogArgs = z
	.object({
		limit: z.number().int().min(1).max(50).optional().default(20),
		skip: z.number().int().min(0).max(1000).optional().default(0),
		ref: z.string().min(1).max(200).optional(),
		path: z.string().min(1).max(4096).optional(),
		worktree: WorktreeSelector
	})
	.strict()
	.optional()
	.default({});

const GitShowCommitArgs = z
	.object({
		sha: z.string().min(4).max(64),
		includePatch: z.boolean().optional().default(false),
		worktree: WorktreeSelector
	})
	.strict();

const GitShowFileArgs = z
	.object({
		ref: z.string().min(1).max(200),
		path: z.string().min(1).max(4096),
		worktree: WorktreeSelector
	})
	.strict();

const GitCommitArgs = z
	.object({
		paths: z.union([z.literal('all'), z.array(z.string().min(1).max(4096)).min(1)]),
		subject: CommitSubject,
		body: CommitBody,
		trailers: CommitTrailers,
		worktree: WorktreeSelector,
		allowConflictMarkers: z.boolean().optional()
	})
	.strict();

const GitMergeAbortArgs = z
	.object({
		worktree: WorktreeSelector
	})
	.strict()
	.optional()
	.default({});

const GitWorktreeStatusArgs = z
	.object({
		worktree: WorktreeSelector
	})
	.strict()
	.optional()
	.default({});

const GitWorktreeListArgs = z
	.object({
		includeDirty: z.boolean().optional().default(false),
		worktree: WorktreeSelector
	})
	.strict()
	.optional()
	.default({});

const GitWorktreeMergeArgs = z
	.object({
		direction: z.enum(['from-source', 'to-source']),
		allowMergeCommit: z.boolean().optional().default(false),
		onConflict: z.enum(['abort', 'keep']).optional().default('abort'),
		squash: SquashArg
	})
	.strict();

/**
 * Session context needed to resolve the optional `worktree` selector. Optional
 * so callers that only have a directory (tests, one-off tooling) keep working —
 * without it the selector is rejected rather than silently ignored.
 */
export type GitToolContext = WorktreeToolContext;

export function buildGitTools(cwd: string, ctx?: GitToolContext): PortalTool[] {
	// Resolves a `worktree` selector to the directory to run in — no selector
	// means this conversation's own workspace. See `./worktree-selector` for the
	// held-by-this-conversation rule that keeps the selector from becoming a way
	// to reach an arbitrary path.
	const treeFor: (leaseId: string | undefined) => TreeSelection = createTreeResolver(cwd, ctx);

	return [
		{
			name: 'git_status',
			description:
				'Structured replacement for `git status`. Reports repository head, changed files, and any in-progress merge (with its still-conflicted paths) without allowing arbitrary git shell flags or mutating subcommands.',
			argsSchema: GitStatusArgs,
			parameters: {
				type: 'object',
				properties: {
					includeIgnored: {
						type: 'boolean',
						description: 'Include ignored files in the changed-file list. Defaults to false.'
					},
					worktree: WORKTREE_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitStatusArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const includeIgnored = parsed.includeIgnored;
				if (!(await isGitRepo(tree.cwd))) {
					return ok({ initialized: false, changes: [] });
				}
				const [head, entries, merge] = await Promise.all([
					headInfo(tree.cwd),
					status(tree.cwd, { includeIgnored }),
					mergeState(tree.cwd)
				]);
				return ok(
					{
						initialized: true,
						head,
						merge,
						changes: entries.map((e) => ({
							...e,
							status: aggregateStatus(e, { includeIgnored })
						}))
					},
					undefined,
					mergeStatusFollowUpHint(merge, parsed.worktree)
				);
			}
		},
		{
			name: 'git_diff',
			description:
				'Structured replacement for `git diff`. Returns a unified diff or structured read-only summary for worktree/index/commit comparisons, optionally limited to a workspace path.',
			argsSchema: GitDiffArgs,
			parameters: {
				type: 'object',
				properties: {
					target: {
						type: 'string',
						enum: TargetKind.options,
						description: 'Diff target. Defaults to worktree-vs-head. Commit targets require sha.'
					},
					sha: {
						type: 'string',
						description: 'Commit SHA for target=commit or target=commit-vs-parent.'
					},
					path: {
						type: 'string',
						description: 'Optional workspace-relative path to limit the diff.'
					},
					output: {
						type: 'string',
						enum: DiffOutput.options,
						description:
							'Output format. Defaults to patch. stat, numstat, name-only, and name-status return JSON.'
					},
					worktree: WORKTREE_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitDiffArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				const target = toDiffTarget(parsed.target, parsed.sha);
				switch (parsed.output) {
					case 'patch': {
						const out = await diff(tree.cwd, target, parsed.path);
						return ok(out || '(no diff)');
					}
					case 'stat':
						return ok(await diffStat(tree.cwd, target, parsed.path));
					case 'numstat':
						return ok({ files: await numstat(tree.cwd, target, parsed.path) });
					case 'name-only':
						return ok({ files: await nameOnly(tree.cwd, target, parsed.path) });
					case 'name-status':
						return ok({ files: await nameStatus(tree.cwd, target, parsed.path) });
				}
			}
		},
		{
			name: 'git_log',
			description:
				'Structured replacement for `git log`. Returns recent commits with author, timestamp, and subject, optionally filtered by ref or workspace path.',
			argsSchema: GitLogArgs,
			parameters: {
				type: 'object',
				properties: {
					limit: {
						type: 'number',
						description: 'Maximum commits to return, 1-50. Defaults to 20.'
					},
					skip: {
						type: 'number',
						description: 'Number of commits to skip. Defaults to 0.'
					},
					ref: {
						type: 'string',
						description: 'Optional ref to log, such as HEAD or a branch name.'
					},
					path: {
						type: 'string',
						description: 'Optional workspace-relative path to filter commit history.'
					},
					worktree: WORKTREE_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const { worktree, ...parsed } = GitLogArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				const entries = await log(tree.cwd, parsed);
				return ok({ commits: entries });
			}
		},
		{
			name: 'git_show_commit',
			description:
				'Structured replacement for `git show <sha>` metadata. Returns commit details and changed files, optionally including the patch, without executing arbitrary git shell arguments.',
			argsSchema: GitShowCommitArgs,
			parameters: {
				type: 'object',
				properties: {
					sha: {
						type: 'string',
						description: 'Commit SHA to inspect.'
					},
					includePatch: {
						type: 'boolean',
						description:
							'When true, include the commit patch. Defaults to false to keep output smaller.'
					},
					worktree: WORKTREE_PARAM
				},
				required: ['sha'],
				additionalProperties: false
			},
			async handler(args) {
				const { sha, includePatch, worktree } = GitShowCommitArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				const commit = await showCommit(tree.cwd, sha, { includePatch });
				return ok(commit);
			}
		},
		{
			name: 'git_show_file',
			description:
				'Structured replacement for `git show <ref>:<path>`. Reads one workspace file at a Git ref.',
			argsSchema: GitShowFileArgs,
			parameters: {
				type: 'object',
				properties: {
					ref: {
						type: 'string',
						description: 'Git ref, branch, tag, or commit SHA.'
					},
					path: {
						type: 'string',
						description: 'Workspace-relative file path.'
					},
					worktree: WORKTREE_PARAM
				},
				required: ['ref', 'path'],
				additionalProperties: false
			},
			async handler(args) {
				const { ref, path, worktree } = GitShowFileArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				return ok(await showFile(tree.cwd, ref, path));
			}
		},
		{
			name: 'git_commit',
			description:
				'Structured replacement for `git add` plus `git commit`. Creates a normal commit from a deterministic structured message and either all current changes or explicitly named whole-file workspace paths. Pass `worktree` to commit inside a worktree this conversation holds — the only sanctioned way for a sub-agent working in a lease to land its work so it can be merged back. This is also how an in-progress merge is concluded: once every conflicted file is edited to remove its conflict markers, `paths: "all"` stages exactly those resolutions (unrelated edits stay uncommitted) and creates the merge commit — a merge commit cannot be partial, so naming paths is rejected mid-merge.',
			argsSchema: GitCommitArgs,
			permissionBehavior: 'always-prompt',
			parameters: {
				type: 'object',
				properties: {
					paths: {
						oneOf: [
							{ type: 'string', enum: ['all'] },
							{
								type: 'array',
								items: { type: 'string' },
								minItems: 1,
								description:
									'Workspace-relative file paths to commit. Untracked files are included only when named explicitly.'
							}
						],
						description:
							'Use "all" to commit all current workspace changes, or a non-empty array of workspace-relative file paths. While concluding a merge or other conflicted state, "all" narrows to the conflicted files\' resolutions — unrelated unstaged edits are left dirty rather than swept into the merge commit.'
					},
					subject: {
						type: 'string',
						description: 'Required single-line commit subject.'
					},
					body: {
						type: 'string',
						description: 'Optional commit message body.'
					},
					trailers: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								token: { type: 'string' },
								value: { type: 'string' }
							},
							required: ['token', 'value'],
							additionalProperties: false
						},
						description: 'Optional structured commit trailers.'
					},
					worktree: WORKTREE_COMMIT_PARAM,
					allowConflictMarkers: {
						type: 'boolean',
						description:
							'Allow a previously-conflicted file to be committed while it still contains <<<<<<< / ======= / >>>>>>> lines. Defaults to false, because that almost always means the file was never actually resolved. Set true only when such lines are genuinely part of the file.'
					}
				},
				required: ['paths', 'subject'],
				additionalProperties: false
			},
			async handler(args, ctx) {
				const { worktree, ...parsed } = GitCommitArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				// Serialize against the other repository mutators (worktree add /
				// remove, either merge direction) on the SAME lock they take. Without
				// it a merge's dirty/ahead guards — a check-then-act re-read inside
				// that lock — could be invalidated by a commit landing mid-merge, and
				// this tool is now precisely the thing parallel sub-agents call.
				const result = await withRepositoryLock(await repositoryLockKey(tree.cwd), () =>
					commitChanges(tree.cwd, parsed, ctx)
				);
				// Only worktree sessions get the integrate nudge; in the main checkout
				// a commit is already where the user can see it. A commit made INTO a
				// lease is nudged toward `worktree_merge` with that lease's id, since
				// that (not `git_worktree_merge`, which acts on the session's own cwd)
				// is what collects it.
				//
				// Both can apply at once: when the conversation's OWN workspace is a
				// linked worktree, collecting a lease only gets the work as far as
				// that worktree's branch, so the second leg is named too.
				const hints = [COMMIT_TICKET_FOLLOW_UP_HINT];
				if (worktree) hints.push(leaseIntegrateFollowUpHint(worktree));
				if (await isLinkedWorktree(cwd)) hints.push(WORKTREE_INTEGRATE_FOLLOW_UP_HINT);
				return ok(result, undefined, { followUpHint: hints.join('\n\n') });
			}
		},
		{
			name: 'git_merge_abort',
			description:
				'Structured replacement for `git merge --abort`. Rolls an in-progress merge back to the pre-merge HEAD, discarding the merge and any resolution work in the tree. Use it to escape a conflict left behind by a merge with onConflict: "keep" when you decide not to resolve it; to FINISH such a merge instead, resolve the conflicted files and call git_commit with paths: "all".',
			argsSchema: GitMergeAbortArgs,
			// Destructive: it throws away whatever resolution the tree holds, so it
			// is confirmed for the same reason `git_commit` is.
			permissionBehavior: 'always-prompt',
			parameters: {
				type: 'object',
				properties: { worktree: WORKTREE_PARAM },
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitMergeAbortArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				// Same lock as `git_commit` and the worktree merges: aborting rewrites
				// the index and working tree of a repository another session may be
				// mid-operation on.
				const cwdForAbort = tree.cwd;
				const outcome = await withRepositoryLock(await repositoryLockKey(cwdForAbort), async () =>
					(await mergeState(cwdForAbort)).inProgress
						? { aborted: true as const, result: await abortMerge(cwdForAbort) }
						: { aborted: false as const }
				);
				if (!outcome.aborted) {
					return err('no merge is in progress in this tree', { code: 'no_merge_in_progress' });
				}
				return ok(
					outcome.result,
					`Aborted the in-progress merge; tree is back at ${outcome.result.headSha}`
				);
			}
		},
		{
			name: 'git_worktree_status',
			description:
				'Report how this workspace relates to the branch checked out in the repository’s main checkout: whether it is a linked worktree, its branch, how many commits it is ahead/behind, and whether it holds unmerged work. Read-only.',
			argsSchema: GitWorktreeStatusArgs,
			parameters: {
				type: 'object',
				properties: { worktree: WORKTREE_PARAM },
				additionalProperties: false
			},
			async handler(args) {
				const { worktree } = GitWorktreeStatusArgs.parse(args);
				const tree = treeFor(worktree);
				if (tree.error) return tree.error;
				try {
					return ok(await worktreeIntegrationStatus(tree.cwd));
				} catch (cause) {
					return toolErrorFor(cause);
				}
			}
		},
		{
			name: 'git_worktree_list',
			description:
				'List every worktree of this repository (the main checkout plus each linked worktree), with the branch and commit checked out in each and whether it is detached, locked, or prunable. Read-only. Unlike `worktree_list`, which shows only portal-managed worktrees held by this conversation, this sees all of them — including ones created outside the portal.',
			argsSchema: GitWorktreeListArgs,
			parameters: {
				type: 'object',
				properties: {
					includeDirty: {
						type: 'boolean',
						description:
							'Also count uncommitted changes in each worktree. Defaults to false because it costs one status read per worktree.'
					},
					worktree: WORKTREE_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitWorktreeListArgs.parse(args);
				const tree = treeFor(parsed.worktree);
				if (tree.error) return tree.error;
				try {
					return ok(await listWorktrees(tree.cwd, { includeDirty: parsed.includeDirty }));
				} catch (cause) {
					return toolErrorFor(cause);
				}
			}
		},
		{
			name: 'git_worktree_merge',
			description:
				'Merge between this linked worktree’s branch and the branch checked out in the repository’s main checkout. Use direction "to-source" to integrate finished work back (the normal end-of-session step), or "from-source" to first pull in upstream commits and resolve conflicts inside the isolated worktree. Prefer passing `squash` on the way back so the main checkout gains one commit per unit of work instead of the worktree’s intermediate history. Refuses to merge with uncommitted changes on either side, and never leaves the main checkout mid-merge.',
			argsSchema: GitWorktreeMergeArgs,
			permissionBehavior: 'always-prompt',
			parameters: {
				type: 'object',
				properties: {
					direction: {
						type: 'string',
						enum: ['from-source', 'to-source'],
						description:
							'"to-source" merges this worktree branch into the main checkout’s branch; "from-source" merges the main checkout’s branch into this worktree.'
					},
					allowMergeCommit: {
						type: 'boolean',
						description:
							'direction="to-source" only. Defaults to false, which requires a fast-forward so the main checkout stays linear and can never be left mid-merge. Set true to allow a --no-ff merge commit when the source branch has moved on. Prefer `squash` (after a from-source sync) when you want linear history instead.'
					},
					squash: SQUASH_PARAM,
					onConflict: {
						type: 'string',
						enum: ['abort', 'keep'],
						description:
							'direction="from-source" only. "abort" (default) rolls a conflicted merge back; "keep" leaves the conflict in this worktree, which you then finish by editing each conflicted file and calling git_commit with paths: "all" (or give up with git_merge_abort). "to-source" always rolls back.'
					}
				},
				required: ['direction'],
				additionalProperties: false
			},
			async handler(args) {
				const { squash, ...parsed } = GitWorktreeMergeArgs.parse(args);
				try {
					const result = await mergeWorktree(cwd, {
						...parsed,
						...(squash === undefined ? {} : { squash })
					});
					return ok(
						result,
						result.merged
							? `Merged ${result.from} into ${result.into}${result.fastForward ? ' (fast-forward)' : ''}${
									result.squashedCommits === undefined
										? ''
										: `, squashed from ${result.squashedCommits} commit(s)`
								}`
							: `Already up to date: nothing to merge into ${result.into}`
					);
				} catch (cause) {
					// A kept conflict is the one failure that leaves state behind, and
					// it is a dead end unless the agent is told how to leave it.
					if (
						cause instanceof WorktreeIntegrationError &&
						cause.code === 'merge_conflict' &&
						parsed.direction === 'from-source' &&
						parsed.onConflict === 'keep'
					) {
						return err(`${cause.message}. ${mergeInProgressFollowUpHint()}`, {
							code: cause.code,
							details: cause.detail
						});
					}
					return toolErrorFor(cause);
				}
			}
		}
	];
}

/**
 * The `git_status` nudge for a tree that cannot simply be committed: mid-merge
 * (finish or abort), mid-sequencer (a rebase/cherry-pick the portal cannot
 * continue), or merely holding unmerged paths (finish only). Absent for an
 * ordinary tree, so its presence is the signal.
 *
 * The sequencer case is checked first: a conflicted rebase also has unmerged
 * paths, and the generic "resolve and commit" advice would imply the commit
 * finishes an operation it does not finish.
 */
function mergeStatusFollowUpHint(
	merge: MergeState,
	leaseId: string | undefined
): { followUpHint: string } | undefined {
	if (merge.sequencer) return { followUpHint: sequencerFollowUpHint(merge.sequencer, leaseId) };
	if (merge.inProgress) return { followUpHint: mergeInProgressFollowUpHint(leaseId) };
	if (merge.conflictedPaths.length > 0) {
		return { followUpHint: unmergedPathsFollowUpHint(leaseId) };
	}
	return undefined;
}

/** Normalize an integration failure into the tool envelope, preserving its code. */
function toolErrorFor(cause: unknown) {
	if (cause instanceof WorktreeIntegrationError) {
		return err(cause.message, { code: cause.code, details: cause.detail });
	}
	throw cause;
}

async function isLinkedWorktree(cwd: string): Promise<boolean> {
	try {
		return (await worktreeIntegrationStatus(cwd)).isLinkedWorktree;
	} catch {
		return false;
	}
}

function toDiffTarget(kind: z.infer<typeof TargetKind>, sha: string | undefined): DiffTarget {
	switch (kind) {
		case 'worktree-vs-head':
		case 'worktree-vs-index':
		case 'index-vs-head':
			return { kind };
		case 'commit':
		case 'commit-vs-parent':
			if (!sha) throw new Error(`sha is required for git_diff target=${kind}`);
			return { kind, sha };
	}
}

function requiresSha(kind: z.infer<typeof TargetKind>): boolean {
	return kind === 'commit' || kind === 'commit-vs-parent';
}
