import { beforeEach, describe, expect, it } from "vitest";
import { setupLocalEnv } from "../../helpers/env";
import * as users from "../../../src/lib/server/db/repos/users";
import * as conversations from "../../../src/lib/server/db/repos/conversations";
import {
  createArtifact,
  createTransaction,
  getTransaction,
  readArtifact,
} from "../../../src/lib/server/semantic/store";

describe("semantic transaction store", () => {
  beforeEach(async () => {
    await setupLocalEnv("semantic-store-");
  });

  it("persists resumable transactions and scopes artifacts to a conversation", () => {
    const user = users.ensureLocalUser();
    const first = conversations.create(user.id, {
      title: "first",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const second = conversations.create(user.id, {
      title: "second",
      workdir: "/tmp",
      model: "pi-stub/stub-model",
    });
    const firstId = Number(first.id.slice(1));
    const secondId = Number(second.id.slice(1));
    const transaction = createTransaction({
      conversationId: firstId,
      parentToolCallId: 7,
      workerModel: "pi-stub/stub-model",
      intent: "Find the owner",
      messages: [{ role: "user", content: "Find the owner" }],
    });
    const artifactId = createArtifact({
      transactionId: transaction.id,
      conversationId: firstId,
      kind: "evidence",
      content: "grounded evidence",
    });

    expect(getTransaction(transaction.id, firstId)?.intent).toBe(
      "Find the owner",
    );
    expect(
      readArtifact({
        id: artifactId,
        conversationId: firstId,
        kind: "evidence",
      })?.content,
    ).toBe("grounded evidence");
    expect(
      readArtifact({
        id: artifactId,
        conversationId: secondId,
        kind: "evidence",
      }),
    ).toBeNull();
  });
});
