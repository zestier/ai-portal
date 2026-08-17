import { describe, it, expect } from "vitest";
import {
  addInteractive,
  removeInteractive,
} from "../../src/lib/client/interactive-queue";
import type { InteractiveRequestView } from "../../src/lib/types";

function req(
  id: string,
  overrides: Partial<InteractiveRequestView> = {},
): InteractiveRequestView {
  return {
    requestId: id,
    kind: "permission",
    tool: "shell",
    permissionKind: "shell",
    summary: `cmd-${id}`,
    args: null,
    ...overrides,
  } as InteractiveRequestView;
}

describe("interactive-queue", () => {
  it("queues concurrent interactive requests instead of clobbering them", () => {
    // Regression: previously the UI held a single `pendingPermission`
    // slot, so a second event hid the first while it stayed pending on
    // the server, deadlocking the earlier tool call.
    let q: InteractiveRequestView[] = [];
    q = addInteractive(q, req("a"));
    q = addInteractive(q, req("b"));
    q = addInteractive(q, req("c"));
    expect(q.map((p) => p.requestId)).toEqual(["a", "b", "c"]);
  });

  it("dedupes by requestId so replayed event logs do not double-insert", () => {
    let q: InteractiveRequestView[] = [];
    q = addInteractive(q, req("a", { summary: "first" }));
    q = addInteractive(q, req("a", { summary: "replayed" }));
    expect(q).toHaveLength(1);
    // First insert wins; we don't want a replay to mutate the original
    // view the user is already looking at.
    expect((q[0] as { summary?: string }).summary).toBe("first");
  });

  it("removes only the resolved request, leaving siblings intact", () => {
    let q: InteractiveRequestView[] = [req("a"), req("b"), req("c")];
    q = removeInteractive(q, "b");
    expect(q.map((p) => p.requestId)).toEqual(["a", "c"]);
  });

  it("removeInteractive is a no-op for unknown ids", () => {
    const q: InteractiveRequestView[] = [req("a"), req("b")];
    const next = removeInteractive(q, "missing");
    expect(next.map((p) => p.requestId)).toEqual(["a", "b"]);
  });

  it("returns new array references so reactive frameworks detect updates", () => {
    const q: InteractiveRequestView[] = [req("a")];
    const afterAdd = addInteractive(q, req("b"));
    expect(afterAdd).not.toBe(q);
    const afterRemove = removeInteractive(afterAdd, "a");
    expect(afterRemove).not.toBe(afterAdd);
  });
});
