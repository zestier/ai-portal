import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationId as convCodec } from "../../../src/lib/ids";
import { setupLocalEnv } from "../../helpers/env";
import * as users from "../../../src/lib/server/db/repos/users";
import * as conversations from "../../../src/lib/server/db/repos/conversations";
import {
  createProcTransaction,
  createProcValueReader,
  getProcStoreSnapshot,
  getProcResult,
} from "../../../src/lib/server/proc/store";
import {
  initialProcMessages,
  procTranscriptStats,
  PROC_WORKER_SYSTEM,
  runProcWorker as runProcWorkerImpl,
  summarizeExecutionEffects,
} from "../../../src/lib/server/proc/worker";

type TestProcWorkerOptions = Omit<
  Parameters<typeof runProcWorkerImpl>[0],
  "cwd"
> & { cwd?: string };
const runProcWorker = (options: TestProcWorkerOptions) =>
  runProcWorkerImpl({ cwd: process.cwd(), ...options });
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
        { role: "user", content: "x".repeat(257 * 1_024) },
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
      summary: expect.stringContaining("Transcript 263235B"),
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
    expect(PROC_WORKER_SYSTEM).not.toContain("ask_user");
  });

  it("runs worker JavaScript with the session working directory", async () => {
    piChat.mockResolvedValueOnce({
      content: "",
      toolCalls: [
        {
          id: "finish-cwd",
          name: "finish",
          arguments: JSON.stringify({
            javascript: "return process.cwd();",
          }),
        },
      ],
    });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc cwd",
      workdir: "/tmp/session-workdir",
      model: "pi-stub/stub-model",
    });
    const transaction = createProcTransaction({
      conversationId: convCodec.parse(conversation.id),
      parentToolCallId: 43,
      workerModel: "pi-stub/stub-model",
      summary: "Read cwd",
      requirements: "Return the session cwd",
      procedure: "Return process.cwd()",
      outputPolicy: { mode: "exact", maxBytes: 1_024, store: false },
      messages: initialProcMessages({
        summary: "Read cwd",
        requirements: "Return the session cwd",
        procedure: "Return process.cwd()",
        outputPolicy: { mode: "exact", maxBytes: 1_024, store: false },
        contracts: [],
      }),
    });

    const outcome = await runProcWorker({
      transaction,
      cwd: conversation.workdir,
      capabilities: new Map(),
      facadeCapabilities: new Map(),
      permissionResolver: async () => ({ allow: true }),
      emit: () => {},
      signal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: "completed",
      projection: "/tmp/session-workdir",
    });
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
              javascript: "return tools.record_action({});",
              store_into: null,
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
          store_writes: [],
          store_snapshot: {},
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
            javascript: "store.candidates = [{ path: 'src/a.ts', line: 10 }];",
          }),
        },
        {
          id: "atom-2",
          name: "finish",
          arguments: JSON.stringify({
            javascript:
              "const { candidates } = store; return candidates.map(row => ({ ...row, end: row.line + 5 }));",
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
      getProcResult({
        id: Object.values(
          getProcStoreSnapshot({
            transactionId: transaction.id,
            conversationId,
          }),
        )[0]!.resultId,
        transactionId: transaction.id,
        conversationId,
      })?.value,
    ).toEqual([{ path: "src/a.ts", line: 10 }]);
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
          output: expect.stringContaining("shape"),
        }),
      ]),
    );
    const savedValueFeedback = JSON.parse(
      transaction.messages.find((message) => message.role === "tool")
        ?.content as string,
    ) as {
      store_writes: Array<{ name: string; shape: string }>;
      store_snapshot: Record<string, { resultId: string }>;
    };
    expect(savedValueFeedback.store_writes).toMatchObject([
      {
        name: "candidates",
        shape: "array(1) of object { line: integer, path: string }",
      },
    ]);
    expect(savedValueFeedback.store_snapshot).toHaveProperty("candidates");
    const workerTools = piChat.mock.calls[0][2] as Array<{
      function: {
        name: string;
        description: string;
        parameters: {
          properties: Record<string, Record<string, unknown>>;
          required: string[];
        };
      };
    }>;
    expect(workerTools.map((tool) => tool.function.name)).toEqual([
      "execute",
      "view",
      "finish",
      "cannot_execute",
    ]);
    expect(piChat.mock.calls[0][0]).toMatchObject({ maxTokens: 32 * 1024 });
    expect(Buffer.byteLength(JSON.stringify(workerTools))).toBeLessThanOrEqual(
      2_500,
    );
    expect(workerTools[0]?.function.parameters.properties).not.toHaveProperty(
      "worker_view",
    );
    expect(workerTools[0]?.function.parameters.properties).not.toHaveProperty(
      "worker_view_max_bytes",
    );
    expect(
      workerTools[1]?.function.parameters.properties.max_bytes,
    ).toMatchObject({ type: "integer", minimum: 1, maximum: 64 * 1024 });
    expect(workerTools[0]?.function.parameters.properties.javascript).toEqual(
      expect.objectContaining({ type: "string" }),
    );
    expect(workerTools[0]?.function.parameters.properties).not.toHaveProperty(
      "store_into",
    );
    expect(workerTools[0]?.function.parameters.properties.needed_for).toEqual(
      expect.objectContaining({ type: "string" }),
    );
    expect(workerTools[0]?.function.description).toBe(
      "Run JavaScript; persist store assignments; continue.",
    );
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
      "Use only listed APIs or standard JavaScript built-ins.",
    );
    expect(environment).toContain("search.glob(pattern,");
    expect(environment).toContain("search.grep(pattern,");
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
      .split(
        "\n\nUse only listed APIs or standard JavaScript built-ins.\n\n",
      )[1]
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
              store_into: null,
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

  it("continues independent calls after a retry-safe batch failure", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "failed-read",
            name: "view",
            arguments: JSON.stringify({
              needed_for: "A missing value",
              javascript: "throw new Error('missing');",
              max_bytes: 100,
            }),
          },
          {
            id: "independent-read",
            name: "execute",
            arguments: JSON.stringify({
              needed_for: "An independent value",
              javascript: "const answer = 42;",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        expect(messages.at(-2).content).toContain("missing");
        expect(messages.at(-1).content).toContain('"store_writes":[]');
        return {
          content: "",
          toolCalls: [
            {
              id: "finish-after-recovery",
              name: "finish",
              arguments: JSON.stringify({ javascript: "return 42;" }),
            },
          ],
        };
      });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc retry-safe batch",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const transaction = createProcTransaction({
      conversationId: convCodec.parse(conversation.id),
      parentToolCallId: 41,
      workerModel: "pi-stub/stub-model",
      summary: "Recover a batch",
      requirements: "Return 42",
      procedure: "Read independent values and return 42",
      outputPolicy: { mode: "exact", maxBytes: 1_024, store: false },
      messages: initialProcMessages({
        summary: "Recover a batch",
        requirements: "Return 42",
        procedure: "Read independent values and return 42",
        outputPolicy: { mode: "exact", maxBytes: 1_024, store: false },
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

    expect(outcome).toMatchObject({ status: "completed", projection: 42 });
  });

  it("accepts legacy execute destinations as transient", async () => {
    piChat.mockResolvedValueOnce({
      content: "",
      toolCalls: [
        {
          id: "quoted-null",
          name: "execute",
          arguments: JSON.stringify({
            needed_for: "A transient value",
            javascript: "return 42;",
            store_into: "",
          }),
        },
        {
          id: "quoted-null",
          name: "execute",
          arguments: JSON.stringify({
            needed_for: "Another transient value",
            javascript: "return 42;",
            store_into: "null",
          }),
        },
        {
          id: "finish-quoted-null",
          name: "finish",
          arguments: JSON.stringify({ javascript: "return 42;" }),
        },
      ],
    });
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc quoted null",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const transaction = createProcTransaction({
      conversationId: convCodec.parse(conversation.id),
      parentToolCallId: 42,
      workerModel: "pi-stub/stub-model",
      summary: "Accept quoted null",
      requirements: "Return 42",
      procedure: "Return 42",
      outputPolicy: { mode: "exact", maxBytes: 1_024, store: false },
      messages: initialProcMessages({
        summary: "Accept quoted null",
        requirements: "Return 42",
        procedure: "Return 42",
        outputPolicy: { mode: "exact", maxBytes: 1_024, store: false },
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

    expect(outcome.status).toBe("completed");
    expect(outcome.usage.executions).toBe(3);
  });

  it("returns explicit shape feedback and warns without exposing console arguments", async () => {
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
                "const full = [{ path: 'src/a.ts', content: 'x'.repeat(4096) }]; console.log({ candidates: full.map(({ path }) => path) }); store.candidates = full;",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          store_writes: Array<{ shape: string }>;
          warnings: string[];
        };
        expect(feedback.store_writes[0]?.shape).toContain("path: string");
        expect(feedback.warnings).toEqual([
          "console is unsupported; discarded arguments from 1 call(s). Return required data instead.",
        ]);
        expect(feedback).not.toHaveProperty("worker_output");
        expect(feedback).not.toHaveProperty("value");
        return {
          content: "",
          toolCalls: [
            {
              id: "complete-from-saved",
              name: "finish",
              arguments: JSON.stringify({
                javascript:
                  "const { candidates } = store; return { selected: candidates[0].path };",
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
        nonProgressExecutions: 0,
      },
    });
  });

  it("requires a deliberate byte budget for exact view evidence", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "undersized-evidence",
            name: "view",
            arguments: JSON.stringify({
              needed_for: "Inspecting the exact selected result",
              javascript:
                "return { selected: path.basename('/tmp/src/a.ts') };",
              max_bytes: 8,
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          error: string;
        };
        expect(feedback.error).toContain("View 19B; current limit 8B");
        expect(feedback.error).toContain("Reduce or select ranges");
        return {
          content: "",
          toolCalls: [
            {
              id: "exact-evidence",
              name: "view",
              arguments: JSON.stringify({
                needed_for: "Inspecting the exact selected result",
                javascript:
                  "return { selected: path.basename('/tmp/src/a.ts') };",
                max_bytes: 128,
              }),
            },
          ],
        };
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          value: unknown;
          view_bytes: number;
        };
        expect(feedback.value).toEqual({ selected: "a.ts" });
        expect(feedback.view_bytes).toBeGreaterThan(0);
        return {
          content: "",
          toolCalls: [
            {
              id: "recover-console-overflow",
              name: "finish",
              arguments: JSON.stringify({
                javascript: "return { selected: 'a.ts' };",
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
      projection: { selected: "a.ts" },
      usage: {
        views: 2,
        viewBytes: 19,
      },
    });
  });

  it("falls back to a bounded shape without truncating the stored value", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "bounded-worker-view",
            name: "execute",
            arguments: JSON.stringify({
              needed_for: "Retaining source while inspecting its result form",
              javascript: "store.source = { content: 'x'.repeat(4096) };",
            }),
          },
        ],
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          store_writes: Array<{ shape: string; value_bytes: number }>;
          value?: unknown;
        };
        expect(feedback.store_writes[0]).toMatchObject({
          shape: "object { content: string }",
        });
        expect(feedback.store_writes[0]!.value_bytes).toBeGreaterThan(4096);
        expect(feedback).not.toHaveProperty("value");
        return {
          content: "",
          toolCalls: [
            {
              id: "verify-complete-store",
              name: "finish",
              arguments: JSON.stringify({
                javascript:
                  "const { source } = store; return { contentBytes: source.content.length };",
              }),
            },
          ],
        };
      });

    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "bounded worker view",
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
      parentToolCallId: 48,
      workerModel: "pi-stub/stub-model",
      summary: "Retain source",
      requirements: "Return retained content size",
      procedure: "Save the source and report its complete size",
      outputPolicy,
      messages: initialProcMessages({
        summary: "Retain source",
        requirements: "Return retained content size",
        procedure: "Save the source and report its complete size",
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
      projection: { contentBytes: 4096 },
      usage: { savedValuesCreated: 1, savedValuesLoaded: 1 },
    });
  });

  it("allows intentional same-key store overwrites", async () => {
    piChat
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [
          {
            id: "initial-save",
            name: "execute",
            arguments: JSON.stringify({
              needed_for: "Preserving candidates for later filtering",
              javascript: "store.candidates = ['src/a.ts'];",
            }),
          },
        ],
      })
      .mockImplementationOnce(async () => {
        return {
          content: "",
          toolCalls: [
            {
              id: "overwrite-candidates",
              name: "execute",
              arguments: JSON.stringify({
                needed_for: "Adding the second candidate",
                javascript:
                  "store.candidates = [...store.candidates, 'src/b.ts'];",
              }),
            },
          ],
        };
      })
      .mockImplementationOnce(async (_config, messages) => {
        const feedback = JSON.parse(messages.at(-1).content) as {
          store_writes: Array<{ name: string }>;
        };
        expect(feedback.store_writes).toMatchObject([{ name: "candidates" }]);
        return {
          content: "",
          toolCalls: [
            {
              id: "finish-resaves",
              name: "finish",
              arguments: JSON.stringify({
                javascript: "return store.candidates;",
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
      projection: ["src/a.ts", "src/b.ts"],
      usage: {
        savedValuesCreated: 2,
        savedValuesLoaded: 2,
        nonProgressExecutions: 0,
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
              store_into: "store.total",
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
          "200 operations. Use search.glob/search.grep or batch work; avoid path-by-path traversal.",
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
    let storedResultId = "";
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
                "tools.write_fixture({}); store.fileWritten = true; throw new Error('after write');",
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
          store_revision: string;
          store_writes: Array<{ name: string; result_id: string }>;
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
        expect(feedback.store_revision).toMatch(/^X\d+$/);
        expect(feedback.store_writes).toMatchObject([{ name: "fileWritten" }]);
        storedResultId = feedback.store_writes[0]!.result_id;
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
    expect(
      getProcResult({
        id: storedResultId,
        transactionId: transaction.id,
        conversationId,
      }),
    ).toMatchObject({ value: true });
    expect(
      getProcStoreSnapshot({
        transactionId: transaction.id,
        conversationId,
      }),
    ).toMatchObject({
      fileWritten: { resultId: storedResultId },
    });
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
              store_into: null,
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
