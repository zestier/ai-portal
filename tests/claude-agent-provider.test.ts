import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PortalEvent } from '../src/lib/types';
import type { ProviderOpenOptions } from '../src/lib/server/providers/provider';
import { resetConfigForTests } from '../src/lib/server/config';
import { setupLocalEnv } from './helpers/env';

const { ensureClaudeAgentSkillsMock, discoverRepoPluginsMock, queryMock } = vi.hoisted(() => ({
	ensureClaudeAgentSkillsMock: vi.fn(async () => [
		'/tmp/claude-agent-skills/pinned/caveman',
		'/tmp/claude-agent-skills/pinned/ponytail'
	]),
	discoverRepoPluginsMock: vi.fn(async (): Promise<string[]> => []),
	queryMock: vi.fn()
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
	return { ...actual, query: queryMock };
});

vi.mock('../src/lib/server/providers/claude-agent-skills', () => ({
	ensureClaudeAgentSkills: ensureClaudeAgentSkillsMock
}));

vi.mock('../src/lib/server/providers/claude-agent-repo-plugins', () => ({
	discoverRepoPlugins: discoverRepoPluginsMock
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
		expect(options.skills).toBeUndefined();
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

	it('loads agent-plugins folders as local plugins with MCP discovery enabled', async () => {
		discoverRepoPluginsMock.mockResolvedValue(['/project/agent-plugins/repo-skills']);
		queryMock.mockReturnValue(messages({ type: 'result', subtype: 'success' } as SDKMessage));
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		await collect(session.send('hi', new AbortController().signal));

		const options = queryMock.mock.calls[0][0].options;
		expect(options.skills).toBeUndefined();
		expect(options.plugins).toEqual(
			expect.arrayContaining([
				{
					type: 'local',
					path: '/project/agent-plugins/repo-skills',
					skipMcpDiscovery: undefined
				}
			])
		);
	});

	it('loads repo plugins even when there are no pinned skills', async () => {
		ensureClaudeAgentSkillsMock.mockResolvedValue([] as string[]);
		discoverRepoPluginsMock.mockResolvedValue(['/project/agent-plugins/repo-skills']);
		queryMock.mockReturnValue(messages({ type: 'result', subtype: 'success' } as SDKMessage));
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		await collect(session.send('hi', new AbortController().signal));

		const options = queryMock.mock.calls[0][0].options;
		expect(options.skills).toBeUndefined();
		expect(options.plugins).toEqual([
			{ type: 'local', path: '/project/agent-plugins/repo-skills' }
		]);
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

	it('gates every tool call through the portal via the PreToolUse hook', async () => {
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
			tool_name: 'mcp__portal__read',
			tool_input: { file_path: '/tmp/example.ts' },
			tool_use_id: 'tool-read-1'
		});

		expect(decision).toEqual({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'allow'
			}
		});
		// The hook is the instant gate for auto-decisions; `canUseTool` carries
		// the human-prompt path (returned by the hook as `permissionDecision:
		// 'ask'`). The SDK coding built-ins are stripped, and only the Agent
		// subagent built-in remains.
		expect(queryMock.mock.calls[0][0].options).toMatchObject({
			allowedTools: ['Agent'],
			tools: ['Agent']
		});
		expect(queryMock.mock.calls[0][0].options.toolAliases).toBeUndefined();
		expect(queryMock.mock.calls[0][0].options.canUseTool).toEqual(expect.any(Function));
		expect(queryMock.mock.calls[0][0].options.mcpServers.portal.type).toBe('sdk');
	});

	it('injects the provider cwd as portal glob path so a bare pattern call is scoped and allowed', async () => {
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
			tool_name: 'mcp__portal__glob',
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

	it('leaves glob/grep calls that already carry a path unrewritten', async () => {
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
			tool_name: 'mcp__portal__grep',
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
		['read (absolute)', 'mcp__portal__read', { file_path: '/tmp/src/a.ts' }],
		['read (relative)', 'mcp__portal__read', { file_path: 'src/a.ts' }],
		[
			'edit (in-workspace)',
			'mcp__portal__edit',
			{ file_path: '/tmp/src/a.ts', old_string: 'x', new_string: 'y' }
		],
		['write (in-workspace)', 'mcp__portal__write', { file_path: '/tmp/src/b.ts', content: 'x' }],
		['glob (bare pattern)', 'mcp__portal__glob', { pattern: '**/*.{ts,tsx,js,jsx,mjs,cjs}' }],
		['glob (with path)', 'mcp__portal__glob', { pattern: '**/*.ts', path: '/tmp/src' }],
		['glob (relative path)', 'mcp__portal__glob', { pattern: '**/*.ts', path: 'src' }],
		['grep (bare pattern)', 'mcp__portal__grep', { pattern: 'readFileSync' }],
		['grep (with path)', 'mcp__portal__grep', { pattern: 'readFileSync', path: '/tmp/src' }],
		['grep (relative path)', 'mcp__portal__grep', { pattern: 'readFileSync', path: 'src' }],
		[
			'edit (relative)',
			'mcp__portal__edit',
			{ file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }
		],
		[
			'write (relative, nested)',
			'mcp__portal__write',
			{ file_path: 'src/deep/new.ts', content: 'x' }
		],
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

	it('a saved shell allow grant auto-allows a portal shell_exec call without a dialog', async () => {
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
			tool_name: 'mcp__portal__shell_exec',
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

	it('a saved read deny blocks a portal read call with feedback', async () => {
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
			tool_name: 'mcp__portal__read',
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

	it('returns ask from the hook for a prompt-worthy portal tool call', async () => {
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

		await collect(session.send('read secret', new AbortController().signal));
		// A read outside the conversation's workspace root (/tmp) needs a human
		// dialog under `policy: 'prompt'`. The hook must NOT await it (the CLI's
		// hook clock would kill a slow human); it defers via `ask` to the CLI's
		// own permission flow → `canUseTool`.
		const decision = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'mcp__portal__read',
			tool_input: { file_path: '/etc/passwd' },
			tool_use_id: 'tool-ask-hook'
		});

		expect(decision).toEqual({
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				permissionDecision: 'ask'
			}
		});
	});

	it('consults canUseTool for a prompt-worthy portal tool call', async () => {
		let canUseTool:
			| ((
					toolName: string,
					input: Record<string, unknown>,
					options: { toolUseID: string; signal: AbortSignal; requestId: string }
			  ) => Promise<unknown>)
			| undefined;
		queryMock.mockImplementation(({ options }) => {
			canUseTool = options.canUseTool;
			return messages({
				type: 'result',
				subtype: 'success',
				session_id: '33333333-3333-4333-8333-333333333333'
			} as SDKMessage);
		});
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);
		await collect(session.send('read secret', new AbortController().signal));

		expect(canUseTool).toBeDefined();
		const interactive = await import('../src/lib/server/runtime/interactive-requests');
		const pending = canUseTool!(
			'mcp__portal__read',
			{ file_path: '/etc/passwd' },
			{ toolUseID: 'tool-ask-1', signal: new AbortController().signal, requestId: 'req-ask-1' }
		);
		// The prompt-worthy call parks in the portal's interactive registry;
		// resolving it as the human would routes the allow back through the
		// canUseTool → `onPermissionRequest` gateway.
		await vi.waitFor(() => {
			expect(interactive.listForConversation('conv-claude-agent')).toHaveLength(1);
		});
		const [req] = interactive.listForConversation('conv-claude-agent');
		interactive.resolve(req.requestId, 'user-1', { kind: 'permission', decision: 'allow-once' });

		await expect(pending).resolves.toEqual({
			behavior: 'allow',
			updatedInput: { file_path: '/etc/passwd' },
			toolUseID: 'tool-ask-1'
		});
	});

	it('writes audit rows for portal calls under the hook', async () => {
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
			tool_name: 'mcp__portal__read',
			tool_input: { file_path: '/workspace/example.ts' },
			tool_use_id: 'tool-read-3'
		});

		const audit = settings.listRecentDecisionsForUser('user-1', 10);
		expect(audit).toEqual(
			expect.arrayContaining([expect.objectContaining({ tool: 'read', decision: 'auto-allow' })])
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
								name: 'mcp__portal__read',
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

	it('polls getContextUsage after a successful result and emits a context.usage event', async () => {
		const getContextUsage = vi.fn(async () => ({
			categories: [
				{ name: 'System prompt', tokens: 8000, color: '#1f6feb' },
				{ name: 'Tools', tokens: 4000, color: '#8957e5' },
				{ name: 'Messages', tokens: 12000, color: '#238636' }
			],
			totalTokens: 24000,
			maxTokens: 200000,
			rawMaxTokens: 200000,
			percentage: 12,
			gridRows: [
				[
					{
						color: '#1f6feb',
						isFilled: true,
						categoryName: 'System prompt',
						tokens: 8000,
						percentage: 4,
						squareFullness: 1
					}
				]
			],
			model: 'deepseek-v4-pro',
			memoryFiles: []
		}));
		queryMock.mockReturnValue(
			Object.assign(
				messages({
					type: 'result',
					subtype: 'success',
					session_id: '55555555-5555-4555-8555-555555555555'
				} as SDKMessage),
				{ getContextUsage }
			)
		);
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		const events = await collect(session.send('usage', new AbortController().signal));
		const usage = events.find((e) => e.type === 'context.usage') as Extract<
			PortalEvent,
			{ type: 'context.usage' }
		>;

		expect(getContextUsage).toHaveBeenCalledTimes(1);
		expect(usage).toMatchObject({
			type: 'context.usage',
			currentTokens: 24000,
			tokenLimit: 200000,
			percentage: 12,
			systemTokens: 8000,
			toolDefinitionsTokens: 4000,
			conversationTokens: 12000,
			model: 'deepseek-v4-pro'
		});
		expect(usage.categories).toHaveLength(3);
		expect(usage.gridRows).toHaveLength(1);
	});

	it('skips the context-usage poll when the SDK query exposes no getContextUsage', async () => {
		queryMock.mockReturnValue(
			messages({
				type: 'result',
				subtype: 'success',
				session_id: '66666666-6666-4666-8666-666666666666'
			} as SDKMessage)
		);
		const { claudeAgentProvider } =
			await import('../src/lib/server/providers/claude-agent-provider');
		const session = await claudeAgentProvider.openSession(baseOpts);

		const events = await collect(session.send('usage', new AbortController().signal));
		expect(events.some((e) => e.type === 'context.usage')).toBe(false);
	});
});
