import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildFixture } from '../scripts/golden-fixture.mjs';
import {
	adaptClaudePortalTool,
	buildClaudePortalTools
} from '../src/lib/server/providers/claude-agent-tools';
import type { ProviderOpenOptions } from '../src/lib/server/providers/provider';
import {
	deriveToolResultViews,
	err,
	ok,
	parseEnvelopeJson,
	serializeEnvelope,
	type PortalTool
} from '../src/lib/server/tools/types';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

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

	it('emits tool-provided rendered text instead of the JSON envelope', async () => {
		const adapted = adaptClaudePortalTool(
			portalTool(async () =>
				ok(
					{ mode: 'files_with_matches', numFiles: 2, filenames: ['a.ts', 'b.ts'] },
					'Search completed.',
					{ views: [{ type: 'text', text: 'Found 2 files\na.ts\nb.ts' }] }
				)
			),
			{ getSignal: () => signal }
		);

		const { content, isError } = await adapted.handler({ value: 'hello' }, {});
		expect(isError).toBe(false);
		const text = content.find((c) => c.type === 'text')?.text;
		// The rendered text, not `JSON.stringify({ raw, summary })`.
		expect(text).toBe('Found 2 files\na.ts\nb.ts');
		expect(() => JSON.parse(text as string)).toThrow();
	});

	it('keeps the envelope JSON as fullContent while a tool renders per-tool text', async () => {
		const envelope = ok(
			{ mode: 'files_with_matches', numFiles: 1, filenames: ['x.ts'] },
			'Search completed.',
			{ views: [{ type: 'text', text: 'Found 1 file\nx.ts' }] }
		);
		const adapted = adaptClaudePortalTool(
			portalTool(async () => envelope),
			{ getSignal: () => signal }
		);

		const { content } = await adapted.handler({ value: 'hello' }, {});
		const text = content.find((c) => c.type === 'text')?.text;
		expect(text).toBe('Found 1 file\nx.ts');
		// The two views stay split: the model got the rendered text, while the
		// envelope survives as the UI's `fullContent`.
		const views = deriveToolResultViews(envelope);
		expect(views.fullContent).toBe(serializeEnvelope(envelope));
		expect(views.fullContent).not.toBe(text);
		expect(parseEnvelopeJson(views.fullContent)).toEqual(envelope);
	});

	it('forwards an image view as an MCP image content block (Read of an image file)', async () => {
		const adapted = adaptClaudePortalTool(
			portalTool(async () =>
				ok({ path: 'diagram.png', width: 640 }, 'Read file: diagram.png', {
					views: [{ type: 'image', data: 'cGFnZQ==', mimeType: 'image/png' }]
				})
			),
			{ getSignal: () => signal }
		);

		const { content, isError } = await adapted.handler({ value: 'hello' }, {});
		expect(isError).toBe(false);
		expect(content).toEqual([{ type: 'image', data: 'cGFnZQ==', mimeType: 'image/png' }]);
	});

	it('appends legacy binary images as MCP image blocks behind the JSON text', async () => {
		const adapted = adaptClaudePortalTool(
			portalTool(async () =>
				ok({ path: 'shot.png' }, 'Read file: shot.png', {
					binary: [{ type: 'image', data: 'c2hvdA==', mimeType: 'image/png' }]
				})
			),
			{ getSignal: () => signal }
		);

		const { content, isError } = await adapted.handler({ value: 'hello' }, {});
		expect(isError).toBe(false);
		expect(content[0].type).toBe('text');
		expect(content[1]).toEqual({ type: 'image', data: 'c2hvdA==', mimeType: 'image/png' });
	});

	it('live path: a Grep call renders rg-style text, not the JSON envelope', async () => {
		const cwd = makeTmpDir('portal-grep-render-');
		await buildFixture(cwd);
		const portalTools = buildPortalTools({ workingDirectory: cwd });
		const grep = portalTools.find((t) => t.name === 'grep');
		expect(grep).toBeDefined();
		const adapted = adaptClaudePortalTool(grep!, { getSignal: () => signal });

		const { content, isError } = await adapted.handler(
			{ pattern: 'alpha one', path: 'sample.txt' },
			{}
		);
		expect(isError).toBe(false);
		const text = content.find((c) => c.type === 'text')?.text;
		expect(text).toBe('Found 1 file\nsample.txt');
		// Rendered text is plain, never the JSON envelope.
		expect(text).not.toContain('"raw"');
		expect(() => JSON.parse(text as string)).toThrow();
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
		const duplicates = ['shell_exec', 'read_file', 'list_files', 'replace_lines', 'replace_text'];
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
			'permission_capabilities',
			// `grep` is rerouted to the portal implementation via toolAliases
			// ({ Grep: 'mcp__portal__grep' }), so it is exposed, not omitted.
			'grep',
			// `glob` mirrors the SDK Glob via toolAliases ({ Glob: 'mcp__portal__glob' }),
			// so it is exposed, not omitted.
			'glob',
			// `write` mirrors the SDK Write via toolAliases ({ Write: 'mcp__portal__write' }),
			// so it is exposed, not omitted.
			'write',
			// `edit` mirrors the SDK Edit via toolAliases ({ Edit: 'mcp__portal__edit' }),
			// so it is exposed, not omitted.
			'edit'
		];
		for (const name of kept) {
			expect(names.has(name)).toBe(true);
		}
	});
});
