import { describe, expect, it, beforeAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { conversationId as conversationIdCodec } from "../../../src/lib/ids";
import type {
  InteractivePermissionView,
  InteractiveRequestView,
  InteractiveResponse,
  PortalEvent,
} from "../../../src/lib/types";
import type {
  PortalTool,
  ToolResult,
} from "../../../src/lib/server/tools/types";
import type { ProviderOpenOptions } from "../../../src/lib/server/pi/session-contract";
import { setupLocalEnv } from "../../helpers/env";
import { makeTmpDir } from "../../helpers/tmp";

// E2E for the pi permission gate: the stub model emits a `PI_TEST_TOOLCALL`
// directive, the pi session executes the named portal custom tool, and the gate
// (session.ts bridge -> permission-gate.ts) settles allow/block against grants,
// policy, approval mode, and interactive prompts. Every tool call also asserts
// the portal timeline pairing (tool.call then tool.result), which is the shape
// the turn-runner persists.
//
// The stub is stateless: once the model has emitted a tool call, the follow-up
// request replies with text, so each turn terminates after the tool runs.
//
// Grant isolation: grants are seeded conversation-scoped (each test creates its
// own conversation row), so one test's allow/deny grant can't leak into the
// next. `bash` with an unseeded command (`mktemp -d`) is deliberately NOT
// covered by any seed grant, so it is the workhorse for gate paths that must
// start from "nothing matches" (prompt / deny-all / auto-deny); `ticket_list`
// IS seeded and only used where a success envelope is asserted.

let USER = 1;
let convSeq = 0;

async function openSession(
  wd: string,
  conversationId: string | number,
  opts: Partial<ProviderOpenOptions> = {},
) {
  const { openPiSession } = await import("../../../src/lib/server/pi");
  const bridge: ProviderOpenOptions = {
    conversationId:
      typeof conversationId === "number"
        ? conversationId
        : conversationIdCodec.parse(conversationId),
    userId: USER,
    workingDirectory: wd,
    model: "stub",
    policy: "prompt",
    ...opts,
  };
  return openPiSession(bridge);
}

// A fresh conversation row whose workdir is the test's tmpdir: grants can be
// seeded against it (FK), and the gate's workspaceRootsFor resolves to [wd].
async function createConversation(wd: string): Promise<string> {
  const { create } =
    await import("../../../src/lib/server/db/repos/conversations");
  const conv = create(USER, {
    title: `pi-gate-${convSeq++}`,
    workdir: wd,
    model: null,
  });
  return conv.id;
}

interface ToolCallOutcome {
  call: PortalEvent & { type: "tool.call" };
  result: PortalEvent & { type: "tool.result" };
  prompts: InteractivePermissionView[];
}

// Run a single tool-call turn, optionally resolving any interactive prompts as
// they surface (the send() stream stalls on the gate's await otherwise).
async function runToolCall(
  session: Awaited<ReturnType<typeof openSession>>,
  toolName: string,
  args: unknown,
  onPrompt?: (view: InteractiveRequestView) => InteractiveResponse | undefined,
): Promise<ToolCallOutcome> {
  const { resolve } =
    await import("../../../src/lib/server/runtime/interactive-requests");
  const ac = new AbortController();
  const events: PortalEvent[] = [];
  const prompts: InteractivePermissionView[] = [];
  for await (const ev of session.send(
    `PI_TEST_TOOLCALL ${toolName} ${JSON.stringify(args)}`,
    ac.signal,
  )) {
    if (ev.type === "interactive.request" && ev.request.kind === "permission") {
      prompts.push(ev.request);
      const response = onPrompt?.(ev.request);
      if (response) resolve(ev.request.requestId, USER, response);
    }
    events.push(ev);
  }
  await session.dispose();
  const call = events.find(
    (e): e is PortalEvent & { type: "tool.call" } =>
      e.type === "tool.call" && e.tool === toolName,
  );
  if (!call)
    throw new Error(
      `no tool.call for ${toolName} — events: ${events.map((e) => e.type).join(",")}`,
    );
  const result = events.find(
    (e): e is PortalEvent & { type: "tool.result" } =>
      e.type === "tool.result" && e.toolCallId === call.toolCallId,
  );
  if (!result) throw new Error(`no tool.result for ${toolName}`);
  return { call, result, prompts };
}

// The gate lets a call through by running the handler (its `output` carries the
// serialized portal envelope); a blocked call has no envelope output. Used to
// assert allow/block without depending on whether the handler itself succeeds.
function ran(result: ToolCallOutcome["result"]): boolean {
  return typeof result.output === "string";
}

const T = 30_000;

describe("pi tool calls + permission gate", () => {
  beforeAll(async () => {
    process.env.PI_STUB = "1";
    await setupLocalEnv("pi-tool-gate-");
    const { resetConfigForTests } =
      await import("../../../src/lib/server/config");
    resetConfigForTests();
    const { ensureLocalUser } =
      await import("../../../src/lib/server/db/repos/users");
    USER = ensureLocalUser().id;
  });

  it(
    "executes a portal custom tool through the pi session and streams the envelope",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const session = await openSession(wd, convId);
      const { call, result } = await runToolCall(session, "ticket_list", {});
      expect(call.args).toEqual({});
      expect(result.ok).toBe(true);
      expect(result.summary).toBe("No open tickets.");
      // The serialized portal envelope rides the `output` channel.
      expect(typeof result.output).toBe("string");
      expect(JSON.parse(result.output as string)).toMatchObject({ ok: true });
    },
    T,
  );

  it(
    "runs without prompting when an allow grant matches",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const { addGrant } =
        await import("../../../src/lib/server/db/repos/settings");
      addGrant({
        userId: USER,
        conversationId: convId,
        tool: "bash",
        permissionKind: "shell",
        scope: {
          kind: "shell",
          rule: {
            command: [{ token: "mktemp" }],
            positionals: { kind: "any" },
          },
        },
        decision: "allow",
      });
      const session = await openSession(wd, convId);
      const { result, prompts } = await runToolCall(session, "bash", {
        command: "mktemp -d",
      });
      expect(ran(result)).toBe(true);
      expect(prompts.length).toBe(0);
    },
    T,
  );

  it(
    "blocks with the deny feedback when a deny grant matches",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const { addGrant } =
        await import("../../../src/lib/server/db/repos/settings");
      addGrant({
        userId: USER,
        conversationId: convId,
        tool: "bash",
        permissionKind: "shell",
        scope: {
          kind: "shell",
          rule: {
            command: [{ token: "mktemp" }],
            positionals: { kind: "any" },
          },
        },
        decision: "deny",
        denyReason: "tests deny mktemp",
      });
      const session = await openSession(wd, convId);
      const { result, prompts } = await runToolCall(session, "bash", {
        command: "mktemp -d",
      });
      expect(ran(result)).toBe(false);
      expect(result.summary).toContain("tests deny mktemp");
      expect(prompts.length).toBe(0);
    },
    T,
  );

  it(
    "deny-all policy blocks every tool without prompting",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const session = await openSession(wd, convId, { policy: "deny-all" });
      const { result, prompts } = await runToolCall(session, "bash", {
        command: "mktemp -d",
      });
      expect(ran(result)).toBe(false);
      expect(prompts.length).toBe(0);
    },
    T,
  );

  it(
    "allow-all policy runs every tool without prompting",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const session = await openSession(wd, convId, { policy: "allow-all" });
      const { result, prompts } = await runToolCall(session, "bash", {
        command: "mktemp -d",
      });
      expect(ran(result)).toBe(true);
      expect(prompts.length).toBe(0);
    },
    T,
  );

  it(
    "fs-kind requests inside the workspace auto-approve under prompt policy",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      writeFileSync(join(wd, "notes.txt"), "hello\n");
      const convId = await createConversation(wd);
      const session = await openSession(wd, convId);
      const { result, prompts } = await runToolCall(session, "read", {
        file_path: "notes.txt",
        offset: 1,
        limit: 10,
      });
      expect(result.ok).toBe(true);
      expect(prompts.length).toBe(0);
    },
    T,
  );

  it(
    "fs-kind requests outside the workspace are NOT auto-approved (gate-level)",
    async () => {
      // No portal tool can derive an out-of-workspace target (the tool layer
      // rejects absolute/escaping paths before the gate), so this drives the
      // gate directly with a synthetic fs tool: an in-workspace target
      // auto-approves, an out-of-workspace target raises a prompt.
      const wd = makeTmpDir("pi-gate-");
      const outside = makeTmpDir("pi-gate-out-");
      const fsConvId = await createConversation(wd);
      const { createPiPermissionResolver } =
        await import("../../../src/lib/server/pi/permission-gate");
      const { ok } = await import("../../../src/lib/server/tools/types");
      const tool: PortalTool = {
        name: "synthetic_edit",
        description: "test",
        parameters: {},
        derivePermissionRequest: (args) => {
          const path = (args as { path?: string }).path;
          return path ? { permissionKind: "edit", path } : null;
        },
        handler: async () => ok("edited"),
      };
      const emitted: InteractiveRequestView[] = [];
      const resolver = createPiPermissionResolver({
        userId: USER,
        conversationId: conversationIdCodec.parse(fsConvId),
        workingDirectory: wd,
        policy: "prompt",
        portalToolsByName: new Map([["synthetic_edit", tool]]),
        getApprovalMode: () => "ask",
        getWorkspaceRoots: () => [wd],
        emit: (ev) => {
          if (ev.type === "interactive.request") emitted.push(ev.request);
        },
      });

      // In-workspace: no prompt, auto-approved by policy.
      const inCall = await resolver(
        "synthetic_edit",
        { path: join(wd, "x.txt") },
        "c-in",
      );
      expect(inCall.allow).toBe(true);
      expect(emitted.length).toBe(0);

      // Out-of-workspace: NOT auto-approved — a prompt is raised, and its
      // resolution is honored.
      const { resolve } =
        await import("../../../src/lib/server/runtime/interactive-requests");
      const outCall = resolver(
        "synthetic_edit",
        { path: join(outside, "x.txt") },
        "c-out",
      );
      expect(emitted.length).toBe(1);
      const allowed = await new Promise<{ allow: boolean }>((done) => {
        resolve(emitted[0].requestId, USER, {
          kind: "permission",
          decision: "allow-once",
        });
        void outCall.then((d) => done(d));
      });
      expect(allowed.allow).toBe(true);
    },
    T,
  );

  it(
    "ungranted custom-tool raises an interactive request and honors resolution",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const session = await openSession(wd, convId);
      const { result, prompts } = await runToolCall(
        session,
        "bash",
        { command: "mktemp -d" },
        (view) =>
          view.kind === "permission"
            ? { kind: "permission", decision: "allow-once" }
            : undefined,
      );
      expect(prompts.length).toBe(1);
      expect(prompts[0].tool).toBe("bash");
      expect(prompts[0].canPersistDecision).toBe(true);
      expect(ran(result)).toBe(true);
    },
    T,
  );

  it(
    "a denied resolution blocks the tool call",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const session = await openSession(wd, convId);
      const { result, prompts } = await runToolCall(
        session,
        "bash",
        { command: "mktemp -d" },
        (view) =>
          view.kind === "permission"
            ? {
                kind: "permission",
                decision: "deny",
                feedback: "the test denies it",
              }
            : undefined,
      );
      expect(prompts.length).toBe(1);
      expect(ran(result)).toBe(false);
      expect(result.summary).toContain("the test denies it");
    },
    T,
  );

  it(
    "auto-deny approval mode blocks without prompting; auto-approve allows",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const deniedConv = await createConversation(wd);
      const denied = await openSession(wd, deniedConv, {
        approvalMode: "auto-deny",
      });
      const blocked = await runToolCall(denied, "bash", {
        command: "mktemp -d",
      });
      expect(ran(blocked.result)).toBe(false);
      expect(blocked.prompts.length).toBe(0);

      const allowedConv = await createConversation(wd);
      const allowed = await openSession(wd, allowedConv, {
        approvalMode: "auto-approve",
      });
      const ran2 = await runToolCall(allowed, "bash", { command: "mktemp -d" });
      expect(ran(ran2.result)).toBe(true);
      expect(ran2.prompts.length).toBe(0);
    },
    T,
  );

  it(
    "a disabled tool group removes its tools from the pi customTools",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const session = await openSession(wd, convId, {
        policy: "allow-all",
        disabledToolGroups: ["shell"],
      });
      const { result, prompts } = await runToolCall(session, "bash", {
        command: "mktemp -d",
      });
      // The tool never reaches pi's registry (group filtered before assembly),
      // so pi errors natively — the point is it's blocked, not allowed.
      expect(ran(result)).toBe(false);
      expect(result.summary).toContain("not found");
      expect(prompts.length).toBe(0);
    },
    T,
  );

  it(
    "shell permission prompts surface shell analysis + persistable scope (picker data)",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const session = await openSession(wd, convId);
      const { prompts } = await runToolCall(
        session,
        "bash",
        { command: "mktemp -d | cat" },
        (view) =>
          view.kind === "permission"
            ? { kind: "permission", decision: "allow-once" }
            : undefined,
      );
      expect(prompts.length).toBe(1);
      const p = prompts[0];
      expect(p.tool).toBe("bash");
      expect(p.permissionKind).toBe("shell");
      // canPersistDecision true → the dialog surfaces its grant-scope block
      // (scope picker; shell picker once shellAnalysis is present). `mktemp`
      // is not covered by any seed grant, so the request is prompt-policy.
      expect(p.canPersistDecision).toBe(true);
      expect(p.shellAnalysis).toEqual({
        kind: "parsed",
        segments: [
          { argv: ["mktemp", "-d"], followingOp: "|" },
          { argv: ["cat"], followingOp: null },
        ],
      });
    },
    T,
  );

  it(
    "a picker-persisted per-argv0 shell rule grant matches a later matching call",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const emitted: InteractiveRequestView[] = [];
      const { createPiPermissionResolver } =
        await import("../../../src/lib/server/pi/permission-gate");
      const { ok } = await import("../../../src/lib/server/tools/types");
      const tool: PortalTool = {
        name: "bash",
        description: "test",
        parameters: {},
        handler: async () => ok("ran"),
      };
      const resolver = createPiPermissionResolver({
        userId: USER,
        conversationId: conversationIdCodec.parse(convId),
        workingDirectory: wd,
        policy: "prompt",
        portalToolsByName: new Map([["bash", tool]]),
        getApprovalMode: () => "ask",
        getWorkspaceRoots: () => [wd],
        emit: (ev) => {
          if (ev.type === "interactive.request") emitted.push(ev.request);
        },
      });
      const { resolve } =
        await import("../../../src/lib/server/runtime/interactive-requests");

      // No matching allow grant → the `git` prompt seed fires and the call
      // prompts. (`git status` would hit the subcommand deny seed instead,
      // so `rev-parse` is used: it is only prompt-seeded.)
      const c1 = resolver("bash", { command: "git rev-parse HEAD" }, "c-1");
      expect(emitted.length).toBe(1);
      resolve(emitted[0].requestId, USER, {
        kind: "permission",
        decision: "allow-once",
      });
      expect((await c1).allow).toBe(true);

      // Persist the per-argv0 rule grant the shell picker emits for `git`.
      const { addGrant } =
        await import("../../../src/lib/server/db/repos/settings");
      addGrant({
        userId: USER,
        conversationId: convId,
        tool: "shell",
        permissionKind: "shell",
        scope: {
          kind: "shell",
          rule: { command: [{ token: "git" }], positionals: { kind: "any" } },
        },
        decision: "allow",
      });

      // A matching command auto-allows without prompting.
      const c2 = resolver("bash", { command: "git rev-parse HEAD" }, "c-2");
      expect((await c2).allow).toBe(true);
      expect(emitted.length).toBe(1);

      // A non-matching command (unseeded argv0 `pnpm`) still prompts.
      const c3 = resolver("bash", { command: "pnpm install" }, "c-3");
      expect(emitted.length).toBe(2);
      resolve(emitted[1].requestId, USER, {
        kind: "permission",
        decision: "deny",
      });
      expect((await c3).allow).toBe(false);
    },
    T,
  );

  it(
    "every denial mints a forced-retry token and an approved retry auto-allows once",
    async () => {
      const wd = makeTmpDir("pi-gate-");
      const convId = await createConversation(wd);
      const emitted: (InteractiveRequestView & { kind: "permission" })[] = [];
      const { createPiPermissionResolver } =
        await import("../../../src/lib/server/pi/permission-gate");
      const { buildPermissionTools } =
        await import("../../../src/lib/server/tools/permissions");
      const { ok } = await import("../../../src/lib/server/tools/types");
      const tool: PortalTool = {
        name: "synthetic_op",
        description: "test",
        parameters: {},
        handler: async () => ok("ran"),
      };
      const resolver = createPiPermissionResolver({
        userId: USER,
        conversationId: conversationIdCodec.parse(convId),
        workingDirectory: wd,
        policy: "prompt",
        portalToolsByName: new Map([["synthetic_op", tool]]),
        getApprovalMode: () => "ask",
        getWorkspaceRoots: () => [wd],
        emit: (ev) => {
          if (
            ev.type === "interactive.request" &&
            ev.request.kind === "permission"
          )
            emitted.push(ev.request);
        },
      });
      const { resolve } =
        await import("../../../src/lib/server/runtime/interactive-requests");

      // Human denies the prompt → the deny feedback carries a one-shot token.
      const pending = resolver("synthetic_op", { x: 1 }, "c-1");
      expect(emitted.length).toBe(1);
      resolve(emitted[0].requestId, USER, {
        kind: "permission",
        decision: "deny",
        feedback: "no",
      });
      const denied = await pending;
      expect(denied.allow).toBe(false);
      const token = /token: "([0-9a-f]{24})"/.exec(denied.reason ?? "")?.[1];
      expect(token).toBeTruthy();

      // force_retry_tool (no resolvePortalTool → approve-then-retry) raises a
      // fresh prompt; approving marks the token approved.
      const tools = buildPermissionTools({
        userId: USER,
        conversationId: conversationIdCodec.parse(convId),
        policy: "prompt",
        getMode: () => "interactive",
        getApprovalMode: () => "ask",
        emit: (ev) => {
          if (
            ev.type === "interactive.request" &&
            ev.request.kind === "permission"
          )
            emitted.push(ev.request);
        },
      });
      const forceTool = tools.find(
        (t) => t.name === "force_retry_tool",
      ) as PortalTool;
      const resultPromise = forceTool.handler({
        token,
        reason: "The test needs to run this one operation.",
      }) as Promise<ToolResult>;
      for (let i = 0; i < 200 && emitted.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(emitted.length).toBe(2);
      expect(emitted[1].escalationReason).toBe(
        "The test needs to run this one operation.",
      );
      resolve(emitted[1].requestId, USER, {
        kind: "permission",
        decision: "allow-once",
      });
      const result = await resultPromise;
      expect(result.ok).toBe(true);

      // Re-issuing the exact call is auto-allowed (token consumed).
      expect((await resolver("synthetic_op", { x: 1 }, "c-2")).allow).toBe(
        true,
      );

      // One-shot: a THIRD identical call is denied again.
      const third = resolver("synthetic_op", { x: 1 }, "c-3");
      expect(emitted.length).toBe(3);
      resolve(emitted[2].requestId, USER, {
        kind: "permission",
        decision: "deny",
      });
      expect((await third).allow).toBe(false);
    },
    T,
  );
});
