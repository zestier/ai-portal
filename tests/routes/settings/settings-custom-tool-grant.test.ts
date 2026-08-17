import { describe, it, expect, beforeEach } from "vitest";
import { setupLocalEnv } from "../../helpers/env";

// End-to-end for the settings grant form's custom-tool path: a form submission
// goes through the real `createGrant` / `updateGrant` actions and the resulting
// row is then resolved by the real matcher. This is what proves a user can opt
// into a tool the seed set deliberately withholds (`worktree_create`) without
// waiting for a live prompt.

async function loadActions() {
  const mod = await import("../../../src/routes/settings/+page.server");
  return mod.actions;
}

function formRequest(fields: Record<string, string>): Request {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request("http://localhost/settings", { method: "POST", body });
}

// The action only reads `request` and `locals`, so a minimal shim is enough.
async function runAction(
  name: "createGrant" | "updateGrant",
  userId: number,
  fields: Record<string, string>,
) {
  const actions = await loadActions();
  return actions[name]({
    request: formRequest(fields),
    locals: { userId },
  } as unknown as Parameters<(typeof actions)[typeof name]>[0]);
}

const CUSTOM_TOOL_FIELDS = {
  tool: "custom-tool",
  toolName: "worktree_create",
  decision: "allow",
  scopeJson: '{"kind":"any"}',
  expiresAt: "",
  denyReason: "",
};

describe("settings createGrant — custom-tool grants", () => {
  let userId: number;

  beforeEach(async () => {
    await setupLocalEnv("portal-custom-tool-grant-");
    const users = await import("../../../src/lib/server/db/repos/users");
    userId = users.ensureLocalUser().id;
  });

  it("persists a grant keyed by tool name that the matcher then honors", async () => {
    const settings = await import("../../../src/lib/server/db/repos/settings");
    const result = (await runAction(
      "createGrant",
      userId,
      CUSTOM_TOOL_FIELDS,
    )) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);

    const row = settings
      .listGrantsForUser(userId)
      .find((g) => g.tool === "worktree_create" && g.source === "settings");
    expect(row).toBeDefined();
    expect(row?.permissionKind).toBe("custom-tool");
    expect(row?.scope).toEqual({ kind: "any" });
    expect(row?.conversationId).toBeNull();

    // The payoff: the tool no longer prompts.
    expect(
      settings.matchGrant(userId, 1, "worktree_create", "custom-tool", null),
    ).toBe("allow");
    // ...and nothing else was widened.
    expect(
      settings.matchGrant(userId, 1, "worktree_remove", "custom-tool", null),
    ).toBe("none");
  });

  it("supports a deny grant with agent-facing feedback", async () => {
    const settings = await import("../../../src/lib/server/db/repos/settings");
    await runAction("createGrant", userId, {
      ...CUSTOM_TOOL_FIELDS,
      decision: "deny",
      denyReason: "worktrees are off limits on this machine",
    });

    const detailed = settings.matchGrantDetailed(
      userId,
      1,
      "worktree_create",
      "custom-tool",
      null,
    );
    expect(detailed.outcome).toBe("deny");
    expect(detailed.feedback).toBe("worktrees are off limits on this machine");
  });

  it("dedupes an identical custom-tool grant instead of stacking rows", async () => {
    const settings = await import("../../../src/lib/server/db/repos/settings");
    await runAction("createGrant", userId, CUSTOM_TOOL_FIELDS);
    const second = (await runAction(
      "createGrant",
      userId,
      CUSTOM_TOOL_FIELDS,
    )) as {
      duplicate?: boolean;
    };
    expect(second.duplicate).toBe(true);
    expect(
      settings
        .listGrantsForUser(userId)
        .filter((g) => g.tool === "worktree_create"),
    ).toHaveLength(1);
  });

  it("rejects a tool name that would become a match-everything wildcard", async () => {
    const settings = await import("../../../src/lib/server/db/repos/settings");
    const result = (await runAction("createGrant", userId, {
      ...CUSTOM_TOOL_FIELDS,
      toolName: "*",
    })) as { status?: number; data?: { error?: string } };
    expect(result.status).toBe(400);
    expect(result.data?.error).toMatch(/bare tool name/);
    expect(settings.listGrantsForUser(userId).some((g) => g.tool === "*")).toBe(
      false,
    );
  });

  it("rejects a missing tool name", async () => {
    const result = (await runAction("createGrant", userId, {
      ...CUSTOM_TOOL_FIELDS,
      toolName: "",
    })) as { status?: number; data?: { error?: string } };
    expect(result.status).toBe(400);
    expect(result.data?.error).toMatch(/tool name is required/);
  });

  it("still rejects the any scope for a scoped permission kind", async () => {
    const result = (await runAction("createGrant", userId, {
      tool: "shell",
      decision: "allow",
      scopeJson: '{"kind":"any"}',
      expiresAt: "",
      denyReason: "",
    })) as { status?: number; data?: { error?: string } };
    expect(result.status).toBe(400);
    expect(result.data?.error).toMatch(/only be authored for tool=custom-tool/);
  });

  it("can retarget an existing custom-tool grant to another tool", async () => {
    const settings = await import("../../../src/lib/server/db/repos/settings");
    await runAction("createGrant", userId, CUSTOM_TOOL_FIELDS);
    const id = settings
      .listGrantsForUser(userId)
      .find((g) => g.tool === "worktree_create")?.id;
    expect(id).toBeDefined();

    const result = (await runAction("updateGrant", userId, {
      ...CUSTOM_TOOL_FIELDS,
      id: String(id),
      toolName: "git_worktree_merge",
    })) as { ok: boolean };
    expect(result.ok).toBe(true);

    const tools = settings.listGrantsForUser(userId).map((g) => g.tool);
    expect(tools).toContain("git_worktree_merge");
    expect(tools).not.toContain("worktree_create");
  });
});
