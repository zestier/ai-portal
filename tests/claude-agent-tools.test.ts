import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
	adaptClaudePortalTool,
	buildClaudePortalTools
} from '../src/lib/server/providers/claude-agent-tools';
import type { ProviderOpenOptions } from '../src/lib/server/providers/provider';
import { err, ok, type PortalTool } from '../src/lib/server/tools/types';
import { setupLocalEnv } from './helpers/env';

const signal = new AbortController().signal;

beforeEach(async () => {
	await setupLocalEnv('portal-claude-agent-tools-');
});

function portalTool(handler: PortalTool['handler']): PortalTool {
	return {
		name: 'example',
		description: 'Example tool',
		parameters: {},
		argsSchema: z.object({ value: z.string() }).refine(({ value }) => value.length > 0),
		handler
	};
}

describe('adaptClaudePortalTool', () => {
	it('converts portal success and returned error envelopes to MCP results', async () => {
		const success = adaptClaudePortalTool(
			portalTool(async ({ value }) => ok({ echoed: value }, 'echoed')),
			{ getSignal: () => signal }
		);
		const failure = adaptClaudePortalTool(
			portalTool(async () => err('not available', { code: 'missing' })),
			{ getSignal: () => signal }
		);

		await expect(success.handler({ value: 'hello' }, {})).resolves.toMatchObject({
			content: [{ type: 'text', text: expect.stringContaining('hello') }],
			isError: false
		});
		await expect(failure.handler({ value: 'hello' }, {})).resolves.toMatchObject({
			content: [{ type: 'text', text: 'not available (code: missing)' }],
			isError: true
		});
	});

	it('converts thrown handler errors to MCP errors', async () => {
		const adapted = adaptClaudePortalTool(
			portalTool(async () => {
				throw new Error('handler exploded');
			}),
			{ getSignal: () => signal }
		);

		await expect(adapted.handler({ value: 'hello' }, {})).resolves.toMatchObject({
			content: [{ type: 'text', text: 'handler exploded' }],
			isError: true
		});
	});
});

describe('buildClaudePortalTools', () => {
	it('does not expose disabled tool groups', () => {
		const opts: ProviderOpenOptions = {
			provider: 'claude-agent',
			conversationId: 'conversation-1',
			userId: 'user-1',
			workingDirectory: '/tmp',
			model: 'deepseek-chat',
			policy: 'prompt',
			disabledToolGroups: ['git', 'memory']
		};
		const tools = buildClaudePortalTools({
			opts,
			getMode: () => 'interactive',
			getApprovalMode: () => 'ask',
			emit: vi.fn(),
			getSignal: () => signal
		});

		expect(tools.some(({ name }) => name.startsWith('git_'))).toBe(false);
		expect(tools.some(({ name }) => name.startsWith('memory_'))).toBe(false);
		expect(tools.some(({ name }) => name === 'read_file')).toBe(true);
	});
});
