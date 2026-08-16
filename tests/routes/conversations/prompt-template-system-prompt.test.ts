import { describe, expect, it, beforeEach } from 'vitest';
import { setupLocalEnv } from '../../helpers/env';
import { makeTmpDir } from '../../helpers/tmp';

// Ticket #41 — template systemPrompt / appendSystemPrompt (unified: chat +
// ticket-action). Covers the three layers:
//   1. storage + surfacing (template_create/update/get/list tools),
//   2. launch seeding (conversation-create copies the template's fields onto
//      the conversation row so the first turn's session sees them),
//   3. pi session wiring (the `DefaultResourceLoader` gets
//      `systemPrompt` / `appendSystemPrompt` from the conversation, driving
//      the session's effective system prompt).

const BASE_IDENTITY = 'You are an expert coding assistant operating inside pi';

/** Result payload of a portal tool handler call, or undefined when it failed. */
function resultOf<T>(r: { ok: boolean; result?: unknown }): T | undefined {
	return r.ok ? (r.result as T) : undefined;
}

async function setupTools() {
	await setupLocalEnv('portal-sysprompt-');
	const users = await import('../../../src/lib/server/db/repos/users');
	const { buildPromptTemplateTools } =
		await import('../../../src/lib/server/tools/prompt-templates');
	const user = users.ensureLocalUser();
	const tools = buildPromptTemplateTools({ userId: user.id });
	const byName = (n: string) => tools.find((t) => t.name === n)!;
	return { user, byName };
}

describe('prompt-template system-prompt fields', () => {
	beforeEach(async () => {
		await setupLocalEnv('portal-sysprompt-');
	});

	it('template_create stores systemPrompt + appendSystemPrompt on chat and ticket-action', async () => {
		const { byName } = await setupTools();
		const created = await byName('template_create').handler({
			type: 'chat',
			title: 'Storyteller',
			prompt: 'Write an opening scene about a lighthouse keeper.',
			systemPrompt: 'You are a storyteller.',
			appendSystemPrompt: 'Write with vivid imagery.'
		});
		expect(created.ok).toBe(true);
		const id = created.ok && (created.result as { id: number }).id;

		const got = await byName('template_get').handler({ id: String(id) });
		const row = resultOf<Record<string, unknown>>(got);
		expect(row?.systemPrompt).toBe('You are a storyteller.');
		expect(row?.appendSystemPrompt).toBe('Write with vivid imagery.');
		expect(row?.prompt).toBe('Write an opening scene about a lighthouse keeper.');

		// The compact list view surfaces both fields too.
		const listed = await byName('template_list').handler({});
		const rows = resultOf<{ templates: Record<string, unknown>[] }>(listed)?.templates ?? [];
		const hit = rows.find((t) => t.id === id);
		expect(hit?.systemPrompt).toBe('You are a storyteller.');
		expect(hit?.appendSystemPrompt).toBe('Write with vivid imagery.');

		// Ticket-action templates share the same field surface (unified model).
		const tia = await byName('template_create').handler({
			type: 'ticket-action',
			title: 'Do',
			prompt: 'Do this workspace ticket: {{ticket.title}}',
			systemPrompt: 'You are a meticulous implementer.'
		});
		expect(tia.ok).toBe(true);
		const tiaId = tia.ok && (tia.result as { id: number }).id;
		const tiaGot = await byName('template_get').handler({ id: String(tiaId) });
		expect(resultOf<{ systemPrompt: string }>(tiaGot)?.systemPrompt).toBe(
			'You are a meticulous implementer.'
		);
	});

	it('template_update sets and clears the system-prompt fields', async () => {
		const { byName } = await setupTools();
		const created = await byName('template_create').handler({
			title: 'Base',
			prompt: 'Do the thing.'
		});
		const id = created.ok && (created.result as { id: number }).id;

		const set = await byName('template_update').handler({
			id: String(id),
			systemPrompt: 'You are a poet.',
			appendSystemPrompt: 'Rhyme when possible.'
		});
		expect(set.ok).toBe(true);
		const got = resultOf<Record<string, unknown>>(
			await byName('template_get').handler({ id: String(id) })
		);
		expect(got?.systemPrompt).toBe('You are a poet.');
		expect(got?.appendSystemPrompt).toBe('Rhyme when possible.');

		// null clears the field back to absent.
		const cleared = await byName('template_update').handler({
			id: String(id),
			systemPrompt: null
		});
		expect(cleared.ok).toBe(true);
		const after = resultOf<Record<string, unknown>>(
			await byName('template_get').handler({ id: String(id) })
		);
		expect(after?.systemPrompt).toBeUndefined();
		expect(after?.appendSystemPrompt).toBe('Rhyme when possible.');
	});

	it('launch seeds the conversation row with the template system fields', async () => {
		await setupLocalEnv('portal-sysprompt-');
		const users = await import('../../../src/lib/server/db/repos/users');
		const templates = await import('../../../src/lib/server/db/repos/prompt-templates');
		const { POST } = await import('../../../src/routes/api/conversations/+server');
		const user = users.ensureLocalUser();
		const tpl = templates.create(user.id, {
			title: 'Storyteller',
			prompt: 'Write an opening scene about a lighthouse keeper.',
			systemPrompt: 'You are a storyteller.',
			appendSystemPrompt: 'Write with vivid imagery.'
		});

		const res = await POST({
			locals: { userId: user.id, user: { githubLogin: 'local' } },
			request: new Request('http://localhost/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Story chat', promptTemplateId: tpl.id })
			}),
			getClientAddress: () => '127.0.0.1'
		} as unknown as Parameters<typeof POST>[0]);
		const body = await (res as Response).json();
		expect(body.conversation.systemPrompt).toBe('You are a storyteller.');
		expect(body.conversation.appendSystemPrompt).toBe('Write with vivid imagery.');
	});

	it('launch seeds null system fields when the template sets none (regression)', async () => {
		await setupLocalEnv('portal-sysprompt-');
		const users = await import('../../../src/lib/server/db/repos/users');
		const templates = await import('../../../src/lib/server/db/repos/prompt-templates');
		const { POST } = await import('../../../src/routes/api/conversations/+server');
		const user = users.ensureLocalUser();
		const tpl = templates.create(user.id, {
			title: 'Plain',
			prompt: 'Do the thing.'
		});

		const res = await POST({
			locals: { userId: user.id, user: { githubLogin: 'local' } },
			request: new Request('http://localhost/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Plain chat', promptTemplateId: tpl.id })
			}),
			getClientAddress: () => '127.0.0.1'
		} as unknown as Parameters<typeof POST>[0]);
		const body = await (res as Response).json();
		expect(body.conversation.systemPrompt).toBeNull();
		expect(body.conversation.appendSystemPrompt).toBeNull();

		// No template at all — same nulls.
		const plain = await POST({
			locals: { userId: user.id, user: { githubLogin: 'local' } },
			request: new Request('http://localhost/api/conversations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Blank' })
			}),
			getClientAddress: () => '127.0.0.1'
		} as unknown as Parameters<typeof POST>[0]);
		const plainBody = await (plain as Response).json();
		expect(plainBody.conversation.systemPrompt).toBeNull();
		expect(plainBody.conversation.appendSystemPrompt).toBeNull();
	});
});

describe('pi session system-prompt wiring (stub)', () => {
	async function openSystemPromptSession(opts: {
		systemPrompt?: string;
		appendSystemPrompt?: string;
	}): Promise<string> {
		const wd = makeTmpDir('sysprompt-wd-');
		await setupLocalEnv('sysprompt-pi-');
		process.env.PI_STUB = '1';
		const { resetConfigForTests } = await import('../../../src/lib/server/config');
		resetConfigForTests();
		const { getModelRuntime } = await import('../../../src/lib/server/pi');
		const { getStubModel } = await import('../../../src/lib/server/pi/stub-server');
		const { createPiSession } = await import('../../../src/lib/server/pi/session');
		const runtime = await getModelRuntime();
		const model = (await getStubModel(runtime))!;
		const session = await createPiSession({
			cwd: wd,
			model,
			runtime,
			customTools: [],
			portalToolsByName: new Map(),
			permissionResolver: async () => ({ allow: false }),
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.appendSystemPrompt !== undefined
				? { appendSystemPrompt: opts.appendSystemPrompt }
				: {})
		});
		const effective = session.systemPrompt;
		await session.dispose();
		return effective;
	}

	it('replaces the default identity when systemPrompt is set (Template A/B)', async () => {
		const sp = await openSystemPromptSession({ systemPrompt: 'You are a storyteller.' });
		expect(sp).toContain('storyteller');
		expect(sp).not.toContain(BASE_IDENTITY);
	});

	it('appends under the active identity when appendSystemPrompt is set (Template C)', async () => {
		const sp = await openSystemPromptSession({
			appendSystemPrompt: 'You are a storyteller.'
		});
		expect(sp).toContain(BASE_IDENTITY);
		expect(sp).toContain('storyteller');
		// Appended under the base — the persona text appears after the identity block.
		expect(sp.indexOf('storyteller')).toBeGreaterThan(sp.indexOf('coding assistant'));
	});

	it('composes replace-then-append when both are set', async () => {
		const sp = await openSystemPromptSession({
			systemPrompt: 'You are a storyteller.',
			appendSystemPrompt: 'Write with vivid imagery.'
		});
		expect(sp).toContain('storyteller');
		expect(sp).toContain('vivid imagery');
		expect(sp).not.toContain(BASE_IDENTITY);
	});

	it('keeps the default identity when neither field is set (Template E regression)', async () => {
		const sp = await openSystemPromptSession({});
		expect(sp).toContain(BASE_IDENTITY);
	});
});
