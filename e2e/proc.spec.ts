import { test, expect } from "./helpers/fixtures";
import {
  createConversation,
  getConversation,
  uniqueTitle,
  waitForAssistantMessage,
} from "./helpers/conversations";

test("semantic mode exposes proc and completes a stateful atom flow", async ({
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
        goal: "Return paths and line numbers",
        procedure: `PI_TEST_PROC_RETURN ${JSON.stringify(expected)}`,
        output: { mode: "exact", max_bytes: 4096, store: false },
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
  await waitForAssistantMessage(request, id, `Stubbed reply to: ${directive}`);

  const conversation = await getConversation(request, id);
  const calls = conversation.transcript.tail.flatMap((message) =>
    Array.isArray((message as MessageWithTools).toolCalls)
      ? (message as MessageWithTools).toolCalls!.map((call) => call.tool)
      : [],
  );
  expect(calls).toEqual(["proc"]);

  await page.goto(`/conversations/${id}`);
  await expect(page.getByText(summary, { exact: true })).toBeVisible();
  await page.getByText(summary, { exact: true }).click();
  await expect(page.locator("details.subagent pre code")).toContainText(
    "Return paths and line numbers",
  );
});

interface MessageWithTools {
  toolCalls?: Array<{ tool: string }>;
}

function sequenceDirective(steps: Array<{ name: string; args: unknown }>) {
  return `PI_TEST_TOOL_SEQUENCE ${JSON.stringify(steps)}`;
}
