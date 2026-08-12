import { describe, expect, it, beforeAll } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
	InteractivePermissionView,
	InteractiveRequestView,
	InteractiveResponse,
	PortalEvent
} from '../src/lib/types';
import type { PortalTool } from '../src/lib/server/tools/types';
import type { ProviderOpenOptions } from '../src/lib/server/pi/session-contract';
import { setupLocalEnv } from './helpers/env';
import { makeTmpDir } from './helpers/tmp';

// E2E for the pi permission gate: the stub model emits a `PI_TEST_TOOLCALL`
// directive, the pi session executes the named portal custom tool, and the gate
// (session.ts bridge -> permission-gate.ts) settles allow/block against grants,
// policy, approval mode, and interactive prompts. Every tool call also asserts
// the portal timeline pairing (tool.call then tool.result), which is the shape
// the turn-runner persists.
//
// The stub is stateless: once the model has emitted a tool call, the follow-up
// request replies with text, so each turn terminates after the tool runs.
//
// Grant isolation: grants are seeded conversation-scoped (each test creates its
// own conversation row), so one test's allow/deny grant can't leak into the
// next. `ticket_detach` is deliberately NOT in the user-global seed grants, so
// it is the workhorse for gate paths that must start from "nothing matches"
// (prompt / deny-all / auto-deny); `ticket_list` IS seeded and only used where
// a success envelope is asserted.

let USER = 1;
let convSeq = 0;

async function openSession(
	wd: string,
	conversationId: number,
	opts: Partial<ProviderOpenOptions> = {}
) {
	const { openPiSession } = await import('../src/lib/server/pi');
	const bridge: ProviderOpenOptions = {
		conversationId,
		userId: USER,
		workingDirectory: wd,
		model: 'stub',
		policy: 'prompt',
		...opts
	};
	return openPiSession(bridge);
}

// A fresh conversation row whose workdir is the test's tmpdir: grants can be
// seeded against it (FK), and the gate's workspaceRootsFor resolves to [wd].
async function createConversation(wd: string): Promise<number> {
	const { create } = await import('../src/lib/server/db/repos/conversations');
	const conv = create(USER, { title: `pi-gate-${convSeq++}`, workdir: wd, model: null });
	return conv.id;
}

interface ToolCallOutcome {
	call: PortalEvent & { type: 'tool.call' };
	result: PortalEvent & { type: 'tool.result' };
	prompts: InteractivePermissionView[];
}

// Run a single tool-call turn, optionally resolving any interactive prompts as
// they surface (the send() stream stalls on the gate's await otherwise).
async function runToolCall(
	session: Awaited<ReturnType<typeof openSession>>,
	toolName: string,
	args: unknown,
	onPrompt?: (view: InteractiveRequestView) => InteractiveResponse | undefined
): Promise<ToolCallOutcome> {
	const { resolve } = await import('../src/lib/server/runtime/interactive-requests');
	const ac = new AbortController();
	const events: PortalEvent[] = [];
	const prompts: InteractivePermissionView[] = [];
	for await (const ev of session.send(
		`PI_TEST_TOOLCALL ${toolName} ${JSON.stringify(args)}`,
		ac.signal
	)) {
		if (ev.type === 'interactive.request' && ev.request.kind === 'permission') {
			prompts.push(ev.request);
			const response = onPrompt?.(ev.request);
			if (response) resolve(ev.request.requestId, USER, response);
		}
		events.push(ev);
	}
	await session.dispose();
	const call = events.find(
		(e): e is PortalEvent & { type: 'tool.call' } => e.type === 'tool.call' && e.tool === toolName
	);
	if (!call)
		throw new Error(
			`no tool.call for ${toolName} — events: ${events.map((e) => e.type).join(',')}`
		);
	const result = events.find(
		(e): e is PortalEvent & { type: 'tool.result' } =>
			e.type === 'tool.result' && e.toolCallId === call.toolCallId
	);
	if (!result) throw new Error(`no tool.result for ${toolName}`);
	return { call, result, prompts };
}

// The gate lets a call through by running the handler (its `output` carries the
// serialized portal envelope); a blocked call has no envelope output. Used to
// assert allow/block without depending on whether the handler itself succeeds.
function ran(result: ToolCallOutcome['result']): boolean {
	return typeof result.output === 'string';
}

const T = 30_000;

describe('pi tool calls + permission gate', () => {
	beforeAll(async () => {
		process.env.PI_STUB = '1';
		await setupLocalEnv('pi-tool-gate-');
		const { resetConfigForTests } = await import('../src/lib/server/config');
		resetConfigForTests();
		const { ensureLocalUser } = await import('../src/lib/server/db/repos/users');
		USER = ensureLocalUser().id;
	});

	it(
		'executes a portal custom tool through the pi session and streams the envelope',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			const convId = await createConversation(wd);
			const session = await openSession(wd, convId);
			const { call, result } = await runToolCall(session, 'ticket_list', {});
			expect(call.args).toEqual({});
			expect(result.ok).toBe(true);
			expect(result.summary).toBe('No open tickets.');
			// The serialized portal envelope rides the `output` channel.
			expect(typeof result.output).toBe('string');
			expect(JSON.parse(result.output as string)).toMatchObject({ ok: true });
		},
		T
	);

	it(
		'runs without prompting when an allow grant matches',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			const convId = await createConversation(wd);
			const { addGrant } = await import('../src/lib/server/db/repos/settings');
			addGrant({
				userId: USER,
				conversationId: convId,
				tool: 'ticket_detach',
				permissionKind: 'custom-tool',
				scope: { kind: 'any' },
				decision: 'allow'
			});
			const session = await openSession(wd, convId);
			const { result, prompts } = await runToolCall(session, 'ticket_detach', {
				ticketId: 'no-such-ticket',
				attachmentId: 'no-such-attachment'
			});
			expect(ran(result)).toBe(true);
			expect(prompts.length).toBe(0);
		},
		T
	);

	it(
		'blocks with the deny feedback when a deny grant matches',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			const convId = await createConversation(wd);
			const { addGrant } = await import('../src/lib/server/db/repos/settings');
			addGrant({
				userId: USER,
				conversationId: convId,
				tool: 'ticket_detach',
				permissionKind: 'custom-tool',
				scope: { kind: 'any' },
				decision: 'deny',
				denyReason: 'tests deny ticket detach'
			});
			const session = await openSession(wd, convId);
			const { result, prompts } = await runToolCall(session, 'ticket_detach', {
				ticketId: 'no-such-ticket',
				attachmentId: 'no-such-attachment'
			});
			expect(ran(result)).toBe(false);
			expect(result.summary).toContain('tests deny ticket detach');
			expect(prompts.length).toBe(0);
		},
		T
	);

	it(
		'deny-all policy blocks every tool without prompting',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			const convId = await createConversation(wd);
			const session = await openSession(wd, convId, { policy: 'deny-all' });
			const { result, prompts } = await runToolCall(session, 'ticket_detach', {
				ticketId: 'no-such-ticket',
				attachmentId: 'no-such-attachment'
			});
			expect(ran(result)).toBe(false);
			expect(prompts.length).toBe(0);
		},
		T
	);

	it(
		'allow-all policy runs every tool without prompting',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			const convId = await createConversation(wd);
			const session = await openSession(wd, convId, { policy: 'allow-all' });
			const { result, prompts } = await runToolCall(session, 'ticket_detach', {
				ticketId: 'no-such-ticket',
				attachmentId: 'no-such-attachment'
			});
			expect(ran(result)).toBe(true);
			expect(prompts.length).toBe(0);
		},
		T
	);

	it(
		'fs-kind requests inside the workspace auto-approve under prompt policy',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			writeFileSync(join(wd, 'notes.txt'), 'hello\n');
			const convId = await createConversation(wd);
			const session = await openSession(wd, convId);
			const { result, prompts } = await runToolCall(session, 'read_file', { path: 'notes.txt' });
			expect(result.ok).toBe(true);
			expect(prompts.length).toBe(0);
		},
		T
	);

	it(
		'fs-kind requests outside the workspace are NOT auto-approved (gate-level)',
		async () => {
			// No portal tool can derive an out-of-workspace target (the tool layer
			// rejects absolute/escaping paths before the gate), so this drives the
			// gate directly with a synthetic fs tool: an in-workspace target
			// auto-approves, an out-of-workspace target raises a prompt.
			const wd = makeTmpDir('pi-gate-');
			const outside = makeTmpDir('pi-gate-out-');
			const fsConvId = await createConversation(wd);
			const { createPiPermissionResolver } = await import('../src/lib/server/pi/permission-gate');
			const { ok } = await import('../src/lib/server/tools/types');
			const tool: PortalTool = {
				name: 'synthetic_edit',
				description: 'test',
				parameters: {},
				derivePermissionRequest: (args) => {
					const path = (args as { path?: string }).path;
					return path ? { permissionKind: 'edit', path } : null;
				},
				handler: async () => ok('edited')
			};
			const emitted: InteractiveRequestView[] = [];
			const resolver = createPiPermissionResolver({
				userId: USER,
				conversationId: fsConvId,
				workingDirectory: wd,
				policy: 'prompt',
				portalToolsByName: new Map([['synthetic_edit', tool]]),
				getApprovalMode: () => 'ask',
				getWorkspaceRoots: () => [wd],
				emit: (ev) => {
					if (ev.type === 'interactive.request') emitted.push(ev.request);
				}
			});

			// In-workspace: no prompt, auto-approved by policy.
			const inCall = await resolver('synthetic_edit', { path: join(wd, 'x.txt') }, 'c-in');
			expect(inCall.allow).toBe(true);
			expect(emitted.length).toBe(0);

			// Out-of-workspace: NOT auto-approved — a prompt is raised, and its
			// resolution is honored.
			const { resolve } = await import('../src/lib/server/runtime/interactive-requests');
			const outCall = resolver('synthetic_edit', { path: join(outside, 'x.txt') }, 'c-out');
			expect(emitted.length).toBe(1);
			const allowed = await new Promise<{ allow: boolean }>((done) => {
				resolve(emitted[0].requestId, USER, { kind: 'permission', decision: 'allow-once' });
				void outCall.then((d) => done(d));
			});
			expect(allowed.allow).toBe(true);
		},
		T
	);

	it(
		'ungranted custom-tool raises an interactive request and honors resolution',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			const convId = await createConversation(wd);
			const session = await openSession(wd, convId);
			const { result, prompts } = await runToolCall(
				session,
				'ticket_detach',
				{ ticketId: 'no-such-ticket', attachmentId: 'no-such-attachment' },
				(view) =>
					view.kind === 'permission' ? { kind: 'permission', decision: 'allow-once' } : undefined
			);
			expect(prompts.length).toBe(1);
			expect(prompts[0].tool).toBe('ticket_detach');
			expect(prompts[0].canPersistDecision).toBe(true);
			expect(ran(result)).toBe(true);
		},
		T
	);

	it(
		'a denied resolution blocks the tool call',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			const convId = await createConversation(wd);
			const session = await openSession(wd, convId);
			const { result, prompts } = await runToolCall(
				session,
				'ticket_detach',
				{ ticketId: 'no-such-ticket', attachmentId: 'no-such-attachment' },
				(view) =>
					view.kind === 'permission'
						? { kind: 'permission', decision: 'deny', feedback: 'the test denies it' }
						: undefined
			);
			expect(prompts.length).toBe(1);
			expect(ran(result)).toBe(false);
			expect(result.summary).toContain('the test denies it');
		},
		T
	);

	it(
		'auto-deny approval mode blocks without prompting; auto-approve allows',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			const deniedConv = await createConversation(wd);
			const denied = await openSession(wd, deniedConv, { approvalMode: 'auto-deny' });
			const blocked = await runToolCall(denied, 'ticket_detach', {
				ticketId: 'no-such-ticket',
				attachmentId: 'no-such-attachment'
			});
			expect(ran(blocked.result)).toBe(false);
			expect(blocked.prompts.length).toBe(0);

			const allowedConv = await createConversation(wd);
			const allowed = await openSession(wd, allowedConv, { approvalMode: 'auto-approve' });
			const ran2 = await runToolCall(allowed, 'ticket_detach', {
				ticketId: 'no-such-ticket',
				attachmentId: 'no-such-attachment'
			});
			expect(ran(ran2.result)).toBe(true);
			expect(ran2.prompts.length).toBe(0);
		},
		T
	);

	it(
		'a disabled tool group removes its tools from the pi customTools',
		async () => {
			const wd = makeTmpDir('pi-gate-');
			const convId = await createConversation(wd);
			const session = await openSession(wd, convId, {
				policy: 'allow-all',
				disabledToolGroups: ['tickets']
			});
			const { result, prompts } = await runToolCall(session, 'ticket_detach', {
				ticketId: 'no-such-ticket',
				attachmentId: 'no-such-attachment'
			});
			// The tool never reaches pi's registry (group filtered before assembly),
			// so pi errors natively — the point is it's blocked, not allowed.
			expect(ran(result)).toBe(false);
			expect(result.summary).toContain('not found');
			expect(prompts.length).toBe(0);
		},
		T
	);
});
