import { z } from 'zod';
import {
	aggregateStatus,
	commitChanges,
	diff,
	diffStat,
	headInfo,
	isGitRepo,
	log,
	nameOnly,
	nameStatus,
	numstat,
	showCommit,
	showFile,
	status,
	type DiffTarget
} from '../git';
import { COMMIT_TICKET_FOLLOW_UP_HINT, WORKTREE_INTEGRATE_FOLLOW_UP_HINT } from './follow-up-hints';
import {
	mergeWorktree,
	worktreeIntegrationStatus,
	WorktreeIntegrationError
} from '../worktree-integration';
import { ok, err, type PortalTool } from './types';

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

const GitStatusArgs = z
	.object({
		includeIgnored: z.boolean().optional().default(false)
	})
	.strict()
	.optional()
	.default({});

const GitDiffArgs = z
	.object({
		target: TargetKind.optional().default('worktree-vs-head'),
		sha: z.string().min(4).max(64).optional(),
		path: z.string().min(1).max(4096).optional(),
		output: DiffOutput.optional().default('patch')
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
		path: z.string().min(1).max(4096).optional()
	})
	.strict()
	.optional()
	.default({});

const GitShowCommitArgs = z
	.object({
		sha: z.string().min(4).max(64),
		includePatch: z.boolean().optional().default(false)
	})
	.strict();

const GitShowFileArgs = z
	.object({
		ref: z.string().min(1).max(200),
		path: z.string().min(1).max(4096)
	})
	.strict();

const TrailerToken = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid trailer token');

const GitCommitArgs = z
	.object({
		paths: z.union([z.literal('all'), z.array(z.string().min(1).max(4096)).min(1)]),
		subject: z
			.string()
			.min(1)
			.max(200)
			.refine((s) => !hasControlCharacter(s), {
				message: 'subject must be a single line without control characters'
			}),
		body: z.string().max(100_000).optional(),
		trailers: z
			.array(
				z
					.object({
						token: TrailerToken,
						value: z
							.string()
							.max(1000)
							.refine((s) => !hasControlCharacter(s), {
								message: 'trailer value must be a single line without control characters'
							})
					})
					.strict()
			)
			.max(50)
			.optional()
	})
	.strict();

const NoArgs = z.object({}).strict().optional().default({});

const GitWorktreeMergeArgs = z
	.object({
		direction: z.enum(['from-source', 'to-source']),
		allowMergeCommit: z.boolean().optional().default(false),
		onConflict: z.enum(['abort', 'keep']).optional().default('abort')
	})
	.strict();

export function buildGitTools(cwd: string): PortalTool[] {
	return [
		{
			name: 'git_status',
			description:
				'Structured replacement for `git status`. Reports repository head and changed files without allowing arbitrary git shell flags or mutating subcommands.',
			argsSchema: GitStatusArgs,
			parameters: {
				type: 'object',
				properties: {
					includeIgnored: {
						type: 'boolean',
						description: 'Include ignored files in the changed-file list. Defaults to false.'
					}
				},
				additionalProperties: false
			},
			async handler(args) {
				const { includeIgnored } = GitStatusArgs.parse(args);
				if (!(await isGitRepo(cwd))) {
					return ok({ initialized: false, changes: [] });
				}
				const [head, entries] = await Promise.all([headInfo(cwd), status(cwd, { includeIgnored })]);
				return ok({
					initialized: true,
					head,
					changes: entries.map((e) => ({
						...e,
						status: aggregateStatus(e, { includeIgnored })
					}))
				});
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
					}
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitDiffArgs.parse(args);
				const target = toDiffTarget(parsed.target, parsed.sha);
				switch (parsed.output) {
					case 'patch': {
						const out = await diff(cwd, target, parsed.path);
						return ok(out || '(no diff)');
					}
					case 'stat':
						return ok(await diffStat(cwd, target, parsed.path));
					case 'numstat':
						return ok({ files: await numstat(cwd, target, parsed.path) });
					case 'name-only':
						return ok({ files: await nameOnly(cwd, target, parsed.path) });
					case 'name-status':
						return ok({ files: await nameStatus(cwd, target, parsed.path) });
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
					}
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitLogArgs.parse(args);
				const entries = await log(cwd, parsed);
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
					}
				},
				required: ['sha'],
				additionalProperties: false
			},
			async handler(args) {
				const { sha, includePatch } = GitShowCommitArgs.parse(args);
				const commit = await showCommit(cwd, sha, { includePatch });
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
					}
				},
				required: ['ref', 'path'],
				additionalProperties: false
			},
			async handler(args) {
				const { ref, path } = GitShowFileArgs.parse(args);
				return ok(await showFile(cwd, ref, path));
			}
		},
		{
			name: 'git_commit',
			description:
				'Structured replacement for `git add` plus `git commit`. Creates a normal commit from a deterministic structured message and either all current changes or explicitly named whole-file workspace paths.',
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
							'Use "all" to commit all current workspace changes, or a non-empty array of workspace-relative file paths.'
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
					}
				},
				required: ['paths', 'subject'],
				additionalProperties: false
			},
			async handler(args, ctx) {
				const parsed = GitCommitArgs.parse(args);
				const result = await commitChanges(cwd, parsed, ctx);
				// Only worktree sessions get the integrate nudge; in the main checkout
				// a commit is already where the user can see it.
				const linked = await isLinkedWorktree(cwd);
				return ok(result, undefined, {
					followUpHint: linked
						? `${COMMIT_TICKET_FOLLOW_UP_HINT}\n\n${WORKTREE_INTEGRATE_FOLLOW_UP_HINT}`
						: COMMIT_TICKET_FOLLOW_UP_HINT
				});
			}
		},
		{
			name: 'git_worktree_status',
			description:
				'Report how this workspace relates to the branch checked out in the repository’s main checkout: whether it is a linked worktree, its branch, how many commits it is ahead/behind, and whether it holds unmerged work. Read-only.',
			argsSchema: NoArgs,
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			async handler() {
				try {
					return ok(await worktreeIntegrationStatus(cwd));
				} catch (cause) {
					return toolErrorFor(cause);
				}
			}
		},
		{
			name: 'git_worktree_merge',
			description:
				'Merge between this linked worktree’s branch and the branch checked out in the repository’s main checkout. Use direction "to-source" to integrate finished work back (the normal end-of-session step), or "from-source" to first pull in upstream commits and resolve conflicts inside the isolated worktree. Refuses to merge with uncommitted changes on either side, and never leaves the main checkout mid-merge.',
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
							'direction="to-source" only. Defaults to false, which requires a fast-forward so the main checkout stays linear and can never be left mid-merge. Set true to allow a --no-ff merge commit when the source branch has moved on.'
					},
					onConflict: {
						type: 'string',
						enum: ['abort', 'keep'],
						description:
							'direction="from-source" only. "abort" (default) rolls a conflicted merge back; "keep" leaves the conflict in this worktree for you to resolve and commit. "to-source" always rolls back.'
					}
				},
				required: ['direction'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = GitWorktreeMergeArgs.parse(args);
				try {
					const result = await mergeWorktree(cwd, parsed);
					return ok(
						result,
						result.merged
							? `Merged ${result.from} into ${result.into}${result.fastForward ? ' (fast-forward)' : ''}`
							: `Already up to date: nothing to merge into ${result.into}`
					);
				} catch (cause) {
					return toolErrorFor(cause);
				}
			}
		}
	];
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

function hasControlCharacter(value: string): boolean {
	for (const char of value) {
		const code = char.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}
