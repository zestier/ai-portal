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

	it('passes the raw structured result as JSON instead of the formatted modelText', async () => {
		const adapted = adaptClaudePortalTool(
			portalTool(async () =>
				ok(
					{
						content: '  indented line\nline without indent\n\ttabbed',
						size: 42,
						isComplete: true
					},
					'Read file: example.ts'
				)
			),
			{ getSignal: () => signal }
		);

		const { content, isError } = await adapted.handler({ value: 'hello' }, {});
		expect(isError).toBe(false);
		const text = content.find((c) => c.type === 'text')?.text;
		expect(text).toBeDefined();
		const parsed = JSON.parse(text as string);
		expect(parsed.summary).toBe('Read file: example.ts');
		// The raw envelope must survive byte-for-byte — including leading
		// whitespace/indentation that the human-formatted modelText mangles.
		expect(parsed.raw).toMatchObject({
			ok: true,
			summary: 'Read file: example.ts',
			result: {
				content: '  indented line\nline without indent\n\ttabbed',
				size: 42,
				isComplete: true
			}
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

function portalOpts(overrides: Partial<ProviderOpenOptions> = {}): ProviderOpenOptions {
	return {
		provider: 'claude-agent',
		conversationId: 'conversation-1',
		userId: 'user-1',
		workingDirectory: '/tmp',
		model: 'deepseek-chat',
		policy: 'prompt',
		...overrides
	};
}

function buildPortalTools(overrides: Partial<ProviderOpenOptions> = {}): PortalTool[] {
	return buildClaudePortalTools({
		opts: portalOpts(overrides),
		getMode: () => 'interactive',
		getApprovalMode: () => 'ask',
		emit: vi.fn(),
		getSignal: () => signal
	});
}

describe('buildClaudePortalTools', () => {
	it('does not expose disabled tool groups', () => {
		const tools = buildPortalTools({ disabledToolGroups: ['git', 'memory'] });

		expect(tools.some(({ name }) => name.startsWith('git_'))).toBe(false);
		expect(tools.some(({ name }) => name.startsWith('memory_'))).toBe(false);
		expect(tools.some(({ name }) => name === 'read_file')).toBe(false);
		expect(tools.some(({ name }) => name === 'move')).toBe(true);
	});

	it('omits portal tools that duplicate the Agent SDK built-in tools', () => {
		const names = new Set(buildPortalTools().map(({ name }) => name));
		const duplicates = [
			'shell_exec',
			'read_file',
			'list_files',
			'grep',
			'create_file',
			'replace_lines',
			'replace_text'
		];
		for (const name of duplicates) {
			expect(names.has(name)).toBe(false);
		}
		const kept = [
			'apply_patch',
			'move',
			'trash',
			'create_directory',
			'git_status',
			'ticket_add',
			'template_list',
			'worktree_create',
			'permission_capabilities'
		];
		for (const name of kept) {
			expect(names.has(name)).toBe(true);
		}
	});
});
