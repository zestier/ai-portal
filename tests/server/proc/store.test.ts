import { beforeEach, describe, expect, it } from "vitest";
import { conversationId as convCodec } from "../../../src/lib/ids";
import { setupLocalEnv } from "../../helpers/env";
import * as users from "../../../src/lib/server/db/repos/users";
import * as conversations from "../../../src/lib/server/db/repos/conversations";
import {
  commitProcStoreWrites,
  createNamedProcResult,
  createProcResult,
  createProcTransaction,
  getNamedProcResult,
  getProcResult,
  createProcValueReader,
  getProcTransaction,
  getProcStoreSnapshot,
  updateProcTransaction,
} from "../../../src/lib/server/proc/store";

describe("proc store", () => {
  beforeEach(async () => {
    await setupLocalEnv("proc-store-");
  });

  it("persists transactions and immutable conversation-scoped results", () => {
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "proc",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 9,
      workerModel: "pi-stub/stub-model",
      summary: "Find owners",
      requirements: "Return paths and line ranges",
      procedure: "grep, group, read context",
      outputPolicy: { mode: "shape", maxBytes: 4096, store: true },
      messages: [{ role: "system", content: "proc" }],
    });
    const first = createProcResult({
      transactionId: transaction.id,
      conversationId,
      value: [{ path: "src/a.ts", line: 4 }],
    });
    const second = createProcResult({
      transactionId: transaction.id,
      conversationId,
      value: { selected: [first.id] },
    });

    expect(
      getProcResult({
        id: first.id,
        transactionId: transaction.id,
        conversationId,
      }),
    ).toEqual({
      value: [{ path: "src/a.ts", line: 4 }],
      bytes: expect.any(Number),
    });
    const savedValues = createProcValueReader(transaction.id, conversationId);
    expect(savedValues.get(first.id)).toEqual([{ path: "src/a.ts", line: 4 }]);
    expect(savedValues.get(second.id)).toEqual({ selected: [first.id] });
    expect(savedValues.get("RES_unknown")).toBeUndefined();
    expect(
      getProcResult({
        id: first.id,
        transactionId: transaction.id,
        conversationId: conversationId + 1,
      }),
    ).toBeNull();

    transaction.status = "completed";
    transaction.resultId = second.id;
    transaction.usage.executions = 2;
    updateProcTransaction(transaction);
    expect(getProcTransaction(transaction.id, conversationId)).toMatchObject({
      status: "completed",
      requirements: "Return paths and line ranges",
      resultId: second.id,
      usage: { executions: 2 },
    });
  });

  it("retains named values for audit after closing execution access", () => {
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "named proc values",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 10,
      workerModel: "pi-stub/stub-model",
      summary: "Save candidates",
      requirements: "Return candidates",
      procedure: "Collect candidates",
      outputPolicy: { mode: "shape", maxBytes: 4096, store: true },
      messages: [{ role: "system", content: "proc" }],
    });

    expect(
      createNamedProcResult({
        transactionId: transaction.id,
        conversationId,
        name: "candidates",
        value: ["src/a.ts"],
      }),
    ).toEqual({ id: "candidates", bytes: expect.any(Number) });
    expect(
      createProcValueReader(transaction.id, conversationId).get("candidates"),
    ).toEqual(["src/a.ts"]);
    createNamedProcResult({
      transactionId: transaction.id,
      conversationId,
      name: "RES_candidates",
      value: ["src/b.ts"],
    });
    expect(
      createProcValueReader(transaction.id, conversationId).get(
        "RES_candidates",
      ),
    ).toEqual(["src/b.ts"]);
    expect(() =>
      createNamedProcResult({
        transactionId: transaction.id,
        conversationId,
        name: "candidates",
        value: [],
      }),
    ).toThrow("Saved value name already exists: candidates");

    const finalResult = createProcResult({
      transactionId: transaction.id,
      conversationId,
      value: { selected: "src/a.ts" },
    });
    transaction.status = "completed";
    transaction.resultId = finalResult.id;
    updateProcTransaction(transaction);
    expect(
      getNamedProcResult({
        name: "candidates",
        transactionId: transaction.id,
        conversationId,
      })?.value,
    ).toEqual(["src/a.ts"]);
    expect(
      getNamedProcResult({
        name: "RES_candidates",
        transactionId: transaction.id,
        conversationId,
      })?.value,
    ).toEqual(["src/b.ts"]);
    expect(
      createProcValueReader(transaction.id, conversationId).get("candidates"),
    ).toBeUndefined();
    expect(
      getProcResult({
        id: finalResult.id,
        transactionId: transaction.id,
        conversationId,
      })?.value,
    ).toEqual({ selected: "src/a.ts" });
  });

  it("versions mutable store writes and reconstructs historical snapshots", () => {
    const user = users.ensureLocalUser();
    const conversation = conversations.create(user.id, {
      title: "versioned proc store",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const conversationId = convCodec.parse(conversation.id);
    const transaction = createProcTransaction({
      conversationId,
      parentToolCallId: 11,
      workerModel: "pi-stub/stub-model",
      summary: "Version values",
      requirements: "Return latest values",
      procedure: "Write and replace values",
      outputPolicy: { mode: "shape", maxBytes: 4096, store: true },
      messages: [{ role: "system", content: "proc" }],
    });

    const first = commitProcStoreWrites({
      transactionId: transaction.id,
      conversationId,
      toolCallId: 101,
      writes: { foo: { value: 1 } },
    });
    const second = commitProcStoreWrites({
      transactionId: transaction.id,
      conversationId,
      toolCallId: 102,
      writes: { bar: [2], foo: { value: 3 } },
    });

    expect(first).toMatchObject({
      toolCallId: 101,
      bindings: [{ name: "foo", toolCallId: 101 }],
      snapshot: { foo: { toolCallId: 101 } },
    });
    expect(second).toMatchObject({
      toolCallId: 102,
      bindings: [
        { name: "bar", toolCallId: 102 },
        { name: "foo", toolCallId: 102 },
      ],
      snapshot: {
        bar: { toolCallId: 102 },
        foo: { toolCallId: 102 },
      },
    });
    expect(
      getProcStoreSnapshot({
        transactionId: transaction.id,
        conversationId,
        atToolCallId: 101,
      }),
    ).toEqual(first.snapshot);
    const reader = createProcValueReader(transaction.id, conversationId);
    expect(reader.get("foo")).toEqual({ value: 3 });
    expect(reader.get("bar")).toEqual([2]);
    expect(
      getProcResult({
        id: first.bindings[0]!.resultId,
        transactionId: transaction.id,
        conversationId,
      }),
    ).toMatchObject({ value: { value: 1 } });
  });
});
