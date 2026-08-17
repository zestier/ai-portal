import { beforeEach, describe, expect, it } from "vitest";
import { setupLocalEnv } from "../../helpers/env";

async function freshImports() {
  const users = await import("../../../src/lib/server/db/repos/users");
  const convs = await import("../../../src/lib/server/db/repos/conversations");
  const messages = await import("../../../src/lib/server/db/repos/messages");
  return { users, convs, messages };
}

describe("conversation read tracking", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-conversation-activity-test-");
  });

  it("flags a conversation with an assistant message the user has not seen", async () => {
    const { users, convs, messages } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "c",
      workdir: "/tmp",
      model: null,
    });
    // `created_at` is millisecond-resolution and the predicate is strictly
    // greater-than, so back-date the read to guarantee the message is newer.
    convs.markRead(conv.id, user.id, Date.now() - 1);

    messages.append(conv.id, { role: "assistant", content: "hi" });

    expect(convs.hasUnread(conv.id, user.id)).toBe(true);
    expect(convs.unreadConversationIds(user.id)).toEqual(new Set([conv.id]));
  });

  it("clears the flag once marked read", async () => {
    const { users, convs, messages } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "c",
      workdir: "/tmp",
      model: null,
    });
    messages.append(conv.id, { role: "assistant", content: "hi" });
    expect(convs.hasUnread(conv.id, user.id)).toBe(true);

    // `created_at` is millisecond-resolution and `markRead` compares strictly
    // greater-than, so reading "now" would leave a same-millisecond message
    // unread. Real callers are always at least a tick later.
    convs.markRead(conv.id, user.id, Date.now() + 1);

    expect(convs.hasUnread(conv.id, user.id)).toBe(false);
    expect(convs.unreadConversationIds(user.id)).toEqual(new Set());
  });

  it("ignores the user\u2019s own messages", async () => {
    const { users, convs, messages } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "c",
      workdir: "/tmp",
      model: null,
    });
    convs.markRead(conv.id, user.id, Date.now() - 1);

    messages.append(conv.id, { role: "user", content: "do a thing" });

    expect(convs.hasUnread(conv.id, user.id)).toBe(false);
  });

  it("treats a never-read conversation with assistant output as unseen", async () => {
    const { users, convs, messages } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "c",
      workdir: "/tmp",
      model: null,
    });
    messages.append(conv.id, { role: "assistant", content: "hi" });

    expect(convs.hasUnread(conv.id, user.id)).toBe(true);
  });

  it("excludes archived conversations", async () => {
    const { users, convs, messages } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "c",
      workdir: "/tmp",
      model: null,
    });
    messages.append(conv.id, { role: "assistant", content: "hi" });
    convs.archive(conv.id, user.id);

    expect(convs.hasUnread(conv.id, user.id)).toBe(false);
    expect(convs.unreadConversationIds(user.id)).toEqual(new Set());
  });

  it("never regresses last_read_at when a stale mark arrives late", async () => {
    const { users, convs, messages } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "c",
      workdir: "/tmp",
      model: null,
    });
    const at = Date.now();
    messages.append(conv.id, { role: "assistant", content: "hi" });
    convs.markRead(conv.id, user.id, at + 1000);

    // An older concurrent writer must not resurrect the unseen state.
    convs.markRead(conv.id, user.id, at - 1000);

    expect(convs.hasUnread(conv.id, user.id)).toBe(false);
  });

  it("does not leak another user\u2019s unseen conversations", async () => {
    const { users, convs, messages } = await freshImports();
    const user = users.ensureLocalUser();
    const other = users.ensureLocalUser("other");
    const conv = convs.create(other.id, {
      title: "c",
      workdir: "/tmp",
      model: null,
    });
    messages.append(conv.id, { role: "assistant", content: "hi" });

    expect(convs.unreadConversationIds(user.id)).toEqual(new Set());
    expect(convs.hasUnread(conv.id, user.id)).toBe(false);
    expect(convs.markRead(conv.id, user.id)).toBe(false);
  });
});
