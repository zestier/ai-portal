import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupLocalEnv } from "../helpers/env";
import { argsHash } from "../../src/lib/server/tool-invocation";
import { conversationId as convCodec } from "../../src/lib/ids";

const startTurnMock = vi.fn();
const getTurnMock = vi.fn();

vi.mock("../../src/lib/server/runtime/turn-runner", () => ({
  getTurn: (...args: unknown[]) => getTurnMock(...args),
  startTurn: (...args: unknown[]) => startTurnMock(...args),
}));

function request(body: unknown = {}) {
  return new Request("http://localhost/rerun", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("tool-call rerun endpoint", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-tool-rerun-");
    startTurnMock.mockReset();
    getTurnMock.mockReset();
    getTurnMock.mockReturnValue(null);
    startTurnMock.mockResolvedValue({
      id: "turn-rerun",
      conversationId: 1,
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      subscribe: async function* () {},
      abort: async () => {},
    });
  });

  async function fixture() {
    const users = await import("../../src/lib/server/db/repos/users");
    const convs = await import("../../src/lib/server/db/repos/conversations");
    const messages = await import("../../src/lib/server/db/repos/messages");
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "t",
      workdir: "/tmp",
      model: null,
    });
    const msg = messages.append(conv.id, { role: "assistant", content: "" });
    const args = { command: "echo approved" };
    messages.insertToolCall(msg.id, {
      id: 1,
      tool: "bash",
      argsJson: JSON.stringify(args),
      resultJson: JSON.stringify("Permission denied"),
      status: "denied",
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      textOffset: 0,
      parentToolCallId: null,
    });
    return { user, conv, messages };
  }

  it("creates a short-lived exact approval and starts a labeled rerun turn", async () => {
    const { user, conv } = await fixture();
    const { POST } =
      await import("../../src/routes/api/conversations/[id]/tool-calls/[toolCallId]/rerun/+server");

    const response = await POST({
      params: { id: conv.id, toolCallId: "X1" },
      locals: { userId: user.id },
      request: request({ confirmed: true }),
    } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      turnId: string;
      grantExpiresAt: number;
    };
    expect(body.turnId).toBe("turn-rerun");
    expect(body.grantExpiresAt).toBeGreaterThan(Date.now());
    expect(body.grantExpiresAt).toBeLessThanOrEqual(
      Date.now() + 2 * 60_000 + 1_000,
    );

    const settings = await import("../../src/lib/server/db/repos/settings");
    expect(
      settings.listGrantsForUser(user.id).find((g) => g.tool === "shell"),
    ).toMatchObject({
      conversationId: conv.id,
      permissionKind: null,
      argsHash: argsHash({ command: "echo approved" }),
      decision: "force-allow",
      expiresAt: expect.any(Number),
    });
    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: convCodec.parse(conv.id),
        prompt: expect.stringContaining("Invoke exactly the tool below"),
      }),
    );
    expect(
      conv &&
        (await import("../../src/lib/server/db/repos/messages"))
          .listByConversation(conv.id)
          .at(-1),
    ).toMatchObject({
      role: "user",
      content: expect.stringContaining("Manual tool rerun"),
    });
  });

  it("reruns generic failed calls with the same short-lived exact-args approval shape", async () => {
    const { user, conv, messages } = await fixture();
    const msg = messages.append(conv.id, { role: "assistant", content: "" });
    const args = { path: "src/missing.ts" };
    messages.insertToolCall(msg.id, {
      id: 2,
      tool: "view",
      argsJson: JSON.stringify(args),
      resultJson: JSON.stringify("File not found"),
      status: "error",
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      textOffset: 0,
      parentToolCallId: null,
    });
    const { POST } =
      await import("../../src/routes/api/conversations/[id]/tool-calls/[toolCallId]/rerun/+server");

    const response = await POST({
      params: { id: conv.id, toolCallId: "X2" },
      locals: { userId: user.id },
      request: request({ confirmed: true }),
    } as never);

    expect(response.status).toBe(200);
    const settings = await import("../../src/lib/server/db/repos/settings");
    expect(
      settings.listGrantsForUser(user.id).find((g) => g.tool === "view"),
    ).toMatchObject({
      conversationId: conv.id,
      permissionKind: null,
      argsHash: argsHash(args),
      decision: "force-allow",
      expiresAt: expect.any(Number),
    });
    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Invoke exactly the tool below"),
      }),
    );
    expect(
      messages
        .listByConversation(conv.id)
        .flatMap((m) => m.toolCalls ?? [])
        .find((t) => t.id === "X2"),
    ).toMatchObject({
      id: "X2",
      status: "error",
      resultJson: JSON.stringify("File not found"),
    });
  });

  it("rewinds messages and session memory to the rerun tool call message", async () => {
    const users = await import("../../src/lib/server/db/repos/users");
    const convs = await import("../../src/lib/server/db/repos/conversations");
    const messages = await import("../../src/lib/server/db/repos/messages");
    const memory = await import("../../src/lib/server/db/repos/memory");
    const { commitPatch } = await import("../../src/lib/server/memory/engine");
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "rerun-memory",
      workdir: "/tmp",
      model: null,
      memoryMode: "project",
    });
    const originalAssistant = messages.append(conv.id, {
      role: "assistant",
      content: "failed tool",
    });
    messages.insertToolCall(originalAssistant.id, {
      id: 3,
      tool: "bash",
      argsJson: JSON.stringify({ command: "echo retry" }),
      resultJson: JSON.stringify("Permission denied"),
      status: "denied",
      startedAt: Date.now() - 100,
      endedAt: Date.now(),
      textOffset: 0,
      parentToolCallId: null,
    });
    commitPatch({
      conversationId: conv.id,
      mode: "project",
      sourceMessageId: originalAssistant.id,
      patch: {
        entities: [
          { entityKey: "topic.keep", entityType: "topic", displayName: "Keep" },
        ],
        facts: [{ entityKey: "topic.keep", predicate: "state", value: "kept" }],
      },
    });
    messages.append(conv.id, { role: "user", content: "later user" });
    const laterAssistant = messages.append(conv.id, {
      role: "assistant",
      content: "later reply",
    });
    commitPatch({
      conversationId: conv.id,
      mode: "project",
      sourceMessageId: laterAssistant.id,
      patch: {
        entities: [
          { entityKey: "topic.drop", entityType: "topic", displayName: "Drop" },
        ],
        facts: [
          { entityKey: "topic.drop", predicate: "state", value: "stale" },
        ],
      },
    });
    const { POST } =
      await import("../../src/routes/api/conversations/[id]/tool-calls/[toolCallId]/rerun/+server");

    const response = await POST({
      params: { id: conv.id, toolCallId: "X3" },
      locals: { userId: user.id },
      request: request({ confirmed: true }),
    } as never);

    expect(response.status).toBe(200);
    expect(
      messages.listByConversation(conv.id).map((message) => message.content),
    ).toEqual(["failed tool", expect.stringContaining("Manual tool rerun")]);
    expect(
      memory.listEntities(conv.id).map((entity) => entity.entityKey),
    ).toEqual(["topic.keep"]);
    expect(memory.listFacts(conv.id).map((fact) => fact.value)).toEqual([
      "kept",
    ]);
    expect(startTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        memory: expect.objectContaining({
          mode: "project",
          userContent: expect.stringContaining("Manual tool rerun"),
        }),
      }),
    );
  });
});
