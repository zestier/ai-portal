import { test, expect } from './helpers/fixtures';
import {
	createConversation,
	getConversation,
	messagesOf,
	uniqueTitle,
	waitForAssistantMessage
} from './helpers/conversations';

/**
 * End-to-end fork (edit-and-retry) flow:
 *  1. Send a message in a conversation; the stub replies. A pre-snapshot
 *     is captured server-side for the user message.
 *  2. POST /messages/:id/fork with new content to fork from that user
 *     message.
 *  3. Verify the new conversation has the edited prompt, automatically gets
 *     a fresh stubbed reply, and the source conversation is untouched.
 */
test('fork by editing a user message produces a new conversation with the edited prompt', async ({
	page,
	request
}) => {
	const sourceId = await createConversation(request, uniqueTitle('Source'));

	// Drive the first turn through the UI so the server captures the
	// pre-snapshot (the POST /turns endpoint is what calls snapshot()).
	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message…/);
	await composer.click();
	await composer.fill('context seed');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: context seed');
	await expect(page.getByText('Stubbed reply to: context seed').first()).toBeVisible();
	await composer.click();
	await composer.fill('original prompt');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: original prompt');
	await expect(page.getByText('Stubbed reply to: original prompt').first()).toBeVisible();

	// Wait for the turn to finalize so this fork auto-starts (an edit-fork
	// only auto-runs when the source is idle; while it's busy the fork defers
	// and prefills the composer instead).
	const msgs = await getConversation(request, sourceId);
	const userMsg = (messagesOf(msgs) as Array<{ id: string; role: string; content: string }>).find(
		(m) => m.role === 'user' && m.content === 'original prompt'
	);
	expect(userMsg).toBeDefined();

	// Fork with new content.
	const forkRes = await request.post(
		`/api/conversations/${sourceId}/messages/${userMsg!.id}/fork`,
		{ data: { content: 'edited prompt' } }
	);
	expect(forkRes.ok()).toBeTruthy();
	const { conversationId: newId } = await forkRes.json();
	expect(typeof newId).toBe('number');
	expect(newId).not.toBe(sourceId);

	await waitForAssistantMessage(request, newId, /edited prompt/);
	const newMsgs = await getConversation(request, newId);
	const contents = (newMsgs.messages as Array<{ role: string; content: string }>).map(
		(m) => `${m.role}:${m.content}`
	);
	// The fork clones the prefix (context seed + its reply) and appends the
	// edited prompt, then auto-runs a fresh turn.
	expect(contents).toContain('user:context seed');
	expect(contents).toContain('assistant:Stubbed reply to: context seed');
	expect(contents).toContain('user:edited prompt');
	// The rerun prompts with the raw edited content (no injected prior
	// transcript — prior context rides the forked conversation's history and the
	// pi session tree), so the stub echoes exactly the edited prompt.
	expect(contents).toContain('assistant:Stubbed reply to: edited prompt');
	expect(contents).not.toContain('user:original prompt');

	// Source conversation still has the original turn intact.
	const srcMsgs = await getConversation(request, sourceId);
	const srcContents = (messagesOf(srcMsgs) as Array<{ role: string; content: string }>).map(
		(m) => m.content
	);
	expect(srcContents).toContain('original prompt');
	expect(srcContents).toContain('Stubbed reply to: original prompt');
});

test('edit-fork while the source turn is running defers and prefills the new composer', async ({
	page,
	request
}) => {
	const sourceId = await createConversation(request, uniqueTitle('Busy Source'));

	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message…/);
	await composer.click();
	await composer.fill('first');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first');
	await expect(page.getByText('Stubbed reply to: first').first()).toBeVisible();

	// Grab the first user message id before kicking off a long-running turn.
	const msgs = await getConversation(request, sourceId);
	const firstUser = (messagesOf(msgs) as Array<{ id: string; role: string; content: string }>).find(
		(m) => m.role === 'user' && m.content === 'first'
	);
	expect(firstUser).toBeDefined();

	// @trigger-slow-start holds the stub before its first delta, so the source
	// turn sits in the running state long enough to fork against it.
	await composer.fill('@trigger-slow-start second');
	await composer.press('Enter');
	await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();

	// Fork-edit an earlier user message while the source turn is still running.
	const forkRes = await request.post(
		`/api/conversations/${sourceId}/messages/${firstUser!.id}/fork`,
		{ data: { content: 'first edited while busy' } }
	);
	expect(forkRes.ok()).toBeTruthy();
	const body = await forkRes.json();
	expect(body.deferred).toBe(true);
	const newId = body.conversationId as string;
	expect(newId).not.toBe(sourceId);

	// Deferred: no turn was auto-started, so the fork holds only the cloned
	// prefix (here: nothing before the first user message) — no user row, no reply.
	const newMsgs = await getConversation(request, newId);
	expect((newMsgs.messages as unknown[]).length).toBe(0);

	// Navigating to the fork seeds the persisted draft into the composer so the
	// user can press Send to start the turn themselves.
	await page.goto(`/conversations/${newId}`);
	await expect(page.getByPlaceholder(/Message…/)).toHaveValue('first edited while busy');

	// And it survives a reload (the draft is persisted on the conversation row).
	await page.reload();
	await expect(page.getByPlaceholder(/Message…/)).toHaveValue('first edited while busy');
});

test('deferred edit-fork of a non-first message seeds the composer, then clears after Send', async ({
	page,
	request
}) => {
	const sourceId = await createConversation(request, uniqueTitle('Busy Source Mid'));

	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message…/);
	await composer.click();
	await composer.fill('first');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first');

	// A second completed turn, so the message we edit has a non-empty prefix
	// (this is what regressed: the fork is created with cloned prior messages,
	// so the composer must be seeded even though `msgs.length > 0`).
	await composer.fill('second');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: second');
	await expect(page.getByText('Stubbed reply to: second').first()).toBeVisible();

	const msgs = await getConversation(request, sourceId);
	const secondUser = (
		messagesOf(msgs) as Array<{ id: string; role: string; content: string }>
	).find((m) => m.role === 'user' && m.content === 'second');
	expect(secondUser).toBeDefined();

	// Hold a third turn open so the source is busy when we fork.
	await composer.fill('@trigger-slow-start third');
	await composer.press('Enter');
	await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible();

	const forkRes = await request.post(
		`/api/conversations/${sourceId}/messages/${secondUser!.id}/fork`,
		{ data: { content: 'second edited while busy' } }
	);
	expect(forkRes.ok()).toBeTruthy();
	const body = await forkRes.json();
	expect(body.deferred).toBe(true);
	const newId = body.conversationId as string;

	// The fork carries the cloned prefix (user:first + its reply), so it is NOT
	// empty — yet the persisted draft must still seed the composer.
	const newMsgs = await getConversation(request, newId);
	expect((newMsgs.messages as unknown[]).length).toBeGreaterThan(0);

	const forkComposer = page.getByPlaceholder(/Message…/);
	await page.goto(`/conversations/${newId}`);
	await expect(forkComposer).toHaveValue('second edited while busy');

	// Sending the draft starts the turn and clears it; a later reload must not
	// re-seed the stale draft.
	await forkComposer.press('Enter');
	await waitForAssistantMessage(request, newId, 'Stubbed reply to: second edited while busy');
	await page.reload();
	await expect(forkComposer).toHaveValue('');
});

test('retry from an assistant message clones up to it without a new user prompt', async ({
	page,
	request
}) => {
	const sourceId = await createConversation(request, uniqueTitle('Source'));

	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message…/);
	await composer.click();
	await composer.fill('first');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first');
	await expect(page.getByText('Stubbed reply to: first').first()).toBeVisible();

	const msgs = await getConversation(request, sourceId);
	const assistantMsg = (
		messagesOf(msgs) as Array<{ id: string; role: string; content: string }>
	).find((m) => m.role === 'assistant');
	expect(assistantMsg).toBeDefined();

	const forkRes = await request.post(
		`/api/conversations/${sourceId}/messages/${assistantMsg!.id}/fork`,
		{ data: {} }
	);
	expect(forkRes.ok()).toBeTruthy();
	const { conversationId: newId } = await forkRes.json();

	const newMsgs = await getConversation(request, newId);
	const list = newMsgs.messages as Array<{ role: string; content: string }>;
	// Cloned: user "first" + assistant reply. No new user message yet.
	expect(list).toHaveLength(2);
	expect(list[0]).toMatchObject({ role: 'user', content: 'first' });
	expect(list[1]).toMatchObject({ role: 'assistant' });
});

test('inline edit replaces a user message, truncates later messages, and reruns in place', async ({
	page,
	request
}) => {
	const sourceId = await createConversation(request, uniqueTitle('Inline Source'));

	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message…/);
	await composer.click();
	await composer.fill('first prompt');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first prompt');
	await expect(page.getByText('Stubbed reply to: first prompt').first()).toBeVisible();

	await composer.click();
	await composer.fill('second prompt');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: second prompt');
	await expect(page.getByText('Stubbed reply to: second prompt').first()).toBeVisible();

	const before = await getConversation(request, sourceId);
	const firstUser = (
		messagesOf(before) as Array<{ id: string; role: string; content: string }>
	).find((m) => m.role === 'user' && m.content === 'first prompt');
	expect(firstUser).toBeDefined();

	const editRes = await request.post(
		`/api/conversations/${sourceId}/messages/${firstUser!.id}/edit`,
		{ data: { content: 'first prompt edited inline' } }
	);
	expect(editRes.ok()).toBeTruthy();
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first prompt edited inline');

	const after = await getConversation(request, sourceId);
	const list = messagesOf(after) as Array<{ id: string; role: string; content: string }>;
	expect(list.map((m) => `${m.role}:${m.content}`)).toEqual([
		'user:first prompt edited inline',
		'assistant:Stubbed reply to: first prompt edited inline'
	]);
	expect(list[0].id).toBe(firstUser!.id);
});

test('regenerate an assistant message re-runs in place from the unchanged user prompt', async ({
	page,
	request
}) => {
	const sourceId = await createConversation(request, uniqueTitle('Regenerate Source'));

	await page.goto(`/conversations/${sourceId}`);
	const composer = page.getByPlaceholder(/Message…/);
	await composer.click();
	await composer.fill('first prompt');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first prompt');
	await composer.click();
	await composer.fill('second prompt');
	await composer.press('Enter');
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: second prompt');
	await expect(page.getByText('Stubbed reply to: second prompt').first()).toBeVisible();

	const before = await getConversation(request, sourceId);
	const beforeList = messagesOf(before) as Array<{ id: string; role: string; content: string }>;
	const firstAssistant = beforeList.find(
		(m) => m.role === 'assistant' && m.content === 'Stubbed reply to: first prompt'
	);
	const firstUser = beforeList.find((m) => m.role === 'user' && m.content === 'first prompt');
	expect(firstAssistant).toBeDefined();
	expect(firstUser).toBeDefined();

	// Regenerate the first assistant reply: the reply and everything after it
	// (second prompt + its reply) is discarded and the turn re-runs from the
	// unchanged "first prompt" user message, in the same conversation.
	const res = await request.post(
		`/api/conversations/${sourceId}/messages/${firstAssistant!.id}/regenerate`,
		{ data: {} }
	);
	expect(res.ok()).toBeTruthy();
	await waitForAssistantMessage(request, sourceId, 'Stubbed reply to: first prompt');

	const after = await getConversation(request, sourceId);
	const list = messagesOf(after) as Array<{ id: string; role: string; content: string }>;
	expect(list.map((m) => `${m.role}:${m.content}`)).toEqual([
		'user:first prompt',
		'assistant:Stubbed reply to: first prompt'
	]);
	// The user message is preserved (same id, unchanged content); only the
	// assistant reply is freshly regenerated.
	expect(list[0].id).toBe(firstUser!.id);
	expect(list[1].id).not.toBe(firstAssistant!.id);
});
