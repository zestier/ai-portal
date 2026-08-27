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

  it("is constrained to frontier-authored procedures and fused executions", () => {
    expect(Buffer.byteLength(PROC_WORKER_SYSTEM)).toBeLessThanOrEqual(2_000);
    expect(PROC_WORKER_SYSTEM).toContain("without changing it");
    expect(PROC_WORKER_SYSTEM).toContain("broaden scope");
    expect(PROC_WORKER_SYSTEM).toContain("whole procedure");
    expect(PROC_WORKER_SYSTEM).toContain(
      "If one reliable program is impractical",
    );
    expect(PROC_WORKER_SYSTEM).toContain("exactly one tool per turn");
    expect(PROC_WORKER_SYSTEM).not.toContain("ask_user");
  });

  it("composes an exact checkpoint and completes with a fused final execution", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "atom-1",
            name: "execute",
            arguments: JSON.stringify({
              summary: "Create candidates",
              javascript: "return [{ path: 'src/a.ts', line: 10 }];",
              purpose: "checkpoint",
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
              name: "execute",
              arguments: JSON.stringify({
                summary: "Add definition extents",
                javascript: `return getState(${JSON.stringify(prior.result_id)}).map(row => ({ ...row, end: row.line + 5 }));`,
                purpose: "final",
              }),
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
      usage: { turns: 2, executions: 2, operations: 0 },
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
          tool: "execute",
          parentToolCallId: "X42",
        }),
        expect.objectContaining({
          type: "tool.result",
          parentToolCallId: "X42",
          output: expect.stringContaining("projection"),
        }),
      ]),
    );
    const workerTools = piChat.mock.calls[0][2] as Array<{
      function: {
        name: string;
        parameters: { properties: Record<string, unknown> };
      };
    }>;
    expect(workerTools.map((tool) => tool.function.name)).toEqual([
      "execute",
      "cannot_execute",
    ]);
    expect(Buffer.byteLength(JSON.stringify(workerTools))).toBeLessThanOrEqual(
      2_500,
    );
    expect(workerTools[0]?.function.parameters.properties).not.toHaveProperty(
      "max_bytes",
    );
    const initial = JSON.parse(transaction.messages[1].content as string) as {
      environment: { tools: unknown[] };
    };
    expect(initial.environment.tools).toEqual(contracts);
  });

  it("returns execution failures to the worker instead of failing the transaction", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "bad-atom",
            name: "execute",
            arguments: JSON.stringify({
              summary: "Attempt unsupported operation",
              javascript: "throw new Error('bad atom');",
              purpose: "final",
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
      usage: { turns: 2, executions: 1 },
    });
  });

  it("reports whether a failed execution is safe to retry", async () => {
    const mutation = {
      name: "write_fixture",
      description: "Write a fixture",
      parameters: { type: "object" },
      program: {
        catalogDescription: "write a fixture",
        operationCategory: "mutation" as const,
        resultSchema: { type: "object" },
        example: "tools.write_fixture({})",
        contractVersion: "1",
      },
      handler: vi.fn(async () => ({
        ok: true as const,
        summary: "wrote fixture",
        result: {},
      })),
    };
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "partial-mutation",
            name: "execute",
            arguments: JSON.stringify({
              summary: "Write then fail",
              javascript:
                "tools.write_fixture({}); throw new Error('after write');",
              purpose: "final",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          retry_safe: boolean;
          effects: Array<{ tool: string; effect: string; ok: boolean }>;
          instruction: string;
        };
        expect(feedback.retry_safe).toBe(false);
        expect(feedback.effects).toEqual([
          { tool: "write_fixture", effect: "mutation", ok: true },
        ]);
        expect(feedback.instruction).toContain("Do not replay");
        return {
          content: "",
          toolCalls: [
            {
              id: "stop-after-effects",
              name: "cannot_execute",
              arguments: JSON.stringify({
                reason: "Current state needs reconciliation.",
              }),
            },
          ],
        };
      });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc effects",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const outputPolicy = {
      mode: "exact" as const,
      maxBytes: 1024,
      store: false,
    };
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 44,
      workerModel: "pi-stub/stub-model",
      summary: "Mutating proc",
      contract: "Return validation status",
      procedure: "Write a fixture and validate it",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Mutating proc",
        contract: "Return validation status",
        procedure: "Write a fixture and validate it",
        outputPolicy,
        contracts: [],
      }),
    });
    const outcome = await runProcWorker({
      transaction,
      capabilities: new Map([[mutation.name, mutation]]),
      facadeCapabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe("cannot_execute");
  });
});
