import { describe, it, expect } from 'vitest';
import { parseGitToolResult } from '../src/lib/client/git-tool-result';
import { summarizeToolCall } from '../src/lib/client/tool-summary';
import { decodeToolResult, shouldRenderToolResultAsMarkdown } from '../src/lib/client/tool-result';
import {
	getBackgroundAgentId,
	getSubagentDisplayState,
	getSubagentPresentation
} from '../src/lib/client/subagent-display';
import type { ToolCallRecord } from '../src/lib/types';

function toolCall(overrides: Partial<ToolCallRecord>): ToolCallRecord {
	return {
		id: 'tool-1',
		messageId: 'msg-1',
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

	it('shows path with view_range for view', () => {
		expect(
			summarizeToolCall('view', JSON.stringify({ path: 'src/foo.ts', view_range: [1, 30] }))
		).toBe('src/foo.ts [1-30]');
	});

	it('shows pattern + glob for grep', () => {
		expect(summarizeToolCall('grep', JSON.stringify({ pattern: 'foo', glob: '*.ts' }))).toBe(
			'foo  (*.ts)'
		);
	});

	it('returns null on malformed args', () => {
		expect(summarizeToolCall('bash', 'not json')).toBeNull();
	});

	it('summarizes raw apply_patch input by touched files', () => {
		expect(
			summarizeToolCall(
				'apply_patch',
				[
					'*** Begin Patch',
					'*** Update File: src/foo.ts',
					'@@',
					'-a',
					'+b',
					'*** Add File: src/bar.ts',
					'+hello',
					'*** End Patch'
				].join('\n')
			)
		).toBe('src/foo.ts +1 more');
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
			summarizeToolCall(
				'git_commit',
				JSON.stringify({
					subject: 'Add feature',
					paths: ['src/a.ts', 'src/b.ts'],
					body: 'Details',
					trailers: [{ token: 'Co-authored-by', value: 'Copilot <copilot@example.com>' }]
				})
			)
		).toBe('Add feature · src/a.ts +1 more · body · 1 trailers');
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

describe('shouldRenderToolResultAsMarkdown', () => {
	it('uses markdown for human-facing prose tools', () => {
		for (const tool of [
			'ask_user',
			'exit_plan_mode',
			'read_agent',
			'report_intent',
			'task_complete'
		]) {
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
