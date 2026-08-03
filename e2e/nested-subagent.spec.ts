import { test, expect } from './helpers/fixtures';
import { createConversation, uniqueTitle, waitForAssistantMessage } from './helpers/conversations';

interface ToolCallJson {
	id: string;
	tool: string;
	parentToolCallId: string | null;
}
interface MessageJson {
	role: string;
	toolCalls?: ToolCallJson[];
}

// A sub-agent can itself spawn a sub-agent (`general-purpose` agents get the
// `task` tool). The grandchild's rows are persisted against the INNER `task`
// call, so rendering that only recursed one level dropped them from the UI
// entirely — they were filtered out at message level and no component ever
// claimed them. This asserts the full chain persists AND renders.
test('a sub-agent that spawns a sub-agent renders as a nested card, not a bare tool call', async ({
	page,
	request
}) => {
	const id = await createConversation(request, uniqueTitle('E2E nested-subagent'));
	await page.goto(`/conversations/${id}`);

	const composer = page.getByPlaceholder(/Message GitHub Copilot/);
	await composer.click();
	await composer.fill('go @trigger-nested-subagent now');
	await composer.press('Enter');

	await waitForAssistantMessage(request, id, 'Stubbed reply to: go @trigger-nested-subagent now');

	// Backend: a three-level chain — outer task -> inner task -> grandchild tool.
	const body = (await request.get(`/api/conversations/${id}`).then((r) => r.json())) as {
		messages: MessageJson[];
	};
	const tools = body.messages.flatMap((m) => m.toolCalls ?? []);
	const outer = tools.find((t) => t.tool === 'task' && t.parentToolCallId === null);
	expect(outer, 'an outer task call should be persisted').toBeTruthy();
	const inner = tools.find((t) => t.tool === 'task' && t.parentToolCallId === outer!.id);
	expect(inner, 'the nested task call should hang off the outer one').toBeTruthy();
	const grandchild = tools.find((t) => t.parentToolCallId === inner!.id);
	expect(grandchild, "the grandchild's tool call should hang off the INNER task call").toBeTruthy();

	// UI: the nested task renders as a sub-agent card inside the outer card,
	// rather than as a generic tool card.
	const outerCard = page.locator('details.subagent', { hasText: 'Outer agent' }).first();
	await expect(outerCard).toBeVisible();
	const nestedCard = outerCard.locator('details.subagent', { hasText: 'Nested agent' }).first();
	await expect(nestedCard).toBeVisible();
	await expect(nestedCard).toHaveClass(/is-nested/);

	// The regression that matters: the grandchild's own activity is reachable
	// in the DOM, nested inside the inner card.
	await expect(nestedCard.getByText('echo grandchild').first()).toBeVisible();

	// Nesting survives a reload (rehydrated from SQLite, not just live SSE).
	// A completed card renders collapsed, so open the card and its activity
	// timeline before asserting the nested card is on screen.
	await page.reload();
	const outerAfter = page.locator('details.subagent', { hasText: 'Outer agent' }).first();
	await outerAfter.locator('summary').first().click();
	await outerAfter.locator('details.activity > summary').first().click();
	const nestedAfter = outerAfter.locator('details.subagent', { hasText: 'Nested agent' }).first();
	await expect(nestedAfter).toBeVisible();
	await expect(nestedAfter).toHaveClass(/is-nested/);
});
