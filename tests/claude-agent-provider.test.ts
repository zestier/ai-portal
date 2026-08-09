import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PortalEvent } from '../src/lib/types';
import type { ProviderOpenOptions } from '../src/lib/server/providers/provider';
import { resetConfigForTests } from '../src/lib/server/config';
import { setupLocalEnv } from './helpers/env';

const { ensureClaudeAgentSkillsMock, queryMock } = vi.hoisted(() => ({
	ensureClaudeAgentSkillsMock: vi.fn(async () => [
		'/tmp/claude-agent-skills/pinned/caveman',
		'/tmp/claude-agent-skills/pinned/ponytail'
	]),
	queryMock: vi.fn()
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
	return { ...actual, query: queryMock };
});

vi.mock('../src/lib/server/providers/claude-agent-skills', () => ({
	ensureClaudeAgentSkills: ensureClaudeAgentSkillsMock
}));

const baseOpts: ProviderOpenOptions = {
	provider: 'claude-agent',
	conversationId: 'conv-claude-agent',
	userId: 'user-1',
	workingDirectory: '/tmp',
	model: 'deepseek-v4-pro',
	policy: 'prompt'
};

async function collect(iterable: AsyncIterable<PortalEvent>): Promise<PortalEvent[]> {
	const events: PortalEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

function messages(...items: SDKMessage[]): AsyncGenerator<SDKMessage> {
	return (async function* () {
		for (const item of items) yield item;
	})();
}

/** Permission grants and conversations are keyed by user_id, so the fixed
 * test user must exist before `addGrant`/`convs.create` (both have FKs). */
async function seedUser(userId: string): Promise<void> {
	const { getDb } = await import('../src/lib/server/db');
	getDb()
		.prepare(
			`INSERT OR IGNORE INTO users(id, github_login, display_name, created_at, last_login_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(userId, `test:${userId}`, 'Test user', Date.now(), Date.now());
}

beforeEach(async () => {
	await setupLocalEnv('portal-claude-agent-');
	await seedUser('user-1');
	process.env.CLAUDE_AGENT_API_KEY = 'deepseek-key';
	process.env.CLAUDE_AGENT_BASE_URL = 'https://api.deepseek.com/anthropic';
	resetConfigForTests();
});

afterEach(() => {
	delete process.env.CLAUDE_AGENT_API_KEY;
	delete process.env.CLAUDE_AGENT_BASE_URL;
	resetConfigForTests();
	vi.restoreAllMocks();
});

describe('claudeAgentProvider', () => {
	it('streams text and persists the Agent SDK session id without resuming the portal id', async () => {
		const onProviderSessionIdChange = vi.fn();
		queryMock.mockReturnValue(
			messages(
				{
					type: 'system',
					subtype: 'init',
					session_id: '11111111-1111-4111-8111-111111111111'
				} as unknown as SDKMessage,
				{
					type: 'stream_event',
					event: {
						type: 'content_block_delta',
						index: 0,
						delta: { type: 'text_delta', text: 'hello' }
					}
				} as SDKMessage,
				{
					type: 'result',
					subtype: 'success',
					session_id: '11111111-1111-4111-8111-111111111111'
				} as SDKMessage
			)
		);
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession({
			...baseOpts,
			onProviderSessionIdChange
		});

		const events = await collect(session.send('hi', new AbortController().signal));

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'message.delta', text: 'hello' }),
				{ type: 'done' }
			])
		);
		expect(onProviderSessionIdChange).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
		expect(session.providerSessionId).toBe('11111111-1111-4111-8111-111111111111');
		const options = queryMock.mock.calls[0][0].options;
		expect(options.resume).toBeUndefined();
		expect(options.skills).toBe('all');
		expect(options.plugins).toEqual([
			{
				type: 'local',
				path: expect.stringMatching(/\/claude-agent-skills\/.*\/caveman$/),
				skipMcpDiscovery: true
			},
			{
				type: 'local',
				path: expect.stringMatching(/\/claude-agent-skills\/.*\/ponytail$/),
				skipMcpDiscovery: true
			}
		]);
		expect(options.env).toMatchObject({
			ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
			ANTHROPIC_AUTH_TOKEN: 'deepseek-key',
			ANTHROPIC_API_KEY: undefined
		});
	});

	it('resumes an existing SDK session and aborts the active query', async () => {
		let receivedSignal: AbortSignal | undefined;
		queryMock.mockImplementation(({ options }) => {
			receivedSignal = options.abortController.signal;
			return {
				[Symbol.asyncIterator]() {
					return this;
				},
				async next() {
					await new Promise<void>((resolve) =>
						options.abortController.signal.addEventListener('abort', () => resolve(), {
							once: true
						})
					);
					throw new Error('aborted');
				}
			};
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession({
			...baseOpts,
			providerSessionId: '22222222-2222-4222-8222-222222222222'
		});

		const pending = collect(session.send('continue', new AbortController().signal));
		await vi.waitFor(() => expect(receivedSignal).toBeDefined());
		await session.abort();
		const events = await pending;

		expect(receivedSignal?.aborted).toBe(true);
		expect(queryMock.mock.calls[0][0].options.resume).toBe('22222222-2222-4222-8222-222222222222');
		expect(events).toContainEqual({
			type: 'error',
			code: 'aborted',
			message: 'Aborted by client.'
		});
	});

	function capturePreToolUseHook(options: {
		[key: string]: unknown;
	}): ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null {
		const hooks = options.hooks as
			| { PreToolUse?: Array<{ hooks: Array<(i: unknown) => unknown> }> }
			| undefined;
		const matcher = hooks?.PreToolUse?.[0];
		return matcher
			? (matcher.hooks[0] as (i: Record<string, unknown>) => Promise<Record<string, unknown>>)
			: null;
	}

	it('gates every built-in tool call through the portal via the PreToolUse hook', async () => {
		let preToolUse: ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
			null;
		queryMock.mockImplementation(({ options }) => {
			preToolUse = capturePreToolUseHook(options);
			return messages({
				type: 'result',
				subtype: 'success',
				session_id: '33333333-3333-4333-8333-333333333333'
			} as SDKMessage);
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession({
			...baseOpts,
			approvalMode: 'auto-approve'
		});

		await collect(session.send('inspect files', new AbortController().signal));
		expect(preToolUse).not.toBeNull();
		const decision = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'Read',
			tool_input: { file_path: '/tmp/example.ts' },
			tool_use_id: 'tool-read-1'
		});

		expect(decision).toEqual({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'allow'
			}
		});
		// The hook is the single gate: canUseTool is gone, the allowlist and
		// built-in tool surface are unchanged.
		expect(queryMock.mock.calls[0][0].options).toMatchObject({
			allowedTools: ['Agent'],
			tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent'],
			toolAliases: {
				Glob: 'mcp__portal__glob',
				Grep: 'mcp__portal__grep',
				Write: 'mcp__portal__write'
			}
		});
		expect(queryMock.mock.calls[0][0].options.canUseTool).toBeUndefined();
		expect(queryMock.mock.calls[0][0].options.mcpServers.portal.type).toBe('sdk');
	});

	it('injects the provider cwd as Glob path so a bare pattern call is scoped and allowed', async () => {
		let preToolUse: ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
			null;
		queryMock.mockImplementation(({ options }) => {
			preToolUse = capturePreToolUseHook(options);
			return messages({
				type: 'result',
				subtype: 'success',
				session_id: '33333333-3333-4333-8333-333333333333'
			} as SDKMessage);
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		await collect(session.send('search files', new AbortController().signal));
		const decision = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'Glob',
			tool_input: { pattern: '**/*.{ts,tsx,js,jsx,mjs,cjs}' },
			tool_use_id: 'tool-glob-1'
		});

		// The cwd default is synthesized into the request so the read seed scopes
		// it (scope key is not null), and passed back via updatedInput so the
		// executed search uses exactly the path that was verified.
		expect(decision).toEqual({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'allow',
				updatedInput: {
					pattern: '**/*.{ts,tsx,js,jsx,mjs,cjs}',
					path: '/tmp'
				}
			}
		});
	});

	it('leaves Glob/Grep calls that already carry a path unrewritten', async () => {
		let preToolUse: ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
			null;
		queryMock.mockImplementation(({ options }) => {
			preToolUse = capturePreToolUseHook(options);
			return messages({
				type: 'result',
				subtype: 'success',
				session_id: '33333333-3333-4333-8333-333333333333'
			} as SDKMessage);
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		await collect(session.send('search files', new AbortController().signal));
		const decision = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'Grep',
			tool_input: { pattern: 'readFileSync', path: '/tmp/src' },
			tool_use_id: 'tool-grep-1'
		});

		expect(decision).toEqual({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'allow'
			}
		});
	});

	it.each([
		['Read (absolute)', 'Read', { file_path: '/tmp/src/a.ts' }],
		['Read (relative)', 'Read', { file_path: 'src/a.ts' }],
		[
			'Edit (in-workspace)',
			'Edit',
			{ file_path: '/tmp/src/a.ts', old_string: 'x', new_string: 'y' }
		],
		['Write (in-workspace)', 'Write', { file_path: '/tmp/src/b.ts', content: 'x' }],
		[
			'NotebookEdit (in-workspace)',
			'NotebookEdit',
			{ notebook_path: '/tmp/src/n.ipynb', cell_id: 'c1', new_value: 'x' }
		],
		['Glob (bare pattern)', 'Glob', { pattern: '**/*.{ts,tsx,js,jsx,mjs,cjs}' }],
		['Glob (with path)', 'Glob', { pattern: '**/*.ts', path: '/tmp/src' }],
		['Glob (relative path)', 'Glob', { pattern: '**/*.ts', path: 'src' }],
		['Grep (bare pattern)', 'Grep', { pattern: 'readFileSync' }],
		['Grep (with path)', 'Grep', { pattern: 'readFileSync', path: '/tmp/src' }],
		['Grep (relative path)', 'Grep', { pattern: 'readFileSync', path: 'src' }],
		['Edit (relative)', 'Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }],
		['Write (relative, nested)', 'Write', { file_path: 'src/deep/new.ts', content: 'x' }],
		['create_directory (in-workspace)', 'mcp__portal__create_directory', { path: 'newdir' }],
		['move (in-workspace)', 'mcp__portal__move', { source: 'a.txt', destination: 'b.txt' }],
		['trash (in-workspace)', 'mcp__portal__trash', { path: 'a.txt' }],
		[
			'apply_patch (in-workspace)',
			'mcp__portal__apply_patch',
			{ patch: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n' }
		],
		[
			'apply_patch (add via /dev/null)',
			'mcp__portal__apply_patch',
			{ patch: '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x\n' }
		],
		[
			'apply_patch (delete via /dev/null)',
			'mcp__portal__apply_patch',
			{ patch: '--- a/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n' }
		],
		[
			'apply_patch (git-style)',
			'mcp__portal__apply_patch',
			{
				patch:
					'diff --git a/foo.ts b/foo.ts\nindex 0000000..1111111\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n'
			}
		]
	])('auto-approves path-based tool call: %s', async (_label, tool_name, tool_input) => {
		let preToolUse: ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
			null;
		queryMock.mockImplementation(({ options }) => {
			preToolUse = capturePreToolUseHook(options);
			return messages({
				type: 'result',
				subtype: 'success',
				session_id: '33333333-3333-4333-8333-333333333333'
			} as SDKMessage);
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		await collect(session.send('touch files', new AbortController().signal));
		const decision = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name,
			tool_input,
			tool_use_id: 'tool-probe-1'
		});

		expect(decision).toEqual(
			expect.objectContaining({
				hookSpecificOutput: expect.objectContaining({
					hookEventName: 'PreToolUse',
					permissionDecision: 'allow'
				})
			})
		);
	});

	it('a saved shell allow grant auto-allows an SDK Bash call without a dialog', async () => {
		let preToolUse: ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
			null;
		queryMock.mockImplementation(({ options }) => {
			preToolUse = capturePreToolUseHook(options);
			return messages({
				type: 'result',
				subtype: 'success',
				session_id: '33333333-3333-4333-8333-333333333333'
			} as SDKMessage);
		});
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId: 'user-1',
			conversationId: null,
			tool: 'shell',
			permissionKind: 'shell',
			scope: {
				kind: 'shell',
				rule: { command: [{ token: 'ls' }], positionals: { kind: 'any' } }
			},
			decision: 'allow'
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		await collect(session.send('list files', new AbortController().signal));
		const decision = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'Bash',
			tool_input: { command: 'ls -la' },
			tool_use_id: 'tool-bash-1'
		});

		expect(decision).toEqual({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'allow'
			}
		});
	});

	it('a saved read deny blocks an SDK built-in Read call with feedback', async () => {
		let preToolUse: ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
			null;
		queryMock.mockImplementation(({ options }) => {
			preToolUse = capturePreToolUseHook(options);
			return messages({
				type: 'result',
				subtype: 'success',
				session_id: '33333333-3333-4333-8333-333333333333'
			} as SDKMessage);
		});
		const settings = await import('../src/lib/server/db/repos/settings');
		settings.addGrant({
			userId: 'user-1',
			conversationId: null,
			tool: 'read',
			permissionKind: 'read',
			scope: {
				kind: 'fs',
				perms: ['read'],
				rule: { kind: 'path', root: 'absolute', behavior: 'prefix', value: '/tmp' }
			},
			decision: 'deny',
			denyReason: 'Read denied by test grant.'
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		await collect(session.send('read secret', new AbortController().signal));
		const decision = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'Read',
			tool_input: { file_path: '/tmp/secret.txt' },
			tool_use_id: 'tool-read-2'
		});

		const out = decision.hookSpecificOutput as {
			permissionDecision: string;
			permissionDecisionReason: string;
		};
		expect(out.permissionDecision).toBe('deny');
		expect(out.permissionDecisionReason).toContain('Read denied by test grant.');
	});

	it('writes audit rows for calls that previously bypassed the portal', async () => {
		let preToolUse: ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
			null;
		queryMock.mockImplementation(({ options }) => {
			preToolUse = capturePreToolUseHook(options);
			return messages({
				type: 'result',
				subtype: 'success',
				session_id: '33333333-3333-4333-8333-333333333333'
			} as SDKMessage);
		});
		const convs = await import('../src/lib/server/db/repos/conversations');
		const settings = await import('../src/lib/server/db/repos/settings');
		// The conversation's workspace root derives from its own workdir
		// (effectiveWorkdir resolves /tmp to /workspace here), so the read must
		// target a path inside that root or it would raise a dialog and block.
		convs.create('user-1', {
			id: 'conv-claude-agent',
			title: 'gate test',
			workdir: '/workspace',
			model: null
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		await collect(session.send('inspect files', new AbortController().signal));
		await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'Read',
			tool_input: { file_path: '/workspace/example.ts' },
			tool_use_id: 'tool-read-3'
		});

		const audit = settings.listRecentDecisionsForUser('user-1', 10);
		expect(audit).toEqual(
			expect.arrayContaining([expect.objectContaining({ tool: 'Read', decision: 'auto-allow' })])
		);
	});

	it('never-prompt portal tools still auto-allow under the hook', async () => {
		let preToolUse: ((input: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
			null;
		queryMock.mockImplementation(({ options }) => {
			preToolUse = capturePreToolUseHook(options);
			return messages({
				type: 'result',
				subtype: 'success',
				session_id: '33333333-3333-4333-8333-333333333333'
			} as SDKMessage);
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		await collect(session.send('inspect', new AbortController().signal));
		const decision = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'mcp__portal__force_retry_tool',
			tool_input: {
				token: 'aaaaaaaaaaaaaaaaaaaaaaaa',
				reason: 'test reason longer than twenty characters'
			},
			tool_use_id: 'tool-portal-1'
		});

		expect(decision).toEqual({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'allow'
			}
		});
	});

	it('normalizes tool calls, results, and subagent lifecycle events', async () => {
		queryMock.mockReturnValue(
			messages(
				{
					type: 'assistant',
					uuid: 'assistant-tools',
					session_id: '44444444-4444-4444-8444-444444444444',
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: 'tool_use',
								id: 'agent-call-1',
								name: 'Agent',
								input: { prompt: 'inspect' }
							}
						]
					}
				} as unknown as SDKMessage,
				{
					type: 'user',
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: 'tool_result',
								tool_use_id: 'agent-call-1',
								content: 'inspection complete'
							}
						]
					}
				} as SDKMessage,
				{
					type: 'result',
					subtype: 'success',
					session_id: '44444444-4444-4444-8444-444444444444'
				} as SDKMessage
			)
		);
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		const events = await collect(session.send('delegate', new AbortController().signal));

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'tool.call',
					toolCallId: 'agent-call-1',
					tool: 'Agent'
				}),
				{
					type: 'subagent.lifecycle',
					toolCallId: 'agent-call-1',
					agentId: 'agent-call-1',
					status: 'running'
				},
				expect.objectContaining({
					type: 'tool.result',
					toolCallId: 'agent-call-1',
					ok: true,
					summary: 'inspection complete'
				}),
				{
					type: 'subagent.lifecycle',
					toolCallId: 'agent-call-1',
					agentId: 'agent-call-1',
					status: 'completed'
				}
			])
		);
	});

	it('splits reasoning into per-burst segments interleaved with tool calls', async () => {
		queryMock.mockReturnValue(
			messages(
				{
					type: 'stream_event',
					parent_tool_use_id: null,
					event: {
						type: 'content_block_delta',
						index: 0,
						delta: { type: 'thinking_delta', thinking: 'plan the read' }
					}
				} as unknown as SDKMessage,
				{
					type: 'assistant',
					uuid: 'assistant-1',
					session_id: '44444444-4444-4444-8444-444444444444',
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: 'tool_use',
								id: 'agent-call-1',
								name: 'Agent',
								input: { prompt: 'inspect' }
							}
						]
					}
				} as unknown as SDKMessage,
				{
					type: 'stream_event',
					parent_tool_use_id: null,
					event: {
						type: 'content_block_delta',
						index: 0,
						delta: { type: 'thinking_delta', thinking: 'plan the write' }
					}
				} as unknown as SDKMessage,
				{
					type: 'assistant',
					uuid: 'assistant-2',
					session_id: '44444444-4444-4444-8444-444444444444',
					parent_tool_use_id: null,
					message: {
						content: [
							{
								type: 'tool_use',
								id: 'read-call-1',
								name: 'Read',
								input: { file_path: '/tmp/a.ts' }
							}
						]
					}
				} as unknown as SDKMessage,
				{
					type: 'result',
					subtype: 'success',
					session_id: '44444444-4444-4444-8444-444444444444'
				} as SDKMessage
			)
		);
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		const events = await collect(session.send('inspect then write', new AbortController().signal));
		const reasoning = events.filter((e) => e.type === 'message.reasoning') as Array<{
			segmentId: string;
			text: string;
			parentToolCallId?: string;
		}>;

		// Two distinct bursts — not fused into one giant segment.
		expect(new Set(reasoning.map((e) => e.segmentId)).size).toBe(2);
		expect(reasoning.map((e) => e.text)).toEqual(['plan the read', 'plan the write']);
		// Top-level bursts carry no parent tool call.
		expect(reasoning.map((e) => e.parentToolCallId)).toEqual([undefined, undefined]);

		// Each burst closes (reasoning.end) before its own tool.call fires.
		const interleaved = events.filter(
			(e) =>
				e.type === 'message.reasoning' ||
				e.type === 'message.reasoning.end' ||
				e.type === 'tool.call'
		);
		expect(interleaved.map((e) => e.type)).toEqual([
			'message.reasoning',
			'message.reasoning.end',
			'tool.call',
			'message.reasoning',
			'message.reasoning.end',
			'tool.call'
		]);
		const calls = events.filter((e) => e.type === 'tool.call') as Array<{ toolCallId: string }>;
		expect(calls.map((e) => e.toolCallId)).toEqual(['agent-call-1', 'read-call-1']);
	});

	it('attributes sub-agent thinking to the spawning task via parentToolCallId', async () => {
		queryMock.mockReturnValue(
			messages(
				{
					type: 'stream_event',
					parent_tool_use_id: 'agent-call-1',
					event: {
						type: 'content_block_delta',
						index: 0,
						delta: { type: 'thinking_delta', thinking: 'child thinks' }
					}
				} as unknown as SDKMessage,
				{
					type: 'stream_event',
					parent_tool_use_id: null,
					event: {
						type: 'content_block_delta',
						index: 0,
						delta: { type: 'thinking_delta', thinking: 'top thinks' }
					}
				} as unknown as SDKMessage,
				{
					type: 'result',
					subtype: 'success',
					session_id: '44444444-4444-4444-8444-444444444444'
				} as SDKMessage
			)
		);
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		const events = await collect(session.send('delegate', new AbortController().signal));
		const reasoning = events.filter((e) => e.type === 'message.reasoning') as Array<{
			text: string;
			parentToolCallId?: string;
		}>;

		expect(reasoning).toEqual([
			expect.objectContaining({ text: 'child thinks', parentToolCallId: 'agent-call-1' }),
			expect.objectContaining({ text: 'top thinks' })
		]);
		expect(reasoning[1]).not.toHaveProperty('parentToolCallId');
	});
});
