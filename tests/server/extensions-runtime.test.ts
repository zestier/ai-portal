import { describe, expect, it, beforeAll } from 'vitest';
import { conversationId as conversationIdCodec } from '../../src/lib/ids';
import type { PortalEvent } from '../../src/lib/types';
import type { ProviderOpenOptions } from '../../src/lib/server/pi/session-contract';
import { setupLocalEnv } from '../helpers/env';
import { makeTmpDir } from '../helpers/tmp';

// E2E for the operator-managed extension runtime path (AC3): an inline
// extension registered via the portal repo is materialized and loaded into the
// pi session through `additionalExtensionPaths`, and its custom tool executes
// through the stub model (`PI_TEST_TOOLCALL <tool> <args>`), gated by the
// permission bridge (extension tools pass — the operator trusted them).
//
// The stub is stateless: once the model has emitted a tool call, the follow-up
// request replies with text, so each turn terminates after the tool runs.

let USER = 1;
let convSeq = 0;

async function openSession(
	wd: string,
	conversationId: string | number,
	opts: Partial<ProviderOpenOptions> = {}
) {
	const { openPiSession } = await import('../../src/lib/server/pi');
	const bridge: ProviderOpenOptions = {
		conversationId:
			typeof conversationId === 'number'
				? conversationId
				: conversationIdCodec.parse(conversationId),
		userId: USER,
		workingDirectory: wd,
		model: 'stub',
		policy: 'prompt',
		...opts
	};
	return openPiSession(bridge);
}

async function createConversation(wd: string): Promise<string> {
	const { create } = await import('../../src/lib/server/db/repos/conversations');
	const conv = create(USER, { title: `pi-ext-${convSeq++}`, workdir: wd, model: null });
	return conv.id;
}

async function runToolCall(
	session: Awaited<ReturnType<typeof openSession>>,
	toolName: string,
	args: unknown
): Promise<{
	call: PortalEvent & { type: 'tool.call' };
	result: PortalEvent & { type: 'tool.result' };
}> {
	const ac = new AbortController();
	const events: PortalEvent[] = [];
	for await (const ev of session.send(
		`PI_TEST_TOOLCALL ${toolName} ${JSON.stringify(args)}`,
		ac.signal
	)) {
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
	return { call, result };
}

const T = 30_000;

describe('pi extensions runtime (inline custom tool)', () => {
	beforeAll(async () => {
		process.env.PI_STUB = '1';
		await setupLocalEnv('pi-ext-runtime-');
		const { resetConfigForTests } = await import('../../src/lib/server/config');
		resetConfigForTests();
		const { ensureLocalUser } = await import('../../src/lib/server/db/repos/users');
		USER = ensureLocalUser().id;
	});

	it(
		'runs an inline extension custom tool via PI_TEST_TOOLCALL',
		async () => {
			const wd = makeTmpDir('pi-ext-');
			const convId = await createConversation(wd);
			const { create } = await import('../../src/lib/server/db/repos/extensions');
			create(USER, {
				name: 'ping',
				kind: 'inline',
				enabled: true,
				value: `import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function pingExt(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'portal_ping',
		label: 'portal_ping',
		description: 'Ping the portal from an extension tool.',
		parameters: { type: 'object', properties: {} },
		async execute() {
			return { content: [{ type: 'text', text: 'pong' }] };
		}
	});
}`
			});

			const session = await openSession(wd, convId);
			const { call, result } = await runToolCall(session, 'portal_ping', {});
			expect(call.args).toEqual({});
			// The extension tool ran (not blocked) and produced its result.
			expect(result.ok).toBe(true);
			expect(result.summary).toContain('pong');
		},
		T
	);
});
