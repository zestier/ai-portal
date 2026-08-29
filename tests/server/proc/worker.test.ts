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
  procTranscriptStats,
  PROC_WORKER_SYSTEM,
  runProcWorker,
  summarizeExecutionEffects,
} from "../../../src/lib/server/proc/worker";
import {
  attachProgramMetadata,
  programCapabilities,
} from "../../../src/lib/server/ptc/contracts";
import { ok } from "../../../src/lib/server/tools/types";

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

  it("measures retained transcript bytes and identifies the largest message", () => {
    const messages = [
      { role: "system" as const, content: "small" },
      { role: "user" as const, content: "x".repeat(1_000) },
    ];
    expect(procTranscriptStats(messages)).toMatchObject({
      bytes: expect.any(Number),
      largestMessageIndex: 1,
      largestMessageBytes: expect.any(Number),
    });
    expect(procTranscriptStats(messages).bytes).toBeGreaterThan(1_000);
  });

  it("aggregates a C276-sized effect ledger into bounded feedback", () => {
    const effects = [
      ...Array.from({ length: 25_898 }, () => ({
        tool: "__ptc_fs_stat",
        effect: "read" as const,
        ok: true,
      })),
      ...Array.from({ length: 1_151 }, () => ({
        tool: "__ptc_fs_readdir",
        effect: "read" as const,
        ok: true,
      })),
    ];
    const summary = summarizeExecutionEffects(effects);

    expect(summary).toEqual([
      { tool: "__ptc_fs_stat", effect: "read", ok: true, count: 25_898 },
      { tool: "__ptc_fs_readdir", effect: "read", ok: true, count: 1_151 },
    ]);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(300);
  });

  it("rejects an oversized retained transcript before calling the model", async () => {
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "oversized proc transcript",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 41,
      workerModel: "pi-stub/stub-model",
      summary: "Oversized proc",
      requirements: "Return one value",
      procedure: "Return one value",
      outputPolicy: { mode: "exact", maxBytes: 1_024, store: false },
      messages: [
        { role: "system", content: "worker" },
        { role: "user", content: "x".repeat(129 * 1_024) },
      ],
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
      status: "failed",
      summary: expect.stringContaining("transcript reached"),
    });
    expect(piChat).not.toHaveBeenCalled();
  });

  it("does not retain or replay oversized model-generated tool arguments", async () => {
    piChat.mockResolvedValueOnce({
      content: "",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        cost: 0.5,
      },
      toolCalls: [
        {
          id: "oversized-call",
          name: "execute",
          arguments: "x".repeat(400 * 1_024),
        },
      ],
    });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "oversized proc arguments",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const initialMessages = [
      { role: "system" as const, content: "worker" },
      { role: "user" as const, content: "return one value" },
    ];
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 40,
      workerModel: "pi-stub/stub-model",
      summary: "Oversized proc arguments",
      requirements: "Return one value",
      procedure: "Return one value",
      outputPolicy: { mode: "exact", maxBytes: 1_024, store: false },
      messages: initialMessages,
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
      status: "failed",
      summary: expect.stringContaining("arguments for execute"),
    });
    expect(piChat).toHaveBeenCalledTimes(1);
    expect(transaction.messages).toEqual(initialMessages);
    expect(outcome.usage).toMatchObject({
      turns: 1,
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      cost: 0.5,
    });
  });

  it("retains oversized inspection state for a reducing retry", async () => {
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "oversized inspection",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const outputPolicy = {
      mode: "exact" as const,
      maxBytes: 1_024,
      store: false,
    };
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 39,
      workerModel: "pi-stub/stub-model",
      summary: "Inspect large value",
      requirements: "Return one value",
      procedure: "Inspect then reduce",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Inspect large value",
        requirements: "Return one value",
        procedure: "Inspect then reduce",
        outputPolicy,
        contracts: [],
      }),
    });
    const largeValue = { text: "x".repeat(13 * 1_024) };
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "small-inspection",
            name: "execute",
            arguments: JSON.stringify({
              summary: "Inspect candidates",
              javascript: "return { candidates: ['src/a.ts'] };",
              result_for: "worker_context",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as Record<
          string,
          unknown
        >;
        expect(feedback).toMatchObject({
          result_for: "worker_context",
          bounded_value: { candidates: ["src/a.ts"] },
        });
        expect(feedback).toHaveProperty("value_id");
        return {
          content: "",
          toolCalls: [
            {
              id: "large-inspection",
              name: "execute",
              arguments: JSON.stringify({
                summary: "Inspect large candidate",
                javascript: `return ${JSON.stringify(largeValue)};`,
                result_for: "worker_context",
              }),
            },
          ],
        };
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          value_id: string;
          value_bytes: number;
          error: string;
        };
        expect(feedback.error).toContain("the limit is 12288");
        expect(feedback.value_bytes).toBeGreaterThan(12 * 1_024);
        expect(
          getProcResult({
            id: feedback.value_id,
            transactionId: transaction.id,
            conversationId,
          })?.value,
        ).toEqual(largeValue);
        return {
          content: "",
          toolCalls: [
            {
              id: "stop-after-overflow",
              name: "cannot_execute",
              arguments: JSON.stringify({ reason: "Test complete." }),
            },
          ],
        };
      });

    const outcome = await runProcWorker({
      transaction,
      capabilities: new Map(),
      facadeCapabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
      signal: new AbortController().signal,
    });

    expect(outcome.status).toBe("cannot_execute");
  });

  it("is constrained to frontier-authored procedures and fused executions", () => {
    expect(Buffer.byteLength(PROC_WORKER_SYSTEM)).toBeLessThanOrEqual(2_000);
    expect(PROC_WORKER_SYSTEM).toContain("without changing it");
    expect(PROC_WORKER_SYSTEM).toContain("broaden scope");
    expect(PROC_WORKER_SYSTEM).toContain("largest reliable execute call");
    expect(PROC_WORKER_SYSTEM).toContain(
      "procedure steps are not turn boundaries",
    );
    expect(PROC_WORKER_SYSTEM).toContain(
      "Treat result_requirements as the completion test",
    );
    expect(PROC_WORKER_SYSTEM).toContain(
      "required semantic judgment cannot be expressed as data operations",
    );
    expect(PROC_WORKER_SYSTEM).toContain("exactly one tool per turn");
    expect(PROC_WORKER_SYSTEM).not.toContain("ask_user");
  });

  it("ignores action return values and continues without a checkpoint", async () => {
    const recordAction = {
      name: "record_action",
      description: "Record an action",
      parameters: { type: "object" },
      program: {
        catalogDescription: "record an action",
        operationCategory: "mutation" as const,
        resultSchema: { type: "object" },
        example: "tools.record_action({})",
        contractVersion: "1",
      },
      handler: vi.fn(async () => ({
        ok: true as const,
        summary: "recorded",
        result: { ticket_id: "T1" },
      })),
    };
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "action-with-implicit-value",
            name: "execute",
            arguments: JSON.stringify({
              summary: "Apply action",
              javascript: "tools.record_action({});",
              result_for: "no_one",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as Record<
          string,
          unknown
        >;
        expect(feedback).toMatchObject({
          result_for: "no_one",
          operations: 1,
          effects: [
            { tool: "record_action", effect: "mutation", ok: true, count: 1 },
          ],
          effects_total: 1,
        });
        expect(feedback).not.toHaveProperty("value_id");
        expect(feedback).not.toHaveProperty("bounded_value");
        return {
          content: "",
          toolCalls: [
            {
              id: "complete-actions",
              name: "execute",
              arguments: JSON.stringify({
                summary: "Return action evidence",
                javascript: "return { changed: ['src/a.ts'] };",
                result_for: "proc_result",
              }),
            },
          ],
        };
      });

    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc actions",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const outputPolicy = {
      mode: "exact" as const,
      maxBytes: 4096,
      store: false,
    };
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 41,
      workerModel: "pi-stub/stub-model",
      summary: "Apply actions",
      requirements: "Return changed paths",
      procedure: "Apply actions and report changed paths",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Apply actions",
        requirements: "Return changed paths",
        procedure: "Apply actions and report changed paths",
        outputPolicy,
        contracts: [],
      }),
    });

    const outcome = await runProcWorker({
      transaction,
      capabilities: new Map([[recordAction.name, recordAction]]),
      facadeCapabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: "completed",
      projection: { changed: ["src/a.ts"] },
      usage: { turns: 2, executions: 2 },
    });
    expect(recordAction.handler).toHaveBeenCalledOnce();
  });

  it("composes an exact saved value and completes with a fused final execution", async () => {
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
              result_for: "later_javascript",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const prior = JSON.parse(messages.at(-1).content) as {
          value_id: string;
        };
        return {
          content: "",
          toolCalls: [
            {
              id: "atom-2",
              name: "execute",
              arguments: JSON.stringify({
                summary: "Add definition extents",
                javascript: `return loadValue(${JSON.stringify(prior.value_id)}).map(row => ({ ...row, end: row.line + 5 }));`,
                result_for: "proc_result",
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
      requirements: "Return paths and ranges",
      procedure: "Create candidates, then add extents",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Find owner",
        requirements: "Return paths and ranges",
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
          output: expect.stringContaining("structure"),
        }),
      ]),
    );
    const savedValueFeedback = JSON.parse(
      transaction.messages[3].content as string,
    ) as { value_id: string };
    expect(savedValueFeedback.value_id).toBeTruthy();
    const workerTools = piChat.mock.calls[0][2] as Array<{
      function: {
        name: string;
        parameters: {
          properties: Record<string, unknown>;
          required: string[];
        };
      };
    }>;
    expect(workerTools.map((tool) => tool.function.name)).toEqual([
      "execute",
      "cannot_execute",
    ]);
    expect(piChat.mock.calls[0][0]).toMatchObject({ maxTokens: 32 * 1024 });
    expect(Buffer.byteLength(JSON.stringify(workerTools))).toBeLessThanOrEqual(
      2_500,
    );
    expect(workerTools[0]?.function.parameters.properties).not.toHaveProperty(
      "max_bytes",
    );
    expect(
      workerTools[0]?.function.parameters.properties.javascript,
    ).toMatchObject({
      description: expect.stringContaining("result_for is no_one"),
    });
    expect(
      workerTools[0]?.function.parameters.properties.result_for,
    ).toMatchObject({
      enum: ["no_one", "later_javascript", "worker_context", "proc_result"],
      description: expect.stringContaining("Who needs the returned value"),
    });
    expect(workerTools[0]?.function.parameters.required).toContain(
      "result_for",
    );
    expect(PROC_WORKER_SYSTEM).not.toContain(
      "Return a final value matching output.contract",
    );
    const initial = JSON.parse(transaction.messages[1].content as string) as {
      result_requirements: string;
      max_result_bytes: number;
      output?: unknown;
      environment: { tools: unknown[]; globals: { fs: string[] } };
    };
    expect(initial).toMatchObject({
      result_requirements: "Return paths and ranges",
      max_result_bytes: 4096,
    });
    expect(initial).not.toHaveProperty("output");
    expect(initial.environment.tools).toEqual(contracts);
    expect(initial.environment.globals.fs).toContainEqual(
      expect.stringContaining("glob(pattern: string | string[]"),
    );
    expect(initial.environment.globals.fs).toContainEqual(
      expect.stringContaining(
        "grep(pattern: string, { path?, glob?: string | string[]",
      ),
    );
    expect(initial.environment.globals.fs).not.toContainEqual(
      expect.stringContaining("readdir"),
    );
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
              result_for: "proc_result",
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
      requirements: "Return a result",
      procedure: "Perform unsupported operation",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Unsupported proc",
        requirements: "Return a result",
        procedure: "Perform unsupported operation",
        outputPolicy,
        contracts: [],
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
      status: "cannot_execute",
      summary: "The requested operation is unsupported.",
      usage: { turns: 2, executions: 1 },
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool.result",
        ok: false,
        summary: "Failed",
        output: expect.stringContaining('"error":"bad atom"'),
      }),
    );
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
              result_for: "proc_result",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          retry_safe: boolean;
          effects: Array<{
            tool: string;
            effect: string;
            ok: boolean;
            count: number;
          }>;
          effects_total: number;
          instruction: string;
        };
        expect(feedback.retry_safe).toBe(false);
        expect(feedback.effects).toEqual([
          {
            tool: "write_fixture",
            effect: "mutation",
            ok: true,
            count: 1,
          },
        ]);
        expect(feedback.effects_total).toBe(1);
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
      requirements: "Return validation status",
      procedure: "Write a fixture and validate it",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Mutating proc",
        requirements: "Return validation status",
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

  it("runs a proc git commit through the delegated permission gate on approval", async () => {
    const commitHandler = vi.fn(async (args: Record<string, unknown>) => {
      // Only the realizer sees the raw args; the frontier sees the projection.
      return ok({
        sha: "abc123def456",
        shortSha: "abc123de",
        subject: String(args.subject),
        body: "frontier body",
        mergeCommit: false,
        resolvedConflicts: [],
      });
    });
    const commit = attachProgramMetadata({
      name: "git_commit",
      description: "Create a commit over path selections",
      parameters: { type: "object" },
      permissionBehavior: "always-prompt",
      handler: commitHandler,
    });
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "do-commit",
            name: "execute",
            arguments: JSON.stringify({
              summary: "Commit",
              javascript:
                "return git.commit({ paths: 'all', subject: 'Frontier subject' });",
              result_for: "proc_result",
            }),
          },
        ],
      })
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [],
      });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc git commit",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const outputPolicy = {
      mode: "exact" as const,
      maxBytes: 4096,
      store: false,
    };
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 45,
      workerModel: "pi-stub/stub-model",
      summary: "Commit",
      requirements: "Return the commit result",
      procedure: "Commit all changes with the frontier subject",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Commit",
        requirements: "Return the commit result",
        procedure: "Commit all changes with the frontier subject",
        outputPolicy,
        contracts: [],
      }),
    });
    const calls: Array<[string, Record<string, unknown>]> = [];
    const outcome = await runProcWorker({
      transaction,
      capabilities: programCapabilities(new Map([[commit.name, commit]])),
      facadeCapabilities: new Map(),
      permissionResolver: async (name, args) => {
        calls.push([name, args]);
        return { allow: true };
      },
      emit: () => {},
      signal: new AbortController().signal,
    });
    expect(outcome.status).toBe("completed");
    expect(outcome.projection).toMatchObject({
      sha: "abc123def456",
      shortSha: "abc123de",
      subject: "Frontier subject",
      mergeCommit: false,
      resolvedConflicts: [],
    });
    // The always-prompt gate is routed through the shared resolver with the
    // capability name + args (AC3), and the frontier-authored message reaches
    // the tool runtime verbatim (D2).
    expect(calls).toEqual([
      ["git_commit", { paths: "all", subject: "Frontier subject" }],
    ]);
    expect(commitHandler).toHaveBeenCalledWith({
      paths: "all",
      subject: "Frontier subject",
    });
  });

  it("returns a structured failure on permission denial of a proc git commit", async () => {
    const commit = attachProgramMetadata({
      name: "git_commit",
      description: "Create a commit over path selections",
      parameters: { type: "object" },
      permissionBehavior: "always-prompt",
      async handler() {
        return ok({ sha: "unreached" });
      },
    });
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "denied-commit",
            name: "execute",
            arguments: JSON.stringify({
              summary: "Commit",
              javascript: "return git.commit({ paths: 'all', subject: 'x' });",
              result_for: "proc_result",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          ok: boolean;
          error: string;
          retry_safe: boolean;
        };
        expect(feedback.ok).toBe(false);
        expect(feedback.error).toContain("Permission denied");
        expect(feedback.retry_safe).toBe(false);
        return {
          content: "",
          toolCalls: [
            {
              id: "abort-after-denial",
              name: "cannot_execute",
              arguments: JSON.stringify({
                reason: "Commit was not approved.",
              }),
            },
          ],
        };
      });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc git commit denied",
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
      parentToolCallId: 46,
      workerModel: "pi-stub/stub-model",
      summary: "Commit",
      requirements: "Return the commit result",
      procedure: "Commit all changes",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Commit",
        requirements: "Return the commit result",
        procedure: "Commit all changes",
        outputPolicy,
        contracts: [],
      }),
    });
    const outcome = await runProcWorker({
      transaction,
      capabilities: programCapabilities(new Map([[commit.name, commit]])),
      facadeCapabilities: new Map(),
      permissionResolver: async (name) => {
        expect(name).toBe("git_commit");
        return { allow: false, reason: "Permission denied by policy." };
      },
      emit: () => {},
      signal: new AbortController().signal,
    });
    // A denial is not a dangling execution: the transaction completes cleanly
    // as cannot_execute and the frontier can react.
    expect(outcome.status).toBe("cannot_execute");
  });
});
