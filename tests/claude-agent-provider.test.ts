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

beforeEach(async () => {
	await setupLocalEnv('portal-claude-agent-');
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

	it('routes built-in tool permissions through the portal approval mode', async () => {
		let canUseTool: NonNullable<
			NonNullable<
				Parameters<typeof import('@anthropic-ai/claude-agent-sdk').query>[0]['options']
			>['canUseTool']
		> | null = null;
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
		const session = await claudeAgentProvider.openSession({
			...baseOpts,
			approvalMode: 'auto-approve'
		});

		await collect(session.send('inspect files', new AbortController().signal));
		expect(canUseTool).not.toBeNull();
		const decision = await canUseTool!(
			'Read',
			{ file_path: '/tmp/example.ts' },
			{
				signal: new AbortController().signal,
				toolUseID: 'tool-read-1',
				requestId: 'request-read-1'
			}
		);

		expect(decision).toMatchObject({
			behavior: 'allow',
			updatedInput: { file_path: '/tmp/example.ts' },
			toolUseID: 'tool-read-1'
		});
		expect(queryMock.mock.calls[0][0].options).toMatchObject({
			allowedTools: ['Agent'],
			tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'Agent']
		});
		expect(queryMock.mock.calls[0][0].options.mcpServers.portal.type).toBe('sdk');
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
});
