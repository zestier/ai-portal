import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupLocalEnv } from "../helpers/env";

const startTurnMock = vi.fn();

vi.mock("../../src/lib/server/runtime/turn-runner", () => ({
  startTurn: (...args: unknown[]) => startTurnMock(...args),
}));

async function freshImports() {
  const users = await import("../../src/lib/server/db/repos/users");
  const convs = await import("../../src/lib/server/db/repos/conversations");
  const messages = await import("../../src/lib/server/db/repos/messages");
  const turnStart = await import("../../src/lib/server/turn-start");
  return { users, convs, messages, turnStart };
}

describe("turn-start bridge options", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-turn-start-test-");
    startTurnMock.mockReset();
    startTurnMock.mockResolvedValue({
      id: "turn-test",
      conversationId: "conv-test",
      startedAt: Date.now(),
      endedAt: null,
      status: "running",
      subscribe: async function* () {},
      abort: async () => {},
    });
  });

  it("sends the raw user prompt and no rewind for a normal continuation", async () => {
    const { users, convs, messages, turnStart } = await freshImports();
    const u = users.ensureLocalUser();
    const conv = convs.create(u.id, {
      title: "ctx",
      workdir: "/tmp",
      model: null,
    });
    const msg = messages.append(conv.id, {
      role: "user",
      content: "plain question",
    });

    await turnStart.startTurnFromUserMessage(conv, msg);

    const { prompt, bridge } = startTurnMock.mock.calls[0][0];
    expect(prompt).toBe("plain question");
    // A fresh conversation gets a persistent session file (null = create one).
    expect(bridge.sessionFilePath).toBeNull();
    expect(bridge.rewindToUserMessageOrdinal).toBeUndefined();
  });

  it("rewinds to the edited user message ordinal on a rerun", async () => {
    const { users, convs, messages, turnStart } = await freshImports();
    const u = users.ensureLocalUser();
    const conv = convs.create(u.id, {
      title: "ctx",
      workdir: "/tmp",
      model: null,
    });
    messages.append(conv.id, { role: "user", content: "first question" });
    messages.append(conv.id, { role: "assistant", content: "first answer" });
    const edited = messages.append(conv.id, {
      role: "user",
      content: "edited follow-up",
    });

    await turnStart.startTurnFromUserMessage(conv, edited, { rerun: true });

    const { prompt, bridge } = startTurnMock.mock.calls[0][0];
    // Rerun prompts the raw edited text and rewinds the session tree to the
    // second user message (0-based ordinal 1), not injecting the transcript.
    expect(prompt).toBe("edited follow-up");
    expect(prompt).not.toContain("<prior_conversation>");
    expect(bridge.rewindToUserMessageOrdinal).toBe(1);
  });

  it("resumes the persisted session file when one exists", async () => {
    const { users, convs, messages, turnStart } = await freshImports();
    const u = users.ensureLocalUser();
    const conv = convs.create(u.id, {
      title: "ctx",
      workdir: "/tmp",
      model: null,
    });
    convs.setSessionFile(conv.id, u.id, "/tmp/data/sessions/abc.jsonl");
    const msg = messages.append(conv.id, {
      role: "user",
      content: "continue here",
    });

    const resumed = convs.get(conv.id, u.id)!;
    await turnStart.startTurnFromUserMessage(resumed, msg);

    const { bridge } = startTurnMock.mock.calls[0][0];
    expect(bridge.sessionFilePath).toBe("/tmp/data/sessions/abc.jsonl");
  });
});
