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

// Optional, opt-in streaming channel handed to a PortalTool handler so it can
// surface incremental feedback while it runs. Both methods reuse the existing
// ephemeral streaming events (`tool.partial_output` / `tool.progress`) and are
// no-ops once the turn is aborted. Handlers that don't need streaming simply
// ignore `ctx` and keep returning `Promise<string>`.
export interface ToolStreamContext {
	// Cumulative stdout/stderr snapshot. The client REPLACES (not appends) on each
	// call, mirroring `tool.partial_output` semantics.
	partial(output: string): void;
	// Short human-readable status line.
	progress(message: string): void;
	// Mirrors the turn's abort signal.
	readonly signal: AbortSignal;
}

export interface PortalTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	argsSchema?: z.ZodTypeAny;
	permissionBehavior?: 'normal' | 'always-prompt' | 'never-prompt';
	handler(args: unknown, ctx?: ToolStreamContext): Promise<string>;
}

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
					return JSON.stringify({ initialized: false, changes: [] }, null, 2);
				}
				const [head, entries] = await Promise.all([headInfo(cwd), status(cwd, { includeIgnored })]);
				return JSON.stringify(
					{
						initialized: true,
						head,
						changes: entries.map((e) => ({
							...e,
							status: aggregateStatus(e, { includeIgnored })
						}))
					},
					null,
					2
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
						return out || '(no diff)';
					}
					case 'stat':
						return JSON.stringify(await diffStat(cwd, target, parsed.path), null, 2);
					case 'numstat':
						return JSON.stringify({ files: await numstat(cwd, target, parsed.path) }, null, 2);
					case 'name-only':
						return JSON.stringify({ files: await nameOnly(cwd, target, parsed.path) }, null, 2);
					case 'name-status':
						return JSON.stringify({ files: await nameStatus(cwd, target, parsed.path) }, null, 2);
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
				return JSON.stringify({ commits: entries }, null, 2);
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
				return JSON.stringify(commit, null, 2);
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
				return await showFile(cwd, ref, path);
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
				return JSON.stringify(await commitChanges(cwd, parsed, ctx), null, 2);
			}
		}
	];
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
