import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationId as convCodec } from "../../../src/lib/ids";
import { setupLocalEnv } from "../../helpers/env";
import * as users from "../../../src/lib/server/db/repos/users";
import * as conversations from "../../../src/lib/server/db/repos/conversations";
import { ok, type PortalTool } from "../../../src/lib/server/tools/types";
import {
  createTransaction,
  getTransaction,
  readArtifact,
} from "../../../src/lib/server/semantic/store";
import {
  initialWorkerMessages,
  runSemanticWorker,
  SEMANTIC_WORKER_SYSTEM,
} from "../../../src/lib/server/semantic/worker";
import { buildSemanticTools } from "../../../src/lib/server/semantic/tools";

const piChat = vi.fn();

vi.mock("../../../src/lib/server/pi/complete", () => ({
  resolveModelSelection: vi.fn(async () => ({ model: {}, runtime: {} })),
  piChat: (...args: unknown[]) => piChat(...args),
}));

describe("semantic worker", () => {
  beforeEach(async () => {
    piChat.mockReset();
    await setupLocalEnv("semantic-worker-");
  });

  it("defines a narrow execution role without subagent framing", () => {
    expect(SEMANTIC_WORKER_SYSTEM).toContain("Execute the one repository task");
    expect(SEMANTIC_WORKER_SYSTEM).toContain(
      "Do not make product, design, or other consequential choices",
    );
    expect(SEMANTIC_WORKER_SYSTEM).not.toContain("frontier");
    expect(SEMANTIC_WORKER_SYSTEM).not.toContain("subagent");
  });

  it("permission-checks nested tools, persists artifacts, and records usage", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "echo",
            arguments: JSON.stringify({ value: "found" }),
          },
        ],
        usage: {
          input: 100,
          output: 10,
          cacheRead: 80,
          cacheWrite: 5,
          cost: 0.01,
        },
      })
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "call-2",
            name: "semantic_complete",
            arguments: JSON.stringify({
              summary: "Located the owner.",
              findings: ["Owner is src/owner.ts"],
            }),
          },
        ],
        usage: {
          input: 120,
          output: 12,
          cacheRead: 100,
          cacheWrite: 0,
          cost: 0.02,
        },
      });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "worker",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const transaction = createTransaction({
      conversationId,
      parentToolCallId: 17,
      workerModel: "pi-stub/stub-model",
      intent: "Find the owner",
      messages: initialWorkerMessages({ intent: "Find the owner" }),
    });
    const echo: PortalTool = {
      name: "echo",
      description: "Echo a value.",
      parameters: { type: "object" },
      async handler(args) {
        return ok(args);
      },
    };
    const permissionResolver = vi.fn(async () => ({ allow: true }));
    const events: Array<{ type: string; [key: string]: unknown }> = [];

    const outcome = await runSemanticWorker({
      transaction,
      capabilities: new Map([[echo.name, echo]]),
      permissionResolver,
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: "completed",
      summary: "Located the owner.",
      usage: {
        input: 220,
        output: 22,
        cacheRead: 180,
        cacheWrite: 5,
        cost: 0.03,
        turns: 2,
        primitiveCalls: 1,
      },
    });
    expect(permissionResolver).toHaveBeenCalledWith(
      "echo",
      { value: "found" },
      expect.stringMatching(/^X/),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool.call",
          tool: "echo",
          parentToolCallId: "X17",
        }),
        expect.objectContaining({ type: "tool.result", ok: true }),
        expect.objectContaining({
          type: "subagent.lifecycle",
          status: "completed",
        }),
      ]),
    );
    expect(getTransaction(transaction.id, conversationId)?.status).toBe(
      "completed",
    );
    expect(
      readArtifact({
        id: outcome.evidenceId!,
        conversationId,
        kind: "evidence",
      })?.content,
    ).toContain("Owner is src/owner.ts");
  });

  it("resumes a suspended transaction with the frontier decision", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "escalate-1",
            name: "semantic_escalate",
            arguments: JSON.stringify({
              question: "Which implementation should change?",
              options: ["interactive", "imported"],
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "complete-1",
            name: "semantic_complete",
            arguments: JSON.stringify({
              summary: "Updated the interactive path.",
              findings: [],
            }),
          },
        ],
      });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "resume",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const tools = buildSemanticTools({
      conversationId,
      frontierModel: "pi-stub/stub-model",
      capabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
    });
    const resolve = tools.find((tool) => tool.name === "resolve")!;
    const resume = tools.find((tool) => tool.name === "resume")!;
    const signal = new AbortController().signal;
    const first = await resolve.handler(
      { intent: "Update the selected implementation" },
      {
        signal,
        toolCallId: "X21",
        partial: () => {},
        progress: () => {},
      },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected suspended transaction");
    const suspended = first.result as {
      status: string;
      transactionId: string;
    };
    expect(suspended.status).toBe("decision_required");

    const second = await resume.handler(
      {
        transaction_id: suspended.transactionId,
        decision: "Use the interactive implementation.",
      },
      {
        signal,
        toolCallId: "X22",
        partial: () => {},
        progress: () => {},
      },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected completed transaction");
    expect(second.result).toMatchObject({
      status: "completed",
      summary: "Updated the interactive path.",
    });
    const persisted = getTransaction(suspended.transactionId, conversationId);
    expect(persisted).toMatchObject({
      status: "completed",
      parentToolCallId: 22,
    });
    expect(persisted?.messages.at(-2)).toEqual({
      role: "user",
      content: "Use the interactive implementation.",
    });
  });
});
