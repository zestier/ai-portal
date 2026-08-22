import { describe, it, expect, beforeEach } from "vitest";
import { setupLocalEnv } from "../../helpers/env";
import { conversationId as convCodec } from "../../../src/lib/ids";
import type { PortalEvent } from "../../../src/lib/types";
import type { ToolResult } from "../../../src/lib/server/tools/types";
import { portalToolCatalog } from "../../../src/lib/server/tools/catalog";

// The `ask_user` tool is `never-prompt` (nothing to gate at the call site)
// and always raises a `user_input` dialog, waiting for the human's answer.
// These tests drive the tool handler directly, resolve the questions it
// raises, and assert the returned answers / cancellation behavior.

async function makeHarness() {
  const interactive =
    await import("../../../src/lib/server/runtime/interactive-requests");
  const { buildAskUserTool } =
    await import("../../../src/lib/server/tools/ask-user");
  const { ensureLocalUser } =
    await import("../../../src/lib/server/db/repos/users");
  const convs = await import("../../../src/lib/server/db/repos/conversations");
  const user = ensureLocalUser();
  const conversation = convs.create(user.id, {
    title: "ask test",
    workdir: "/tmp",
    model: "gpt-4",
  });
  const conversationId = convCodec.parse(conversation.id);
  const events: PortalEvent[] = [];
  const tool = buildAskUserTool({
    userId: user.id,
    conversationId,
    emit: (ev) => events.push(ev),
  });
  expect(tool.permissionBehavior).toBe("never-prompt");
  return { interactive, user, conversationId, events, tool };
}

async function driveAndAnswer(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  args: Record<string, unknown>,
  answers: { kind: "user_input"; answers: string[]; wasFreeform?: boolean },
): Promise<{ result: ToolResult; view: Record<string, unknown> }> {
  const resultPromise = harness.tool.handler(args) as Promise<ToolResult>;

  let view: { requestId: string; [k: string]: unknown } | undefined;
  for (let i = 0; i < 200 && !view; i++) {
    const pending = harness.interactive.listForConversation(
      harness.conversationId,
    );
    if (pending.length > 0) {
      view = pending[0] as { requestId: string };
      break;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  if (!view) throw new Error("no question prompt was raised");

  const resolved = harness.interactive.resolve(
    view.requestId,
    harness.user.id,
    answers,
  );
  expect(resolved).toBe(true);

  const result = await resultPromise;
  return { result, view: view as Record<string, unknown> };
}

describe("ask_user", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-ask-user-");
  });

  it("is listed under the interaction group in the catalog", () => {
    const entries = portalToolCatalog();
    const entry = entries.find((e) => e.name === "ask_user");
    expect(entry).toBeTruthy();
    expect(entry?.group).toBe("interaction");
    expect(entry?.permissionBehavior).toBe("never-prompt");
  });

  it("raises a user_input view carrying the questions and resolves to the answers", async () => {
    const harness = await makeHarness();
    const { result, view } = await driveAndAnswer(
      harness,
      {
        questions: [
          {
            question: "Which database do you prefer?",
            choices: ["sqlite", "postgres"],
          },
        ],
      },
      { kind: "user_input", answers: ["sqlite"], wasFreeform: false },
    );

    expect(view).toMatchObject({
      requestId: expect.any(String),
      kind: "user_input",
      questions: [
        {
          question: "Which database do you prefer?",
          choices: ["sqlite", "postgres"],
        },
      ],
      allowFreeform: true,
    });
    // The question was raised into the turn stream.
    expect(harness.events.some((ev) => ev.type === "interactive.request")).toBe(
      true,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({
        answers: [
          { question: "Which database do you prefer?", answer: "sqlite" },
        ],
        wasFreeform: false,
      });
    }
  });

  it("raises a batch view with multiple items and resolves answers in order", async () => {
    const harness = await makeHarness();
    const { result, view } = await driveAndAnswer(
      harness,
      {
        questions: [{ question: "First?" }, { question: "Second?" }],
      },
      { kind: "user_input", answers: ["one", "two"], wasFreeform: true },
    );

    expect(view).toMatchObject({
      kind: "user_input",
      questions: [{ question: "First?" }, { question: "Second?" }],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Pair-array: each entry self-contained with its question echoed, in order.
      expect(result.result).toEqual({
        answers: [
          { question: "First?", answer: "one" },
          { question: "Second?", answer: "two" },
        ],
        wasFreeform: true,
      });
      // And the human-readable summary formats one numbered line per answer.
      expect(result.summary).toBe(
        "The human answered:\n1. First? one\n2. Second? two",
      );
    }
  });

  it("echoes wasFreeform true for a typed answer", async () => {
    const harness = await makeHarness();
    const { result } = await driveAndAnswer(
      harness,
      { questions: [{ question: "What is the release name?" }] },
      { kind: "user_input", answers: ["something custom"], wasFreeform: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toMatchObject({
        wasFreeform: true,
        answers: [
          { question: "What is the release name?", answer: "something custom" },
        ],
      });
    }
  });

  it("reports a cancellation (turn abort) as question_cancelled", async () => {
    const harness = await makeHarness();
    const resultPromise = harness.tool.handler({
      questions: [{ question: "Your preference?" }],
    }) as Promise<ToolResult>;
    for (let i = 0; i < 200; i++) {
      if (
        harness.interactive.listForConversation(harness.conversationId).length >
        0
      )
        break;
      await new Promise((r) => setTimeout(r, 1));
    }
    harness.interactive.cancelConversation(
      harness.conversationId,
      "turn_aborted",
    );
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("question_cancelled");
  });

  it("rejects an empty questions array", async () => {
    const harness = await makeHarness();
    const parsed = harness.tool.argsSchema!.safeParse({ questions: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects more than 10 questions", async () => {
    const harness = await makeHarness();
    const parsed = harness.tool.argsSchema!.safeParse({
      questions: Array.from({ length: 11 }, (_, i) => ({ question: `q${i}` })),
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an item with an empty question", async () => {
    const harness = await makeHarness();
    const parsed = harness.tool.argsSchema!.safeParse({
      questions: [{ question: "   " }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects the old single-question shape", async () => {
    const harness = await makeHarness();
    const parsed = harness.tool.argsSchema!.safeParse({
      question: "Your preference?",
    });
    expect(parsed.success).toBe(false);
  });
});
