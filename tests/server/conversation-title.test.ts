import { beforeEach, describe, expect, it } from "vitest";
import { setupLocalEnv } from "../helpers/env";

async function freshImports() {
  const users = await import("../../src/lib/server/db/repos/users");
  const convs = await import("../../src/lib/server/db/repos/conversations");
  const messages = await import("../../src/lib/server/db/repos/messages");
  const title = await import("../../src/lib/server/conversation-title");
  return { users, convs, messages, title };
}

describe("tryRenameFromFirstUserMessage", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-conversation-title-test-");
  });

  it("renames a default-titled conversation from the first non-empty user message", async () => {
    const { users, convs, messages, title } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "New chat",
      workdir: "/tmp",
      model: null,
    });
    const userMsg = messages.append(conv.id, {
      role: "user",
      content: "Please fix the sidebar loading state when chats refresh.",
    });

    const newTitle = title.tryRenameFromFirstUserMessage(conv, userMsg);

    expect(newTitle).toBe("Please fix the sidebar loading state when chats");
    expect(convs.get(conv.id, user.id)?.title).toBe(newTitle);
  });

  it("does not overwrite a custom title", async () => {
    const { users, convs, messages, title } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "Custom title",
      workdir: "/tmp",
      model: null,
    });
    const userMsg = messages.append(conv.id, {
      role: "user",
      content: "Rename from this",
    });

    expect(title.tryRenameFromFirstUserMessage(conv, userMsg)).toBeNull();
    expect(convs.get(conv.id, user.id)?.title).toBe("Custom title");
  });

  it("does not overwrite a title that changed after the first message was accepted", async () => {
    const { users, convs, messages, title } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "New chat",
      workdir: "/tmp",
      model: null,
    });
    const userMsg = messages.append(conv.id, {
      role: "user",
      content: "Rename from this",
    });
    convs.rename(conv.id, user.id, "Manual title");

    expect(title.tryRenameFromFirstUserMessage(conv, userMsg)).toBeNull();
    expect(convs.get(conv.id, user.id)?.title).toBe("Manual title");
  });

  it("does not rename after a prior non-empty user message exists", async () => {
    const { users, convs, messages, title } = await freshImports();
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "New chat",
      workdir: "/tmp",
      model: null,
    });
    messages.append(conv.id, { role: "user", content: "First message" });
    const second = messages.append(conv.id, {
      role: "user",
      content: "Second message",
    });

    expect(title.tryRenameFromFirstUserMessage(conv, second)).toBeNull();
    expect(convs.get(conv.id, user.id)?.title).toBe("New chat");
  });
});
