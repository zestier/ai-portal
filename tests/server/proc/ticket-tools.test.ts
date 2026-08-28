import { beforeEach, describe, expect, it } from "vitest";
import { conversationId as conversationIdCodec } from "$lib/ids";
import { setupLocalEnv } from "../../helpers/env";
import * as users from "$lib/server/db/repos/users";
import * as conversations from "$lib/server/db/repos/conversations";
import * as tickets from "$lib/server/db/repos/tickets";
import { buildProcTicketTools } from "$lib/server/proc/ticket-tools";
import { programToolManifest } from "$lib/server/ptc/contracts";

describe("proc ticket tools", () => {
  beforeEach(async () => {
    await setupLocalEnv("proc-ticket-tools-");
  });

  it("creates, gets, lists, and patches complete ticket objects", async () => {
    const user = users.ensureLocalUser();
    const workspaceKey = "/workspace/current";
    const conversation = conversations.create(user.id, {
      title: "Proc tickets",
      workdir: workspaceKey,
      model: null,
    });
    const blockerA = tickets.create(user.id, {
      workspaceKey,
      title: "Blocker A",
    });
    const blockerB = tickets.create(user.id, {
      workspaceKey,
      title: "Blocker B",
    });
    const tools = new Map(
      buildProcTicketTools({
        userId: user.id,
        workspaceKey,
        conversationId: conversationIdCodec.parse(conversation.id),
      }).map((tool) => [tool.name, tool]),
    );

    const created = await tools.get("ticket_add")!.handler({
      title: "Implement compact tickets",
      body: "Keep the API small.",
      blockedBy: [blockerA.id],
    });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(created.error.message);
    const id = created.result as string;
    expect(id).toMatch(/^T\d+$/);

    await expect(
      tools.get("ticket_get")!.handler({ id }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        id,
        title: "Implement compact tickets",
        body: "Keep the API small.",
        plan: "",
        status: "open",
        priority: "P2",
        blockedBy: [blockerA.id],
        blocks: [],
      },
    });

    await expect(
      tools.get("ticket_update")!.handler({
        id,
        patch: {
          plan: "1. Implement\n2. Verify",
          blockedBy: [blockerB.id],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        id,
        body: "Keep the API small.",
        plan: "1. Implement\n2. Verify",
        blockedBy: [blockerB.id],
      },
    });
    expect(tickets.listDependencies(id)).toEqual([blockerB.id]);

    await expect(
      tools.get("ticket_list")!.handler({ status: "open" }),
    ).resolves.toMatchObject({
      ok: true,
      result: expect.arrayContaining([
        expect.objectContaining({ id, plan: "1. Implement\n2. Verify" }),
      ]),
    });
  });

  it("publishes fixed schemas without field selectors", () => {
    const tools = buildProcTicketTools({
      userId: 1,
      workspaceKey: "/workspace/current",
      conversationId: 1,
    });
    const get = tools.find((tool) => tool.name === "ticket_get")!;
    const list = tools.find((tool) => tool.name === "ticket_list")!;
    expect(get.parameters).not.toHaveProperty("properties.fields");
    expect(list.parameters).not.toHaveProperty("properties.fields");
    expect(get.program?.resultSchema).toMatchObject({
      required: expect.arrayContaining(["body", "plan", "blockedBy", "blocks"]),
    });
    const manifest = programToolManifest(
      new Map(tools.map((tool) => [tool.name, tool])),
    );
    expect(manifest.map((entry) => entry.name)).toEqual([
      "ticket_add",
      "ticket_get",
      "ticket_list",
      "ticket_update",
    ]);
    expect(JSON.stringify(manifest)).not.toContain('"fields"');
  });
});
