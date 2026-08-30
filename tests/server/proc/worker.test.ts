import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationId as convCodec } from "../../../src/lib/ids";
import { setupLocalEnv } from "../../helpers/env";
import * as users from "../../../src/lib/server/db/repos/users";
import * as conversations from "../../../src/lib/server/db/repos/conversations";
import {
  createProcTransaction,
  createProcValueReader,
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
      summary: expect.stringContaining("Transcript 132163B"),
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
      summary: expect.stringContaining("execute: 409600B arguments"),
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

  it("preserves primary-agent procedures and safe fusion", () => {
    expect(Buffer.byteLength(PROC_WORKER_SYSTEM)).toBeLessThanOrEqual(2_000);
    expect(PROC_WORKER_SYSTEM).toContain("Do not change goals");
    expect(PROC_WORKER_SYSTEM).toContain(
      "Use the fewest executions preserving correctness",
    );
    expect(PROC_WORKER_SYSTEM).toContain(
      "Procedure steps are not execution boundaries",
    );
    expect(PROC_WORKER_SYSTEM).toContain(
      "Logs are parsed into your next turn and consume context",
    );
    expect(PROC_WORKER_SYSTEM).toContain("Log minimum evidence");
    expect(PROC_WORKER_SYSTEM).toContain("exact allowlist");
    expect(PROC_WORKER_SYSTEM).toContain("run sequentially");
    expect(PROC_WORKER_SYSTEM).toContain("finish returns the final result");
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
              needed_for: "Applying the requested repository mutation",
              javascript: "tools.record_action({});",
              save_as: null,
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
          save_as: null,
          operations: 1,
          effects: [
            { tool: "record_action", effect: "mutation", ok: true, count: 1 },
          ],
          effects_total: 1,
        });
        expect(feedback).not.toHaveProperty("value_id");
        expect(feedback).not.toHaveProperty("decision_evidence");
        return {
          content: "",
          toolCalls: [
            {
              id: "complete-actions",
              name: "finish",
              arguments: JSON.stringify({
                javascript: "return { changed: ['src/a.ts'] };",
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
    piChat.mockResolvedValueOnce({
      content: "",
      toolCalls: [
        {
          id: "atom-1",
          name: "execute",
          arguments: JSON.stringify({
            needed_for: "Candidate definitions",
            javascript: "return [{ path: 'src/a.ts', line: 10 }];",
            save_as: "candidates",
          }),
        },
        {
          id: "atom-2",
          name: "finish",
          arguments: JSON.stringify({
            javascript:
              "return loadValue('candidates').map(row => ({ ...row, end: row.line + 5 }));",
          }),
        },
      ],
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
      usage: { turns: 1, executions: 2, operations: 0 },
    });
    expect(outcome.resultId).toBeTruthy();
    expect(
      getProcResult({
        id: outcome.resultId!,
        transactionId: transaction.id,
        conversationId,
      })?.value,
    ).toEqual([{ path: "src/a.ts", line: 10, end: 15 }]);
    expect(
      createProcValueReader(transaction.id, conversationId).get("candidates"),
    ).toBeUndefined();
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
      transaction.messages.find((message) => message.role === "tool")
        ?.content as string,
    ) as { save_as: string };
    expect(savedValueFeedback.save_as).toBe("candidates");
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
      "finish",
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
      description: expect.stringContaining("Return a serializable value"),
    });
    expect(
      workerTools[0]?.function.parameters.properties.save_as,
    ).toMatchObject({
      type: ["string", "null"],
      description: expect.stringContaining("Unique loadValue(name) key"),
    });
    expect(
      workerTools[0]?.function.parameters.properties.needed_for,
    ).toMatchObject({
      description: "Short required outcome; not the operation.",
    });
    expect(workerTools[0]?.function.parameters.required).toContain("save_as");
    expect(workerTools[0]?.function.parameters.required).toContain(
      "needed_for",
    );
    expect(workerTools[0]?.function.parameters.properties).not.toHaveProperty(
      "summary",
    );
    expect(PROC_WORKER_SYSTEM).not.toContain(
      "Return a final value matching output.contract",
    );
    expect(
      transaction.messages.slice(0, 2).map((message) => message.role),
    ).toEqual(["system", "user"]);
    const environment = transaction.messages[0].content as string;
    const request = transaction.messages[1].content as string;
    expect(environment).toContain(
      "For listed namespaces, use only shown methods:",
    );
    expect(environment).toContain("fs.glob(pattern,");
    expect(environment).toContain("fs.grep(pattern,");
    expect(environment).not.toContain("fs.readdir");
    expect(environment).toContain("tools.grep({}): {}");
    expect(environment).not.toContain(" -> ");
    expect(environment).not.toContain("; accepts ");
    expect(environment).toContain("path.isAbsolute(path)");
    expect(environment).not.toContain("path.isAbsolute(path): boolean");
    expect(environment).toContain(
      "fs.rm(path, { recursive?, force? }): trashPath? // reversible",
    );
    expect(environment).not.toContain("fs.unlink");
    const capabilityLines = environment
      .split("\n\nFor listed namespaces, use only shown methods:\n\n")[1]
      .split("\n");
    expect(capabilityLines).toEqual(
      [...capabilityLines].sort((left, right) => left.localeCompare(right)),
    );
    expect(request).toBe(
      "Procedure\n\nSummary\nFind owner\n\nInstructions\nCreate candidates, then add extents\n\nResult requirements\nReturn paths and ranges",
    );
    expect(request).not.toContain("max_result_bytes");
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
              needed_for: "Returning the requested unsupported result",
              javascript: "throw new Error('bad atom');",
              save_as: null,
            }),
          },
          {
            id: "cancelled-finish",
            name: "finish",
            arguments: JSON.stringify({
              javascript: "throw new Error('must not execute');",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        expect(messages.at(-2).content).toContain("bad atom");
        expect(messages.at(-1).content).toContain(
          "Cancelled because an earlier call in this batch failed",
        );
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

  it("shows bounded console evidence while preserving the full returned value", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "capture-evidence",
            name: "execute",
            arguments: JSON.stringify({
              needed_for: "Choosing the file that owns the schema",
              javascript:
                "const full = [{ path: 'src/a.ts', content: 'x'.repeat(4096) }]; console.log({ candidates: full.map(({ path }) => path) }); return full;",
              save_as: "candidates",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          worker_output: unknown;
        };
        expect(feedback.worker_output).toEqual([
          {
            level: "log",
            values: [{ candidates: ["src/a.ts"] }],
          },
        ]);
        return {
          content: "",
          toolCalls: [
            {
              id: "complete-from-saved",
              name: "finish",
              arguments: JSON.stringify({
                javascript:
                  "return { selected: loadValue('candidates')[0].path };",
              }),
            },
          ],
        };
      });

    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "console evidence",
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
      parentToolCallId: 43,
      workerModel: "pi-stub/stub-model",
      summary: "Choose schema owner",
      requirements: "Return selected path",
      procedure: "Inspect candidates and select their owner",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Choose schema owner",
        requirements: "Return selected path",
        procedure: "Inspect candidates and select their owner",
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
      status: "completed",
      projection: { selected: "src/a.ts" },
      usage: {
        savedValuesCreated: 1,
        savedValuesLoaded: 1,
        consoleAttempts: 1,
        workerVisibleOutputs: 1,
        nonProgressExecutions: 0,
      },
    });
  });

  it("retains the returned value when console evidence exceeds its guard", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "oversized-console",
            name: "execute",
            arguments: JSON.stringify({
              needed_for: "Preserving results while inspecting evidence",
              javascript:
                "const full = { selected: 'src/a.ts' }; console.log('x'.repeat(65 * 1024)); return full;",
              save_as: "full_result",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          value_bytes: number;
          error: string;
          instruction: string;
        };
        expect(feedback.error).toContain("transport limit 65536B");
        expect(feedback.value_bytes).toBeGreaterThan(0);
        expect(feedback.instruction).toContain('loadValue("full_result")');
        return {
          content: "",
          toolCalls: [
            {
              id: "recover-console-overflow",
              name: "finish",
              arguments: JSON.stringify({
                javascript: "return loadValue('full_result');",
              }),
            },
          ],
        };
      });

    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "console overflow",
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
      summary: "Recover console overflow",
      requirements: "Return selected path",
      procedure: "Inspect and return selected path",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Recover console overflow",
        requirements: "Return selected path",
        procedure: "Inspect and return selected path",
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
      status: "completed",
      projection: { selected: "src/a.ts" },
      usage: {
        savedValuesCreated: 1,
        savedValuesLoaded: 1,
        consoleAttempts: 1,
        workerVisibleOutputs: 0,
      },
    });
  });

  it("warns after consecutive shape-only saved-value resaves", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "initial-save",
            name: "execute",
            arguments: JSON.stringify({
              needed_for: "Preserving candidates for later filtering",
              javascript: "return ['src/a.ts'];",
              save_as: "candidates",
            }),
          },
        ],
      })
      .mockImplementationOnce(async () => {
        return {
          content: "",
          toolCalls: [
            {
              id: "resave-one",
              name: "execute",
              arguments: JSON.stringify({
                needed_for: "Inspecting the saved candidates",
                javascript: "return loadValue('candidates');",
                save_as: "candidates_copy",
              }),
            },
          ],
        };
      })
      .mockImplementationOnce(async () => {
        return {
          content: "",
          toolCalls: [
            {
              id: "resave-two",
              name: "execute",
              arguments: JSON.stringify({
                needed_for: "Inspecting the saved candidates",
                javascript: "return loadValue('candidates_copy');",
                save_as: "candidates_copy_2",
              }),
            },
          ],
        };
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          warnings: string[];
        };
        expect(feedback.warnings).toContain(
          "2 unchanged load-resave cycles. Stop resaving unchanged data.",
        );
        return {
          content: "",
          toolCalls: [
            {
              id: "finish-resaves",
              name: "finish",
              arguments: JSON.stringify({
                javascript: "return ['src/a.ts'];",
              }),
            },
          ],
        };
      });

    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "resave warning",
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
      parentToolCallId: 44,
      workerModel: "pi-stub/stub-model",
      summary: "Inspect candidates",
      requirements: "Return candidates",
      procedure: "Inspect and return candidates",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Inspect candidates",
        requirements: "Return candidates",
        procedure: "Inspect and return candidates",
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
      status: "completed",
      usage: {
        savedValuesCreated: 3,
        savedValuesLoaded: 2,
        nonProgressExecutions: 2,
      },
    });
  });

  it("warns about read-heavy traversal before the hard operation limit", async () => {
    const readValue = {
      name: "read_value",
      description: "Read one value",
      parameters: { type: "object" },
      program: {
        catalogDescription: "read one value",
        operationCategory: "read" as const,
        resultSchema: { type: "number" },
        example: "tools.read_value({ index: 1 })",
        contractVersion: "1",
      },
      handler: vi.fn(async () => ok(1)),
    };
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "read-heavy",
            name: "execute",
            arguments: JSON.stringify({
              needed_for: "Preserving the aggregated read result",
              javascript:
                "let total = 0; for (let index = 0; index < 200; index++) total += tools.read_value({ index }); return total;",
              save_as: "total",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          warnings: string[];
          operations: number;
        };
        expect(feedback.operations).toBe(200);
        expect(feedback.warnings).toContain(
          "200 operations. Use fs.glob/fs.grep or batch work; avoid path-by-path traversal.",
        );
        return {
          content: "",
          toolCalls: [
            {
              id: "finish-heavy-read",
              name: "finish",
              arguments: JSON.stringify({
                javascript: "return { total: 200 };",
              }),
            },
          ],
        };
      });

    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "operation warning",
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
      parentToolCallId: 46,
      workerModel: "pi-stub/stub-model",
      summary: "Aggregate reads",
      requirements: "Return total",
      procedure: "Read and aggregate values",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Aggregate reads",
        requirements: "Return total",
        procedure: "Read and aggregate values",
        outputPolicy,
        contracts: [],
      }),
    });

    const outcome = await runProcWorker({
      transaction,
      capabilities: new Map([[readValue.name, readValue]]),
      facadeCapabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: "completed",
      projection: { total: 200 },
      usage: { operations: 200 },
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
              needed_for: "Applying the requested write",
              javascript:
                "tools.write_fixture({}); throw new Error('after write');",
              save_as: null,
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
      // Only the realizer sees raw args; the primary agent sees the projection.
      return ok({
        sha: "abc123def456",
        shortSha: "abc123de",
        subject: String(args.subject),
        body: "primary body",
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
            name: "finish",
            arguments: JSON.stringify({
              javascript:
                "return git.commit({ paths: 'all', subject: 'Primary subject' });",
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
      procedure: "Commit all changes with the primary-agent subject",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Commit",
        requirements: "Return the commit result",
        procedure: "Commit all changes with the primary-agent subject",
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
      subject: "Primary subject",
      mergeCommit: false,
      resolvedConflicts: [],
    });
    // The always-prompt gate is routed through the shared resolver with the
    // capability name + args (AC3), and the primary-agent message reaches
    // the tool runtime verbatim (D2).
    expect(calls).toEqual([
      ["git_commit", { paths: "all", subject: "Primary subject" }],
    ]);
    expect(commitHandler).toHaveBeenCalledWith({
      paths: "all",
      subject: "Primary subject",
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
              needed_for: "Creating the requested commit",
              javascript: "return git.commit({ paths: 'all', subject: 'x' });",
              save_as: null,
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
    // as cannot_execute and the primary agent can react.
    expect(outcome.status).toBe("cannot_execute");
  });
});
