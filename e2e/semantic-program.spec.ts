import { test, expect } from "./helpers/fixtures";
import {
  createConversation,
  getConversation,
  uniqueTitle,
  waitForAssistantMessage,
} from "./helpers/conversations";

test("semantic program supports direct guesses and schema-assisted recovery", async ({
  page,
  request,
}) => {
  const id = await createConversation(
    request,
    uniqueTitle("E2E semantic program"),
    { approvalMode: "auto-approve" },
  );
  const session = await request.patch(`/api/conversations/${id}/session`, {
    data: { agentArchitecture: "semantic" },
  });
  expect(session.ok()).toBeTruthy();

  const direct = sequenceDirective([
    {
      name: "program",
      args: {
        summary: "Search for ProgramArgs directly",
        max_result_bytes: 4096,
        result_overflow: "reject",
        source:
          'return tools.grep({ query: "ProgramArgs", cwd: "src", include: "*.ts" });',
      },
    },
  ]);
  expect(
    (
      await request.post(`/api/conversations/${id}/turns`, {
        data: { content: direct },
      })
    ).ok(),
  ).toBeTruthy();
  await waitForAssistantMessage(request, id, `Stubbed reply to: ${direct}`);

  const recovery = sequenceDirective([
    {
      name: "program",
      args: {
        summary: "Try the initial ProgramArgs search",
        max_result_bytes: 4096,
        result_overflow: "reject",
        source: 'return tools.grep({ nope: "ProgramArgs" });',
      },
    },
    { name: "get_program_tool_schemas", args: { names: ["grep"] } },
    {
      name: "program",
      args: {
        summary: "Retry ProgramArgs with the recovered schema",
        max_result_bytes: 4096,
        result_overflow: "reject",
        source:
          'return tools.grep({ pattern: "ProgramArgs", path: "src", glob: "*.ts" });',
      },
    },
  ]);
  expect(
    (
      await request.post(`/api/conversations/${id}/turns`, {
        data: { content: recovery },
      })
    ).ok(),
  ).toBeTruthy();
  await waitForAssistantMessage(request, id, `Stubbed reply to: ${recovery}`);

  const conversation = await getConversation(request, id);
  const calls = conversation.transcript.tail.flatMap((message) =>
    Array.isArray((message as MessageWithTools).toolCalls)
      ? (message as MessageWithTools).toolCalls!.map((call) => call.tool)
      : [],
  );
  expect(calls).toEqual([
    "program",
    "grep",
    "program",
    "grep",
    "get_program_tool_schemas",
    "program",
    "grep",
  ]);

  await page.goto(`/conversations/${id}`);
  await expect(
    page.getByText("Search for ProgramArgs directly", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Try the initial ProgramArgs search", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Retry ProgramArgs with the recovered schema", {
      exact: true,
    }),
  ).toBeVisible();
});

interface MessageWithTools {
  toolCalls?: Array<{ tool: string }>;
}

function sequenceDirective(steps: Array<{ name: string; args: unknown }>) {
  return `PI_TEST_TOOL_SEQUENCE ${JSON.stringify(steps)}`;
}
