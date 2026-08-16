import { describe, it, expect } from 'vitest';
import { parseGitToolResult } from '../../src/lib/client/git-tool-result';
import { summarizeToolCall, splitSummaryForWrap } from '../../src/lib/tool-summary';
import {
	decodeToolResult,
	shouldRenderToolResultAsMarkdown
} from '../../src/lib/client/tool-result';
import {
	getBackgroundAgentId,
	getSubagentDisplayState,
	getSubagentPresentation
} from '../../src/lib/client/subagent-display';
import type { ToolCallRecord } from '../../src/lib/types';

function toolCall(overrides: Partial<ToolCallRecord>): ToolCallRecord {
	return {
		id: 'X1',
		messageId: 'M1',
		tool: 'task',
		argsJson: '{}',
		resultJson: null,
		status: 'pending',
		startedAt: 1000,
		endedAt: null,
		textOffset: null,
		parentToolCallId: null,
		...overrides
	};
}

describe('summarizeToolCall', () => {
	it('uses description over command for bash', () => {
		expect(
			summarizeToolCall('bash', JSON.stringify({ command: 'echo hi', description: 'Greet' }))
		).toBe('Greet');
	});

	it('falls back to command when no description', () => {
		expect(summarizeToolCall('bash', JSON.stringify({ command: 'ls -la' }))).toBe('ls -la');
	});

	it('falls back to the path for the legacy view tool', () => {
		// `view` is a removed legacy name; old turns render via the generic
		// first-string-arg fallback instead of the old `view_range` suffix.
		expect(
			summarizeToolCall('view', JSON.stringify({ path: 'src/foo.ts', view_range: [1, 30] }))
		).toBe('src/foo.ts');
	});

	it('shows pattern + glob for grep', () => {
		expect(summarizeToolCall('grep', JSON.stringify({ pattern: 'foo', glob: '*.ts' }))).toBe(
			'foo  (*.ts)'
		);
	});

	it('returns null on malformed args', () => {
		expect(summarizeToolCall('bash', 'not json')).toBeNull();
	});

	it('summarizes multi_edit by the unique files its edits touch', () => {
		expect(
			summarizeToolCall(
				'multi_edit',
				JSON.stringify({
					edits: [
						{ file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
						{ file_path: 'src/bar.ts', old_string: 'x', new_string: 'y' },
						{ file_path: 'src/foo.ts', old_string: 'c', new_string: 'd' }
					]
				})
			)
		).toBe('src/foo.ts +1 more');
		// A single touched file collapses to just its path.
		expect(
			summarizeToolCall(
				'multi_edit',
				JSON.stringify({ edits: [{ file_path: 'src/foo.ts', old_string: 'a', new_string: 'b' }] })
			)
		).toBe('src/foo.ts');
	});

	it('falls back to first string arg for unknown tools', () => {
		expect(summarizeToolCall('unknown_tool', JSON.stringify({ x: 'hello' }))).toBe('hello');
	});

	it('summarizes structured git tool options', () => {
		expect(
			summarizeToolCall(
				'git_diff',
				JSON.stringify({ output: 'name-status', target: 'worktree-vs-head', path: 'src/a.ts' })
			)
		).toBe('name-status · worktree-vs-head · src/a.ts');
		expect(summarizeToolCall('git_log', JSON.stringify({ path: 'src/a.ts' }))).toBe('src/a.ts');
		expect(
			summarizeToolCall('git_show_commit', JSON.stringify({ sha: 'abc1234', includePatch: true }))
		).toBe('abc1234 · patch');
		expect(
			summarizeToolCall('git_commit', JSON.stringify({ subject: 'Add feature', paths: 'all' }))
		).toBe('Add feature · all changes');
		expect(
			summarizeToolCall('git_worktree_merge', JSON.stringify({ direction: 'to-source' }))
		).toBe('integrate into source branch');
		expect(
			summarizeToolCall('git_worktree_merge', JSON.stringify({ direction: 'from-source' }))
		).toBe('sync from source branch');
		expect(
			summarizeToolCall(
				'git_worktree_merge',
				JSON.stringify({ direction: 'to-source', allowMergeCommit: true })
			)
		).toBe('integrate into source branch (allow merge commit)');
		expect(
			summarizeToolCall(
				'git_commit',
				JSON.stringify({
					subject: 'Add feature',
					paths: ['src/a.ts', 'src/b.ts'],
					body: 'Details',
					trailers: [{ token: 'Co-authored-by', value: 'Ada Lovelace <ada@example.com>' }]
				})
			)
		).toBe('Add feature · src/a.ts +1 more · body · 1 trailers');
		// A commit into a lease lands in a different checkout; the transcript row
		// is the only place a reader sees that.
		expect(
			summarizeToolCall(
				'git_commit',
				JSON.stringify({ subject: 'Add feature', paths: 'all', worktree: 'lease-1' })
			)
		).toBe('Add feature · all changes · in worktree lease-1');
	});

	it('summarizes portal memory tool options', () => {
		expect(summarizeToolCall('memory_search', JSON.stringify({ query: 'blue candle' }))).toBe(
			'blue candle'
		);
		expect(summarizeToolCall('memory_get_entity', JSON.stringify({ id: 'character.elias' }))).toBe(
			'character.elias'
		);
		expect(
			summarizeToolCall(
				'memory_merge_entities',
				JSON.stringify({ from: 'character.john_smith', into: 'character.john' })
			)
		).toBe('character.john_smith → character.john');
		expect(summarizeToolCall('memory_check_claims', JSON.stringify({ claims: [{}, {}, {}] }))).toBe(
			'3 claim(s)'
		);
	});

	it('summarizes portal ticket and permission tool options', () => {
		expect(summarizeToolCall('ticket_add', JSON.stringify({ title: 'Remember this' }))).toBe(
			'Remember this'
		);
		expect(summarizeToolCall('ticket_update', JSON.stringify({ id: 't1', status: 'done' }))).toBe(
			't1 · done'
		);
		expect(summarizeToolCall('ticket_list', JSON.stringify({ status: 'open' }))).toBe('open');
		expect(
			summarizeToolCall(
				'permission_capabilities',
				JSON.stringify({ permissionKind: 'url', toolName: 'url_fetcher' })
			)
		).toBe('url · url_fetcher');
	});
});

describe('splitSummaryForWrap', () => {
	it('breaks a deep path into chunks that each end at a slash', () => {
		expect(
			splitSummaryForWrap(
				'/workspaces/zap/src/routes/api/conversations/[id]/messages/[messageId]/edit/+server.ts'
			)
		).toEqual([
			'/',
			'workspaces/',
			'zap/',
			'src/',
			'routes/',
			'api/',
			'conversations/',
			'[id]/',
			'messages/',
			'[messageId]/',
			'edit/',
			'+server.ts'
		]);
	});

	it('keeps the separator attached so the break lands after the slash', () => {
		expect(splitSummaryForWrap('a/b/c')).toEqual(['a/', 'b/', 'c']);
	});

	it('also breaks on backslash separators', () => {
		expect(splitSummaryForWrap('a\\b\\c')).toEqual(['a\\', 'b\\', 'c']);
	});

	it('returns a single chunk and drops empties for separator-free or trailing-slash input', () => {
		expect(splitSummaryForWrap('echo hi')).toEqual(['echo hi']);
		expect(splitSummaryForWrap('src/')).toEqual(['src/']);
	});
});

describe('parseGitToolResult', () => {
	it('parses structured git_diff name-status output', () => {
		expect(
			parseGitToolResult(
				'git_diff',
				JSON.stringify({ output: 'name-status' }),
				JSON.stringify({
					files: [{ statusCode: 'M', status: 'modified', path: 'src/a.ts', origPath: null }]
				})
			)
		).toEqual({
			kind: 'diff-name-status',
			files: [{ statusCode: 'M', status: 'modified', path: 'src/a.ts', origPath: null }]
		});
	});

	it('parses git_log and git_show_commit output', () => {
		expect(
			parseGitToolResult(
				'git_log',
				'{}',
				JSON.stringify({
					commits: [
						{
							sha: 'abc123',
							shortSha: 'abc123',
							author: 'A',
							email: 'a@example.com',
							timestamp: 1,
							subject: 'subject'
						}
					]
				})
			)
		).toMatchObject({ kind: 'log', commits: [{ shortSha: 'abc123' }] });
		expect(
			parseGitToolResult(
				'git_show_commit',
				'{}',
				JSON.stringify({
					sha: 'abc123',
					shortSha: 'abc123',
					author: 'A',
					email: 'a@example.com',
					timestamp: 1,
					subject: 'subject',
					body: '',
					parents: [],
					files: []
				})
			)
		).toMatchObject({ kind: 'commit', commit: { shortSha: 'abc123' } });
	});

	it('parses git_commit output', () => {
		expect(
			parseGitToolResult(
				'git_commit',
				'{}',
				JSON.stringify({
					sha: 'abcdef123456',
					shortSha: 'abcdef12',
					subject: 'created',
					body: 'Body line',
					trailers: [{ token: 'Reviewed-by', value: 'Tester <t@example.com>' }],
					files: [{ statusCode: 'M', status: 'modified', path: 'src/a.ts', origPath: null }],
					fileStats: [{ path: 'src/a.ts', origPath: null, added: 1, removed: 0 }],
					diffStat: { filesChanged: 1, added: 1, removed: 0 },
					remainingDirtyFiles: []
				})
			)
		).toMatchObject({
			kind: 'commit-created',
			shortSha: 'abcdef12',
			body: 'Body line',
			trailers: [{ token: 'Reviewed-by', value: 'Tester <t@example.com>' }],
			diffStat: { filesChanged: 1, added: 1, removed: 0 }
		});
	});
	it('parses git_commit output from the envelope result field', () => {
		expect(
			parseGitToolResult(
				'git_commit',
				'{}',
				JSON.stringify({
					ok: true,
					result: {
						sha: 'abcdef123456',
						shortSha: 'abcdef12',
						subject: 'created',
						body: 'Body line',
						trailers: [],
						files: [],
						fileStats: [],
						diffStat: { filesChanged: 1, added: 1, removed: 0 },
						remainingDirtyFiles: []
					}
				})
			)
		).toMatchObject({
			kind: 'commit-created',
			shortSha: 'abcdef12',
			diffStat: { filesChanged: 1, added: 1, removed: 0 }
		});
	});

	it('surfaces a merge commit and the conflicts it resolved', () => {
		expect(
			parseGitToolResult(
				'git_commit',
				'{}',
				JSON.stringify({
					ok: true,
					result: {
						sha: 'abcdef123456',
						shortSha: 'abcdef12',
						subject: 'resolve conflict',
						body: '',
						trailers: [],
						files: [],
						fileStats: [],
						diffStat: { filesChanged: 0, added: 0, removed: 0 },
						remainingDirtyFiles: [],
						mergeCommit: true,
						resolvedConflicts: ['a.txt']
					}
				})
			)
		).toMatchObject({ kind: 'commit-created', mergeCommit: true, resolvedConflicts: ['a.txt'] });
		// An ordinary commit reports the absence rather than omitting the fields,
		// so the card never has to guess.
		expect(
			parseGitToolResult(
				'git_commit',
				'{}',
				JSON.stringify({
					ok: true,
					result: {
						sha: 'abcdef123456',
						shortSha: 'abcdef12',
						subject: 'ordinary',
						body: '',
						trailers: [],
						files: [],
						fileStats: [],
						diffStat: { filesChanged: 1, added: 1, removed: 0 },
						remainingDirtyFiles: []
					}
				})
			)
		).toMatchObject({ mergeCommit: false, resolvedConflicts: [] });
	});

	it('returns null for an errored envelope', () => {
		expect(
			parseGitToolResult(
				'git_commit',
				'{}',
				JSON.stringify({ ok: false, error: { message: 'nothing to commit' } })
			)
		).toBeNull();
	});

	it('carries followUpHint from the envelope onto the commit card', () => {
		expect(
			parseGitToolResult(
				'git_commit',
				'{}',
				JSON.stringify({
					ok: true,
					followUpHint: 'remember the tickets',
					result: {
						sha: 'abcdef123456',
						shortSha: 'abcdef12',
						subject: 'created',
						body: '',
						trailers: [],
						files: [],
						fileStats: [],
						diffStat: { filesChanged: 1, added: 1, removed: 0 },
						remainingDirtyFiles: []
					}
				})
			)
		).toMatchObject({
			kind: 'commit-created',
			shortSha: 'abcdef12',
			followUpHint: 'remember the tickets'
		});
	});
});

describe('decodeToolResult envelope', () => {
	it('decodes a success envelope with an object result as pretty JSON', () => {
		const r = decodeToolResult(JSON.stringify({ ok: true, result: { commits: [] } }));
		expect(r.blocks).toEqual([{ kind: 'text', text: JSON.stringify({ commits: [] }, null, 2) }]);
		expect(r.fallbackText).toBe(JSON.stringify({ commits: [] }, null, 2));
	});

	it('decodes a success envelope with a string result', () => {
		const r = decodeToolResult(JSON.stringify({ ok: true, result: 'plain text' }));
		expect(r.blocks).toEqual([{ kind: 'text', text: 'plain text' }]);
		expect(r.fallbackText).toBe('plain text');
	});

	it('decodes an error envelope to its message', () => {
		const r = decodeToolResult(
			JSON.stringify({ ok: false, error: { message: 'Ticket not found: t1' } })
		);
		expect(r.blocks).toEqual([{ kind: 'text', text: 'Ticket not found: t1' }]);
		expect(r.fallbackText).toBe('Ticket not found: t1');
	});

	it('falls back to summary for a result-less success envelope', () => {
		const r = decodeToolResult(JSON.stringify({ ok: true, summary: 'Added ticket t1' }));
		expect(r.blocks).toEqual([{ kind: 'text', text: 'Added ticket t1' }]);
	});

	it('surfaces followUpHint from a success envelope', () => {
		const r = decodeToolResult(
			JSON.stringify({ ok: true, result: { sha: 'abc' }, followUpHint: 'do the thing' })
		);
		expect(r.followUpHint).toBe('do the thing');
	});

	it('omits followUpHint when absent', () => {
		const r = decodeToolResult(JSON.stringify({ ok: true, result: 'plain' }));
		expect(r.followUpHint).toBeUndefined();
	});
});

describe('decodeToolResult views', () => {
	it('renders a text view for a read envelope instead of the JSON payload', () => {
		const r = decodeToolResult(
			JSON.stringify({
				ok: true,
				result: {
					type: 'text',
					file: { path: 'a.ts', content: 'alpha\nbeta', startLine: 1, numLines: 2, size: 4 }
				},
				views: [{ type: 'text', text: 'alpha\nbeta\n(file has 2 total lines)' }]
			})
		);
		expect(r.blocks).toEqual([{ kind: 'text', text: 'alpha\nbeta\n(file has 2 total lines)' }]);
		expect(JSON.stringify(r.blocks)).not.toContain('content');
		// fallbackText stays the JSON payload.
		expect(r.fallbackText).toContain('"content"');
	});

	it('renders an image view as a zoomable image block', () => {
		const r = decodeToolResult(
			JSON.stringify({
				ok: true,
				result: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
				views: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]
			})
		);
		expect(r.blocks).toEqual([{ kind: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
	});

	it('uses the tool-rendered text over the matches JSON for grep-style results', () => {
		const r = decodeToolResult(
			JSON.stringify({
				ok: true,
				result: { matches: [{ path: 'a.ts', line: 3, text: 'foo' }] },
				views: [{ type: 'text', text: 'a.ts:3:  foo\n' }]
			})
		);
		expect(r.blocks).toEqual([{ kind: 'text', text: 'a.ts:3:  foo\n' }]);
		expect(JSON.stringify(r.blocks)).not.toContain('matches');
		expect(r.fallbackText).toContain('"matches"');
	});

	it('falls back to JSON when a structured result has no views', () => {
		const r = decodeToolResult(JSON.stringify({ ok: true, result: { commits: [] } }));
		expect(r.blocks).toEqual([{ kind: 'text', text: JSON.stringify({ commits: [] }, null, 2) }]);
		expect(r.fallbackText).toBe(JSON.stringify({ commits: [] }, null, 2));
	});

	it('falls back to JSON when only unknown view types are present', () => {
		const r = decodeToolResult(
			JSON.stringify({
				ok: true,
				result: { foo: 1 },
				views: [
					{ type: 'unknown', text: 'x' },
					{ type: 'image', data: 'x' } // missing mimeType
				]
			})
		);
		expect(r.blocks).toEqual([{ kind: 'text', text: JSON.stringify({ foo: 1 }, null, 2) }]);
		expect(r.fallbackText).toBe(JSON.stringify({ foo: 1 }, null, 2));
	});

	it('still shows only the error message for an error envelope even with views', () => {
		const r = decodeToolResult(
			JSON.stringify({
				ok: false,
				error: { message: 'Ticket not found' },
				views: [{ type: 'text', text: 'rendered' }]
			})
		);
		expect(r.blocks).toEqual([{ kind: 'text', text: 'Ticket not found' }]);
	});
});

describe('decodeToolResult', () => {
	it('returns empty for null', () => {
		expect(decodeToolResult(null)).toEqual({ blocks: [], fallbackText: null });
	});

	it('decodes a terminal content block with exitCode and cwd', () => {
		const r = decodeToolResult(
			JSON.stringify({
				content: 'hi',
				contents: [{ type: 'terminal', text: 'hi\n', exitCode: 0, cwd: '/tmp' }]
			})
		);
		expect(r.blocks).toHaveLength(1);
		const b = r.blocks[0];
		expect(b.kind).toBe('terminal');
		if (b.kind === 'terminal') {
			expect(b.text).toBe('hi\n');
			expect(b.exitCode).toBe(0);
			expect(b.cwd).toBe('/tmp');
		}
	});

	it('prefers detailedContent over content as fallback text', () => {
		const r = decodeToolResult(
			JSON.stringify({ content: 'short', detailedContent: 'full output' })
		);
		expect(r.blocks).toEqual([{ kind: 'text', text: 'full output' }]);
		expect(r.fallbackText).toBe('full output');
	});

	it('treats a bare string as a text block', () => {
		const r = decodeToolResult(JSON.stringify('plain output'));
		expect(r.blocks).toEqual([{ kind: 'text', text: 'plain output' }]);
	});

	it('falls back to raw text on malformed JSON', () => {
		const r = decodeToolResult('not valid json');
		expect(r.blocks).toEqual([{ kind: 'text', text: 'not valid json' }]);
	});

	it('decodes resource_link with optional description', () => {
		const r = decodeToolResult(
			JSON.stringify({
				contents: [{ type: 'resource_link', name: 'docs', uri: 'https://e.com', description: 'd' }]
			})
		);
		expect(r.blocks[0]).toMatchObject({
			kind: 'resource_link',
			name: 'docs',
			uri: 'https://e.com',
			description: 'd'
		});
	});

	it('skips malformed content blocks', () => {
		const r = decodeToolResult(
			JSON.stringify({
				contents: [
					{ type: 'text', text: 'ok' },
					{ type: 'image', data: 'x' }, // missing mimeType
					{ type: 'unknown' }
				],
				content: 'fallback'
			})
		);
		expect(r.blocks).toEqual([{ kind: 'text', text: 'ok' }]);
		expect(r.fallbackText).toBe('fallback');
	});
});

describe('decodeToolResult modelText', () => {
	it('derives modelText from a plain-string success envelope', () => {
		const r = decodeToolResult(JSON.stringify({ ok: true, result: 'plain text' }));
		expect(r.modelText).toBe('plain text');
	});

	it('derives modelText from an object-result envelope (readable projection)', () => {
		const r = decodeToolResult(
			JSON.stringify({ ok: true, result: { commits: [{ sha: 'a1', subject: 'first' }] } })
		);
		expect(r.modelText).toContain('commits:');
		expect(r.modelText).toContain('sha: a1');
	});

	it('prefers a tool-provided text view as modelText', () => {
		const r = decodeToolResult(
			JSON.stringify({ ok: true, views: [{ type: 'text', text: 'rendered' }] })
		);
		expect(r.modelText).toBe('rendered');
	});

	it('derives modelText from an error envelope', () => {
		const r = decodeToolResult(JSON.stringify({ ok: false, error: { message: 'boom' } }));
		expect(r.modelText).toBe('boom');
	});

	it('uses the string itself as modelText for a plain-string result', () => {
		const r = decodeToolResult(JSON.stringify('plain output'));
		expect(r.modelText).toBe('plain output');
	});

	it('leaves modelText undefined for non-envelope records', () => {
		const r = decodeToolResult(JSON.stringify({ content: 'x', detailedContent: 'y' }));
		expect(r.modelText).toBeUndefined();
	});

	it('leaves modelText undefined for invalid JSON and null', () => {
		expect(decodeToolResult('not valid json').modelText).toBeUndefined();
		expect(decodeToolResult(null).modelText).toBeUndefined();
	});
});

describe('shouldRenderToolResultAsMarkdown', () => {
	it('uses markdown for human-facing prose tools', () => {
		for (const tool of ['ask_user', 'read_agent', 'report_intent', 'task_complete']) {
			expect(shouldRenderToolResultAsMarkdown(tool)).toBe(true);
			expect(shouldRenderToolResultAsMarkdown(tool.toUpperCase())).toBe(true);
		}
	});

	it('keeps data and command output in the existing plain renderer', () => {
		for (const tool of ['bash', 'view', 'rg', 'sql', 'session_store_sql']) {
			expect(shouldRenderToolResultAsMarkdown(tool)).toBe(false);
		}
	});
});

describe('getSubagentDisplayState', () => {
	it('renders successful foreground task calls as completed', () => {
		const state = getSubagentDisplayState(
			toolCall({
				argsJson: JSON.stringify({ mode: 'sync' }),
				resultJson: JSON.stringify('done'),
				status: 'ok',
				endedAt: 2000
			})
		);

		expect(state).toMatchObject({
			pending: false,
			isBackgroundLaunch: false,
			statusClass: 'ok',
			statusLabel: 'completed',
			lifecycleText: null,
			resultText: 'done',
			elapsedMs: 1000
		});
	});

	it('exposes a live running start for pending synchronous subagents', () => {
		const state = getSubagentDisplayState(
			toolCall({
				argsJson: JSON.stringify({ mode: 'sync' }),
				status: 'pending',
				startedAt: 1500,
				endedAt: null
			})
		);

		expect(state).toMatchObject({
			pending: true,
			isBackgroundLaunch: false,
			running: true,
			elapsedStartMs: 1500,
			elapsedMs: null
		});
	});

	it('renders successful background task calls as launched instead of completed', () => {
		const state = getSubagentDisplayState(
			toolCall({
				argsJson: JSON.stringify({ mode: 'background' }),
				resultJson: JSON.stringify({ agent_id: 'agent-123', content: 'Started background agent' }),
				status: 'ok',
				endedAt: 2000
			})
		);

		expect(state).toMatchObject({
			pending: false,
			isBackgroundLaunch: true,
			statusClass: 'background',
			statusLabel: 'launched',
			lifecycleText: 'Background agent launched.',
			resultText: 'Started background agent',
			backgroundAgentId: 'agent-123',
			elapsedMs: 1000
		});
	});

	it('renders completed background subagent lifecycle as completed', () => {
		const state = getSubagentDisplayState(
			toolCall({
				argsJson: JSON.stringify({ mode: 'background' }),
				resultJson: JSON.stringify({ agent_id: 'agent-123', content: 'Started background agent' }),
				status: 'ok',
				endedAt: 2000,
				backgroundAgentStatus: 'completed',
				backgroundAgentId: 'agent-123',
				backgroundAgentStartedAt: 2500,
				backgroundAgentEndedAt: 3000
			})
		);

		expect(state).toMatchObject({
			isBackgroundLaunch: true,
			statusClass: 'ok',
			statusLabel: 'completed',
			lifecycleText: 'Background agent completed.',
			backgroundAgentId: 'agent-123',
			elapsedMs: 500,
			running: false,
			elapsedStartMs: null
		});
	});

	it('exposes a live running start for in-progress background agents', () => {
		const state = getSubagentDisplayState(
			toolCall({
				argsJson: JSON.stringify({ mode: 'background' }),
				resultJson: JSON.stringify({ agent_id: 'agent-123', content: 'Started background agent' }),
				status: 'ok',
				endedAt: 2000,
				backgroundAgentStatus: 'running',
				backgroundAgentId: 'agent-123',
				backgroundAgentStartedAt: 2500,
				backgroundAgentEndedAt: null
			})
		);

		expect(state).toMatchObject({
			isBackgroundLaunch: true,
			statusClass: 'background',
			statusLabel: 'launched',
			running: true,
			elapsedStartMs: 2500
		});
	});

	it('does not mark a background agent running while its start time is absent', () => {
		const state = getSubagentDisplayState(
			toolCall({
				argsJson: JSON.stringify({ mode: 'background' }),
				resultJson: JSON.stringify({ agent_id: 'agent-123', content: 'Started background agent' }),
				status: 'ok',
				endedAt: 2000,
				backgroundAgentStatus: 'running',
				backgroundAgentId: 'agent-123',
				backgroundAgentStartedAt: null,
				backgroundAgentEndedAt: null
			})
		);

		expect(state).toMatchObject({
			running: false,
			elapsedStartMs: null
		});
	});

	it('keeps failed or denied background task launches as failed or denied', () => {
		expect(
			getSubagentDisplayState(
				toolCall({
					argsJson: JSON.stringify({ mode: 'background' }),
					status: 'error',
					endedAt: 2000
				})
			).statusLabel
		).toBe('failed');

		expect(
			getSubagentDisplayState(
				toolCall({
					argsJson: JSON.stringify({ mode: 'background' }),
					status: 'denied',
					endedAt: 2000
				})
			).statusLabel
		).toBe('denied');
	});

	it('extracts background agent ids from tolerated result shapes', () => {
		expect(getBackgroundAgentId(JSON.stringify({ agentId: 'agent-camel' }))).toBe('agent-camel');
		expect(getBackgroundAgentId(JSON.stringify({ id: 'agent-id' }))).toBe('agent-id');
		expect(
			getBackgroundAgentId(
				JSON.stringify({ content: [{ type: 'text', text: 'agent_id: agent-array' }] })
			)
		).toBe('agent-array');
		expect(getBackgroundAgentId(JSON.stringify('Started. Use read_agent with agent-text.'))).toBe(
			'agent-text'
		);
	});
});

describe('getSubagentPresentation', () => {
	it('gives the memory extractor its own icon and keeps it collapsed by default', () => {
		const p = getSubagentPresentation('memory-extractor');
		expect(p.icon).toBe('🧠');
		expect(p.autoExpandWhilePending).toBe(false);
	});

	it('falls back to default icon and auto-expand for other / unknown agent types', () => {
		for (const type of ['general-purpose', undefined]) {
			const p = getSubagentPresentation(type);
			expect(p.icon).toBe('🤖');
			expect(p.autoExpandWhilePending).toBe(true);
		}
	});
});
