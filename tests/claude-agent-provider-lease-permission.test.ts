// Guards the path-based permission surface for worktree leases. A lease
// workspace lives under WORKTREE_ROOT/<user>/leases/<id>, a SIBLING of the
// conversation workspace, so the seeded `session-workspace` fs rule (rooted at
// the conversation's own working directory) does not contain a lease path. The
// auto-approval of lease-targeted fs calls comes from the policy fallback
// instead: under `prompt`, `decideByPolicy` approves an fs request whose target
// sits in ANY of `workspaceRoots` — which `workspaceRootsFor` populates with
// every held lease. This pins that behavior under `auto-deny` (so it is not
// the auto-approve approval-mode override doing the work).

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { PortalEvent } from '../src/lib/types';
import type { ProviderOpenOptions } from '../src/lib/server/providers/provider';
import { resetConfigForTests } from '../src/lib/server/config';
import { resetServerSingletons, setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

const { ensureClaudeAgentSkillsMock, queryMock } = vi.hoisted(() => ({
	ensureClaudeAgentSkillsMock: vi.fn(async () => []),
	queryMock: vi.fn()
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>();
	return { ...actual, query: queryMock };
});

vi.mock('../src/lib/server/providers/claude-agent-skills', () => ({
	ensureClaudeAgentSkills: ensureClaudeAgentSkillsMock
}));

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function committedRepository(): string {
	const source = makeTmpDir('portal-claude-lease-');
	git(source, ['init', '-q', '-b', 'main']);
	git(source, ['config', 'user.name', 'Portal Test']);
	git(source, ['config', 'user.email', 'portal-test@localhost']);
	writeFileSync(join(source, 'README.md'), 'base\n');
	git(source, ['add', 'README.md']);
	git(source, ['commit', '-q', '-m', 'initial']);
	return source;
}

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

describe('claudeAgentProvider fs permissions inside worktree leases', () => {
	let source: string;
	let userId: string;
	let conversationId: string;
	let leaseId: string;
	let leasePath: string;

	beforeEach(async () => {
		const dataDir = await setupLocalEnv('portal-claude-lease-');
		source = committedRepository();
		process.env.PROJECT_ROOT = source;
		process.env.WORKTREE_ROOT = join(dataDir, 'worktrees');
		process.env.CLAUDE_AGENT_API_KEY = 'deepseek-key';
		process.env.CLAUDE_AGENT_BASE_URL = 'https://api.deepseek.com/anthropic';
		await resetServerSingletons();
		vi.resetModules();

		const users = await import('../src/lib/server/db/repos/users');
		userId = users.ensureLocalUser().id;
		const convs = await import('../src/lib/server/db/repos/conversations');
		conversationId = convs.create(userId, {
			id: convs.newId(),
			title: 'orchestrator',
			workdir: source,
			model: 'test-model',
			workspaceKind: 'shared',
			workspaceKey: source
		}).id;

		const { buildWorktreeTools } = await import('../src/lib/server/tools/worktree');
		const worktreeTools = new Map(
			buildWorktreeTools({ userId, conversationId }).map((t) => [t.name, t])
		);
		const created = await worktreeTools.get('worktree_create')!.handler({ label: 'api' });
		if (!created.ok) throw new Error(`worktree_create failed: ${created.error.message}`);
		leaseId = (created.result as { leaseId: string }).leaseId;
		leasePath = (created.result as { path: string }).path;
	});

	afterEach(() => {
		delete process.env.CLAUDE_AGENT_API_KEY;
		delete process.env.CLAUDE_AGENT_BASE_URL;
		delete process.env.PROJECT_ROOT;
		delete process.env.WORKTREE_ROOT;
		resetConfigForTests();
		vi.restoreAllMocks();
	});

	it('auto-approves create_directory in both the workspace and a held lease', async () => {
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
		const opts: ProviderOpenOptions = {
			provider: 'claude-agent',
			conversationId,
			userId,
			workingDirectory: source,
			model: 'deepseek-v4-pro',
			policy: 'prompt',
			approvalMode: 'auto-deny'
		};
		const session = await claudeAgentProvider.openSession(opts);
		await collect(session.send('touch', new AbortController().signal));

		const inWorkspace = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'mcp__portal__create_directory',
			tool_input: { path: 'newdir' },
			tool_use_id: 'tool-ws'
		});
		expect(inWorkspace).toEqual(
			expect.objectContaining({
				hookSpecificOutput: expect.objectContaining({ permissionDecision: 'allow' })
			})
		);

		// Identical call, same relative path, but the `worktree` selector makes
		// the derived target live under WORKTREE_ROOT/<user>/leases/<id> — a
		// sibling of the conversation workspace. The `session-workspace` seed
		// does not contain it, but the policy fallback approves any fs target
		// inside a held lease (workspaceRootsFor), so it still auto-allows —
		// even under `auto-deny`, which proves the approval is not the
		// auto-approve approval-mode override.
		const inLease = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'mcp__portal__create_directory',
			tool_input: { path: 'newdir', worktree: leaseId },
			tool_use_id: 'tool-lease'
		});
		expect(inLease).toEqual(
			expect.objectContaining({
				hookSpecificOutput: expect.objectContaining({ permissionDecision: 'allow' })
			})
		);

		// Portal fs tools pointed at the lease auto-approve too — the paths a
		// sub-agent handed a lease path actually reads and searches.
		const readLease = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'mcp__portal__read',
			tool_input: { file_path: join(leasePath, 'README.md') },
			tool_use_id: 'tool-lease-read'
		});
		expect(readLease).toEqual(
			expect.objectContaining({
				hookSpecificOutput: expect.objectContaining({ permissionDecision: 'allow' })
			})
		);

		const globLease = await preToolUse!({
			hook_event_name: 'PreToolUse',
			tool_name: 'mcp__portal__glob',
			tool_input: { pattern: '**/*.md', path: leasePath },
			tool_use_id: 'tool-lease-glob'
		});
		expect(globLease).toEqual(
			expect.objectContaining({
				hookSpecificOutput: expect.objectContaining({ permissionDecision: 'allow' })
			})
		);
	});
});
