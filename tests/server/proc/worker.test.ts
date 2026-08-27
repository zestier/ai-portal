import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationId as convCodec } from "../../../src/lib/ids";
import { setupLocalEnv } from "../../helpers/env";
import * as users from "../../../src/lib/server/db/repos/users";
import * as conversations from "../../../src/lib/server/db/repos/conversations";
import {
  createProcTransaction,
  getProcResult,
} from "../../../src/lib/server/proc/store";
import {
  initialProcMessages,
  PROC_WORKER_SYSTEM,
  runProcWorker,
} from "../../../src/lib/server/proc/worker";

const piChat = vi.fn();

vi.mock("../../../src/lib/server/pi/complete", () => ({
  resolveModelSelection: vi.fn(async () => ({ model: {}, runtime: {} })),
  piChat: (...args: unknown[]) => piChat(...args),
}));

describe("proc worker", () => {
  beforeEach(async () => {
    piChat.mockReset();
    await setupLocalEnv("proc-worker-");
  });

  it("is constrained to frontier-authored procedures and atoms", () => {
    expect(PROC_WORKER_SYSTEM).toContain("tolerant compiler");
    expect(PROC_WORKER_SYSTEM).toContain("Do not broaden");
    expect(PROC_WORKER_SYSTEM).toContain("Fuse, batch, and inline");
    expect(PROC_WORKER_SYSTEM).not.toContain("ask_user");
  });

  it("composes exact stored atom values and returns a bounded final projection", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "atom-1",
            name: "atom",
            arguments: JSON.stringify({
              summary: "Create candidates",
              source: "return [{ path: 'src/a.ts', line: 10 }];",
              output: { mode: "shape", max_bytes: 1024, store: true },
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const prior = JSON.parse(messages.at(-1).content) as {
          result_id: string;
        };
        return {
          content: "",
          toolCalls: [
            {
              id: "atom-2",
              name: "atom",
              arguments: JSON.stringify({
                summary: "Add definition extents",
                source: `return state[${JSON.stringify(prior.result_id)}].map(row => ({ ...row, end: row.line + 5 }));`,
                output: { mode: "none", store: true },
              }),
            },
          ],
        };
      })
      .mockImplementationOnce(async (_config, messages) => {
        const prior = JSON.parse(messages.at(-1).content) as {
          result_id: string;
        };
        return {
          content: "",
          toolCalls: [
            {
              id: "complete-1",
              name: "complete",
              arguments: JSON.stringify({ result_id: prior.result_id }),
            },
          ],
        };
      });

    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc worker",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const outputPolicy = {
      mode: "exact" as const,
      maxBytes: 4096,
      store: true,
    };
    const contracts = [
      {
        name: "grep",
        parameters: { type: "object" },
        result: { type: "object" },
        example: "tools.grep({ pattern: 'foo' })",
      },
    ];
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 42,
      workerModel: "pi-stub/stub-model",
      summary: "Find owner",
      contract: "Return paths and ranges",
      procedure: "Create candidates, then add extents",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Find owner",
        contract: "Return paths and ranges",
        procedure: "Create candidates, then add extents",
        outputPolicy,
        contracts,
      }),
    });
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    const outcome = await runProcWorker({
      transaction,
      capabilities: new Map(),
      facadeCapabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: (event) => events.push(event),
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: "completed",
      stored: true,
      projection: [{ path: "src/a.ts", line: 10, end: 15 }],
      truncated: false,
      usage: { turns: 3, atoms: 2, operations: 0 },
    });
    expect(outcome.resultId).toBeTruthy();
    expect(
      getProcResult({
        id: outcome.resultId!,
        transactionId: transaction.id,
        conversationId,
      })?.value,
    ).toEqual([{ path: "src/a.ts", line: 10, end: 15 }]);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "subagent.lifecycle",
          status: "running",
        }),
        expect.objectContaining({
          type: "subagent.lifecycle",
          status: "completed",
        }),
        expect.objectContaining({
          type: "tool.call",
          tool: "atom",
          parentToolCallId: "X42",
        }),
        expect.objectContaining({
          type: "tool.result",
          parentToolCallId: "X42",
          output: expect.stringContaining("projection"),
        }),
      ]),
    );
    expect(
      (piChat.mock.calls[0][2] as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["atom", "complete", "cannot_execute"]);
    const initial = JSON.parse(transaction.messages[1].content as string) as {
      program_environment: { tool_contracts: unknown[] };
    };
    expect(initial.program_environment.tool_contracts).toEqual(contracts);
  });

  it("returns atom failures to the worker instead of failing the transaction", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "bad-atom",
            name: "atom",
            arguments: JSON.stringify({
              summary: "Attempt unsupported operation",
              source: "throw new Error('bad atom');",
              output: { mode: "shape", max_bytes: 1024, store: true },
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        expect(messages.at(-1).content).toContain("bad atom");
        return {
          content: "",
          toolCalls: [
            {
              id: "cannot-1",
              name: "cannot_execute",
              arguments: JSON.stringify({
                reason: "The requested operation is unsupported.",
              }),
            },
          ],
        };
      });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc failure",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const outputPolicy = {
      mode: "shape" as const,
      maxBytes: 1024,
      store: false,
    };
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 43,
      workerModel: "pi-stub/stub-model",
      summary: "Unsupported proc",
      contract: "Return a result",
      procedure: "Perform unsupported operation",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Unsupported proc",
        contract: "Return a result",
        procedure: "Perform unsupported operation",
        outputPolicy,
        contracts: [],
      }),
    });
    const outcome = await runProcWorker({
      transaction,
      capabilities: new Map(),
      facadeCapabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({
      status: "cannot_execute",
      summary: "The requested operation is unsupported.",
      usage: { turns: 2, atoms: 1 },
    });
  });
});
