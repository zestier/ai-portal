import { test, expect } from "./helpers/fixtures";
import {
  createConversation,
  getConversation,
  uniqueTitle,
  waitForAssistantMessage,
} from "./helpers/conversations";

test("semantic mode exposes proc and completes a fused execution", async ({
  page,
  request,
}) => {
  const id = await createConversation(request, uniqueTitle("E2E proc"), {
    approvalMode: "auto-approve",
  });
  const session = await request.patch(`/api/conversations/${id}/session`, {
    data: { agentArchitecture: "semantic" },
  });
  expect(session.ok()).toBeTruthy();

  const summary = "Build a compact owner list";
  const expected = [
    { path: "src/a.ts", line: 10 },
    { path: "src/b.ts", line: 20 },
  ];
  const directive = sequenceDirective([
    {
      name: "proc",
      args: {
        summary,
        procedure: `@trigger-slow-proc PI_TEST_PROC_RETURN ${JSON.stringify(expected)}`,
        result_requirements: "Return paths and line numbers",
      },
    },
  ]);
  expect(
    (
      await request.post(`/api/conversations/${id}/turns`, {
        data: { content: directive },
      })
    ).ok(),
  ).toBeTruthy();

  await expect
    .poll(async () => {
      const pending = await getConversation(request, id);
      return pending.transcript.tail
        .flatMap((message) =>
          Array.isArray((message as MessageWithTools).toolCalls)
            ? (message as MessageWithTools).toolCalls!
            : [],
        )
        .find((call) => call.tool === "proc")?.status;
    })
    .toBe("pending");

  await page.goto(`/conversations/${id}`);
  await expect(page.getByText(summary, { exact: true })).toBeVisible();
  const procCard = page
    .locator("details.proc")
    .filter({ has: page.getByText(summary, { exact: true }) })
    .first();
  await expect(procCard).toHaveAttribute("data-automatically-open", "true");
  await expect(procCard).toHaveAttribute("open", "");
  await expect(procCard.locator(":scope > .content")).toHaveCSS(
    "overflow-y",
    "auto",
  );
  await procCard.locator(":scope > summary").click();
  await expect(procCard).toHaveAttribute("data-automatically-open", "false");
  await expect(procCard).not.toHaveAttribute("open", "");

  await waitForAssistantMessage(request, id, `Stubbed reply to: ${directive}`);
  const conversation = await getConversation(request, id);
  const calls = conversation.transcript.tail.flatMap((message) =>
    Array.isArray((message as MessageWithTools).toolCalls)
      ? (message as MessageWithTools).toolCalls!.map((call) => call.tool)
      : [],
  );
  expect(calls).toEqual(["proc", "execute"]);

  await expect(procCard).toHaveAttribute("data-automatically-open", "false");
  await expect(procCard).not.toHaveAttribute("open", "");
  await procCard.locator(":scope > summary").click();
  await expect(
    procCard.locator(":scope > .content .request-grid"),
  ).toContainText("Return paths and line numbers");
  await expect(procCard.locator(":scope > .content > .outcome")).toContainText(
    '"path": "src/a.ts"',
  );
  await expect(
    procCard.getByText("Returning the deterministic proc fixture", {
      exact: true,
    }),
  ).toBeVisible();
  await procCard.locator(":scope > summary").click();
  await expect(procCard).not.toHaveAttribute("open", "");
});

interface MessageWithTools {
  toolCalls?: Array<{ tool: string; status: string }>;
}

function sequenceDirective(steps: Array<{ name: string; args: unknown }>) {
  return `PI_TEST_TOOL_SEQUENCE ${JSON.stringify(steps)}`;
}
