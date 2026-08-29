import { beforeEach, describe, expect, it } from "vitest";
import { conversationId as convCodec } from "../../../src/lib/ids";
import { setupLocalEnv } from "../../helpers/env";
import * as users from "../../../src/lib/server/db/repos/users";
import * as conversations from "../../../src/lib/server/db/repos/conversations";
import {
  createProcResult,
  createProcTransaction,
  getProcResult,
  createProcValueReader,
  getProcTransaction,
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
});
