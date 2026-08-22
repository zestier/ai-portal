import { describe, expect, it, beforeEach } from "vitest";
import { getDb } from "../../src/lib/server/db";
import { extensionId } from "../../src/lib/ids";
import { setupLocalEnv } from "../helpers/env";

describe("portal extensions repo", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-ext-repo-");
  });

  it("migration creates the table", () => {
    const table = getDb()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portal_extensions'`,
      )
      .get();
    expect(table).toBeTruthy();
  });

  it("CRUD, user scoping, status/enabled filters, and sort ordering", async () => {
    const users = await import("../../src/lib/server/db/repos/users");
    const exts = await import("../../src/lib/server/db/repos/extensions");
    const user = users.ensureLocalUser();
    const other = users.ensureLocalUser("ext-rival");

    // `ensureLocalUser` auto-seeds the "Caveman response style" builtin row per
    // user; drop those so this test only reasons about the rows it creates.
    for (const u of [user, other]) {
      for (const r of exts.list(u.id)) exts.remove(u.id, r.id);
    }

    const a = exts.create(user.id, {
      name: "A",
      kind: "inline",
      value: "export default () => 1",
      enabled: true,
      sortOrder: 10,
    });
    const b = exts.create(user.id, {
      name: "B",
      kind: "package",
      value: "npm:foo@1.0.0",
      enabled: true,
      sortOrder: 0,
    });
    const c = exts.create(user.id, {
      name: "C",
      kind: "file",
      value: "ext.ts",
      enabled: false,
      sortOrder: 5,
    });

    // Opaque handles + normalization.
    expect(a.id).toBe(extensionId.encode(extensionId.parse(a.id)));
    expect(a.id).toMatch(/^EX\d+$/);
    expect(a.kind).toBe("inline");
    expect(a.enabled).toBe(true);
    expect(b.value).toBe("npm:foo@1.0.0");
    expect(c.enabled).toBe(false);

    // list(): open DESC, sort_order ASC, id ASC — b(0), c(5), a(10).
    expect(exts.list(user.id).map((e) => e.id)).toEqual([b.id, c.id, a.id]);
    expect(exts.list(user.id, { status: "all" }).length).toBe(3);
    expect(exts.list(other.id)).toEqual([]);

    // get is scoped by user.
    expect(exts.get(user.id, a.id)?.name).toBe("A");
    expect(exts.get(other.id, a.id)).toBeNull();

    // update + updated_at bump.
    const updated = exts.update(user.id, a.id, {
      value: "export default () => 2",
      sortOrder: 1,
    });
    expect(updated?.value).toBe("export default () => 2");
    expect(updated?.sortOrder).toBe(1);
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);

    // update is scoped: a rival user cannot mutate.
    expect(exts.update(other.id, a.id, { value: "hacked" })).toBeNull();

    // setEnabled (scoped).
    expect(exts.setEnabled(user.id, a.id, false)?.enabled).toBe(false);
    expect(exts.setEnabled(other.id, a.id, true)).toBeNull();

    // Hard delete (scoped).
    expect(exts.remove(user.id, b.id)).toBe(true);
    expect(exts.get(user.id, b.id)).toBeNull();
    expect(exts.remove(user.id, b.id)).toBe(false);
    expect(exts.remove(other.id, a.id)).toBe(false);
    expect(exts.get(user.id, a.id)).not.toBeNull();
  });

  it("invalid ids throw a precise parse error", async () => {
    const exts = await import("../../src/lib/server/db/repos/extensions");
    expect(() => exts.get(1, "T10")).toThrow("not a extension id: T10");
  });

  it("ensureCavemanExtensionSeeded inserts exactly one enabled inline row and is idempotent", async () => {
    const users = await import("../../src/lib/server/db/repos/users");
    const exts = await import("../../src/lib/server/db/repos/extensions");
    const { CAVEMAN_STYLE_EXTENSION_SOURCE } =
      await import("../../src/lib/server/extensions/builtin");

    // Seeded as part of `ensureLocalUser` (fresh install path).
    const user = users.ensureLocalUser();
    expect(exts.list(user.id)).toHaveLength(1);
    const row = exts.list(user.id)[0];
    expect(row.name).toBe("Caveman response style");
    expect(row.kind).toBe("inline");
    expect(row.enabled).toBe(true);
    expect(row.value).toBe(CAVEMAN_STYLE_EXTENSION_SOURCE);

    // Idempotent — a second seed leaves exactly one row.
    exts.ensureCavemanExtensionSeeded(user.id);
    exts.ensureCavemanExtensionSeeded(user.id);
    expect(exts.list(user.id)).toHaveLength(1);
  });

  it("ensureCavemanExtensionSeeded leaves an existing (even disabled) row untouched", async () => {
    const users = await import("../../src/lib/server/db/repos/users");
    const exts = await import("../../src/lib/server/db/repos/extensions");
    const user = users.ensureLocalUser();

    // User opted out via the toggle → row exists but disabled.
    const id = exts.list(user.id)[0].id;
    exts.setEnabled(user.id, id, false);

    // Seed must NOT flip `enabled` back on, nor duplicate the row.
    exts.ensureCavemanExtensionSeeded(user.id);
    const rows = exts.list(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(false);
  });

  it("ensureCavemanExtensionSeeded seeds each user independently", async () => {
    const users = await import("../../src/lib/server/db/repos/users");
    const exts = await import("../../src/lib/server/db/repos/extensions");
    const a = users.ensureLocalUser();
    const b = users.ensureLocalUser("ext-seed-rival");
    expect(exts.list(a.id)).toHaveLength(1);
    expect(exts.list(b.id)).toHaveLength(1);
    expect(exts.list(a.id)[0].id).not.toBe(exts.list(b.id)[0].id);
  });

  it("ensureLocalUser seeds an EXISTING user who predates the builtin (upgrade path)", async () => {
    const users = await import("../../src/lib/server/db/repos/users");
    const exts = await import("../../src/lib/server/db/repos/extensions");
    const user = users.ensureLocalUser();

    // Simulate a pre-existing install: the user's DB row is long gone before
    // this feature shipped, but the user already exists. Remove the seeded
    // caveman row to reproduce the "old DB, upgraded binary" state.
    const seeded = exts.list(user.id);
    expect(seeded).toHaveLength(1);
    expect(exts.remove(user.id, seeded[0].id)).toBe(true);
    expect(exts.list(user.id)).toHaveLength(0);

    // The next ensureLocalUser for the SAME (already-existing) user must
    // re-seed the builtin — it cannot rely on the user-creation branch.
    const again = users.ensureLocalUser("local");
    expect(again.id).toBe(user.id);
    const rows = exts.list(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Caveman response style");
    expect(rows[0].enabled).toBe(true);
  });
});
