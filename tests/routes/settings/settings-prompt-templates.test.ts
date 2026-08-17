import { describe, it, expect, beforeEach } from "vitest";
import { setupLocalEnv } from "../../helpers/env";

// End-to-end for the Settings → Prompts update/archive forms. The prefixed-id
// migration (T12) changed prompt-template ids from raw ints to `PT<number>`
// handles, but these two Settings actions still parsed the hidden `id` field as
// a raw int — so saving an existing template failed with
// "Expected number, received nan" and archiving failed with
// "Invalid prompt template id". These tests drive the real form actions with a
// real handle id and assert the persisted result, proving the two actions were
// migrated too (not just the REST API and portal tools).

async function loadActions() {
  const mod = await import("../../../src/routes/settings/+page.server");
  return mod.actions;
}

function formRequest(fields: Record<string, string | string[]>): Request {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const item of v) body.append(k, item);
    else body.append(k, v);
  }
  return new Request("http://localhost/settings", { method: "POST", body });
}

// The actions only read `request` and `locals`, so a minimal shim is enough.
async function runAction(
  name: "updatePromptTemplate" | "archivePromptTemplate",
  userId: number,
  fields: Record<string, string | string[]>,
) {
  const actions = await loadActions();
  return actions[name]({
    request: formRequest(fields),
    locals: { userId },
  } as unknown as Parameters<(typeof actions)[typeof name]>[0]);
}

describe("settings prompt-template forms — prefixed handle ids", () => {
  let userId: number;

  beforeEach(async () => {
    await setupLocalEnv("portal-settings-prompt-templates-");
    const users = await import("../../../src/lib/server/db/repos/users");
    userId = users.ensureLocalUser().id;
  });

  it("updates an existing chat template through the real action using its handle id", async () => {
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const template = promptTemplates.create(userId, {
      type: "chat",
      title: "Original title",
      prompt: "Original prompt.",
      orderIndex: 3,
    });
    // The form posts the prefixed handle, never the raw int.
    expect(template.id).toMatch(/^PT[1-9][0-9]*$/);

    const result = (await runAction("updatePromptTemplate", userId, {
      id: template.id,
      type: "chat",
      title: "Renamed",
      prompt: "Updated prompt with no placeholders.",
      orderIndex: "7",
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const updated = promptTemplates.get(template.id, userId);
    expect(updated?.title).toBe("Renamed");
    expect(updated?.prompt).toBe("Updated prompt with no placeholders.");
    expect(updated?.orderIndex).toBe(7);
    expect(updated?.status).toBe("open");
  });

  it("archives an existing ticket action through the real action using its handle id", async () => {
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const action = promptTemplates.create(userId, {
      type: "ticket-action",
      title: "Do the thing",
      prompt: "Do the thing.",
      launchBehavior: "send",
    });

    const result = (await runAction("archivePromptTemplate", userId, {
      id: action.id,
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const archived = promptTemplates.get(action.id, userId);
    expect(archived?.status).toBe("archived");
    expect(archived?.archivedAt).toBeTypeOf("number");
  });

  it("rejects a raw-int id on update with a clear 400 and leaves the template untouched", async () => {
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const template = promptTemplates.create(userId, {
      title: "Target",
      prompt: "Prompt.",
    });

    const result = (await runAction("updatePromptTemplate", userId, {
      id: "7", // pre-migration raw-int format — must be rejected, not coerced
      type: "chat",
      title: "Hijack",
      prompt: "Prompt.",
    })) as { status?: number; data?: { error?: string; formId?: string } };
    expect(result.status).toBe(400);
    expect(result.data?.error).toBe("Invalid prompt template id");
    expect(result.data?.formId).toBe("updatePromptTemplate");

    expect(promptTemplates.get(template.id, userId)?.title).toBe("Target");
  });

  it("rejects a malformed id on archive with a clear 400", async () => {
    const result = (await runAction("archivePromptTemplate", userId, {
      id: "not-a-handle",
    })) as { status?: number; data?: { error?: string } };
    expect(result.status).toBe(400);
    expect(result.data?.error).toBe("Invalid prompt template id");
  });

  // T30/R2: ticket-action templates now support a tool-group preset, so the
  // real update action must persist it (previously force-emptied by design).
  it("persists an enabledToolGroups preset (inverts to disabledToolGroups) on a ticket action", async () => {
    const promptTemplates =
      await import("../../../src/lib/server/db/repos/prompt-templates");
    const { PORTAL_TOOL_GROUP_IDS } =
      await import("../../../src/lib/tools/groups");
    const action = promptTemplates.create(userId, {
      type: "ticket-action",
      title: "Do the thing",
      prompt: "Do the thing.",
      launchBehavior: "send",
    });

    const result = (await runAction("updatePromptTemplate", userId, {
      id: action.id,
      type: "ticket-action",
      title: "Do the thing",
      prompt: "Do the thing.",
      launchBehavior: "send",
      enabledToolGroups: PORTAL_TOOL_GROUP_IDS.filter((id) => id !== "git"),
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    expect(promptTemplates.get(action.id, userId)?.disabledToolGroups).toEqual([
      "git",
    ]);
  });
});
