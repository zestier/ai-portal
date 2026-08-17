import { describe, it, expect, beforeEach } from "vitest";
import { setupLocalEnv } from "../helpers/env";
import {
  INLINE_ARGS_MAX_BYTES,
  INLINE_DIFF_MAX_BYTES,
  INLINE_REASONING_MAX_BYTES,
  INLINE_RESULT_MAX_BYTES,
} from "../../src/lib/payload-limits";

// Opening a long conversation used to serialize every tool call's full args and
// result into the page payload. `listByConversation({ inlineMaxBytes })` swaps
// oversized fields for truncation markers; everything else must keep exactly
// the shape it had before.

const TRIM = {
  args: INLINE_ARGS_MAX_BYTES,
  result: INLINE_RESULT_MAX_BYTES,
  diff: INLINE_DIFF_MAX_BYTES,
  reasoning: INLINE_REASONING_MAX_BYTES,
};

async function seed() {
  const users = await import("../../src/lib/server/db/repos/users");
  const convs = await import("../../src/lib/server/db/repos/conversations");
  const messages = await import("../../src/lib/server/db/repos/messages");

  const user = users.ensureLocalUser();
  const conv = convs.create(user.id, {
    title: "trim",
    workdir: "/tmp",
    model: null,
  });
  const msg = messages.append(conv.id, { role: "assistant", content: "hi" });

  const bigArgs = JSON.stringify({
    payload: "a".repeat(INLINE_ARGS_MAX_BYTES + 100),
  });
  const smallArgs = JSON.stringify({ path: "src/app.ts" });
  const bigResult = JSON.stringify({
    ok: true,
    result: "r".repeat(INLINE_RESULT_MAX_BYTES + 100),
  });
  const smallResult = JSON.stringify({ ok: true, result: "short" });

  messages.insertToolCall(msg.id, {
    id: 1,
    tool: "view",
    argsJson: smallArgs,
    resultJson: smallResult,
    status: "ok",
    startedAt: 1,
    endedAt: 2,
    textOffset: 0,
    parentToolCallId: null,
  });
  messages.insertToolCall(msg.id, {
    id: 2,
    tool: "bash",
    argsJson: bigArgs,
    resultJson: bigResult,
    status: "ok",
    startedAt: 3,
    endedAt: 4,
    textOffset: 1,
    parentToolCallId: null,
  });
  messages.insertToolCall(msg.id, {
    id: 3,
    tool: "bash",
    argsJson: smallArgs,
    resultJson: null,
    status: "pending",
    startedAt: 5,
    endedAt: null,
    textOffset: 2,
    parentToolCallId: null,
  });
  messages.insertToolCall(msg.id, {
    id: 4,
    tool: "task",
    argsJson: JSON.stringify({
      agent_type: "memory-extractor",
      description: "extract",
      prompt: "p".repeat(INLINE_ARGS_MAX_BYTES + 5000),
    }),
    resultJson: bigResult,
    status: "ok",
    startedAt: 6,
    endedAt: 7,
    textOffset: 3,
    parentToolCallId: null,
  });
  messages.insertFileEdit(msg.id, "small.ts", "d".repeat(10), 0, null);
  messages.insertFileEdit(
    msg.id,
    "big.ts",
    "D".repeat(INLINE_DIFF_MAX_BYTES + 100),
    1,
    null,
  );

  const bigReasoning = "T".repeat(INLINE_REASONING_MAX_BYTES + 100);
  const smallReasoning = "thinking briefly";
  const bigSpoken = "S".repeat(INLINE_REASONING_MAX_BYTES + 100);
  messages.insertReasoningBlock(msg.id, {
    id: 5,
    segmentIndex: 0,
    text: smallReasoning,
    kind: "reasoning",
    textOffset: 0,
    startedAt: 1,
    durationMs: 10,
    parentToolCallId: null,
  });
  messages.insertReasoningBlock(msg.id, {
    id: 6,
    segmentIndex: 1,
    text: bigReasoning,
    kind: "reasoning",
    textOffset: 1,
    startedAt: 2,
    durationMs: 20,
    parentToolCallId: null,
  });
  messages.insertReasoningBlock(msg.id, {
    id: 7,
    segmentIndex: 2,
    text: bigSpoken,
    kind: "content",
    textOffset: null,
    startedAt: 3,
    durationMs: null,
    parentToolCallId: 4,
  });

  messages.insertReasoningBlock(msg.id, {
    id: 8,
    segmentIndex: 3,
    text: "O".repeat(INLINE_REASONING_MAX_BYTES + 100),
    kind: "reasoning",
    textOffset: 2,
    startedAt: 4,
    durationMs: null,
    parentToolCallId: null,
  });

  return {
    user,
    conv,
    msg,
    bigArgs,
    smallArgs,
    bigResult,
    smallResult,
    bigReasoning,
    smallReasoning,
    bigSpoken,
    messages,
  };
}

describe("listByConversation payload trim", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-payload-trim-");
  });

  it("leaves every field inline when no trim is requested", async () => {
    const { conv, bigArgs, bigResult, bigReasoning, messages } = await seed();
    const [m] = messages.listByConversation(conv.id);
    const big = m.toolCalls!.find((t) => t.id === "X2")!;
    expect(big.argsJson).toBe(bigArgs);
    expect(big.resultJson).toBe(bigResult);
    expect(big.argsTruncated).toBeUndefined();
    expect(big.resultTruncated).toBeUndefined();
    const bigEdit = m.fileEdits!.find((e) => e.path === "big.ts")!;
    expect(bigEdit.diff).toHaveLength(INLINE_DIFF_MAX_BYTES + 100);
    expect(bigEdit.diffTruncated).toBeUndefined();
    const bigBlock = m.reasoningBlocks!.find((r) => r.id === 6)!;
    expect(bigBlock.text).toBe(bigReasoning);
    expect(bigBlock.textTruncated).toBeUndefined();
  });

  it("replaces over-threshold fields with markers carrying the byte size", async () => {
    const { conv, bigArgs, bigResult, messages } = await seed();
    const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });

    const big = m.toolCalls!.find((t) => t.id === "X2")!;
    expect(big.argsJson).toBeNull();
    expect(big.argsTruncated).toBe(true);
    expect(big.argsBytes).toBe(Buffer.byteLength(bigArgs, "utf8"));
    expect(big.resultJson).toBeNull();
    expect(big.resultTruncated).toBe(true);
    expect(big.resultBytes).toBe(Buffer.byteLength(bigResult, "utf8"));

    const bigEdit = m.fileEdits!.find((e) => e.path === "big.ts")!;
    expect(bigEdit.diff).toBeNull();
    expect(bigEdit.diffTruncated).toBe(true);
    expect(bigEdit.diffBytes).toBe(INLINE_DIFF_MAX_BYTES + 100);

    const bigBlock = m.reasoningBlocks!.find((r) => r.id === 6)!;
    expect(bigBlock.text).toBeNull();
    expect(bigBlock.textTruncated).toBe(true);
    expect(bigBlock.textBytes).toBe(INLINE_REASONING_MAX_BYTES + 100);
    // The collapsed row must look identical to an untrimmed one: its header
    // is drawn entirely from these.
    expect(bigBlock.durationMs).toBe(20);
    expect(bigBlock.segmentIndex).toBe(1);
    expect(bigBlock.textOffset).toBe(1);
  });

  it("keeps under-threshold fields inline and unmarked", async () => {
    const { conv, smallArgs, smallResult, smallReasoning, messages } =
      await seed();
    const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });

    const small = m.toolCalls!.find((t) => t.id === "X1")!;
    expect(small.argsJson).toBe(smallArgs);
    expect(small.resultJson).toBe(smallResult);
    expect(small.argsTruncated).toBeUndefined();
    expect(small.resultTruncated).toBeUndefined();
    expect(small.argsBytes).toBeUndefined();

    const smallEdit = m.fileEdits!.find((e) => e.path === "small.ts")!;
    expect(smallEdit.diff).toBe("d".repeat(10));
    expect(smallEdit.diffTruncated).toBeUndefined();

    const smallBlock = m.reasoningBlocks!.find((r) => r.id === 5)!;
    expect(smallBlock.text).toBe(smallReasoning);
    expect(smallBlock.textTruncated).toBeUndefined();
    expect(smallBlock.textBytes).toBeUndefined();
  });

  it("never trims a still-open reasoning block, whatever its size", async () => {
    // A block with no durationMs is being streamed right now: it renders
    // expanded, and the client appends further deltas to the text it already
    // has. Trimming it would drop the streamed prefix on a mid-turn reload.
    const { conv, messages } = await seed();
    const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });
    const open = m.reasoningBlocks!.find((r) => r.id === 8)!;
    expect(open.durationMs).toBeNull();
    expect(open.text).toBe("O".repeat(INLINE_REASONING_MAX_BYTES + 100));
    expect(open.textTruncated).toBeUndefined();
  });

  it("never trims a sub-agent’s spoken content block, whatever its size", async () => {
    // `kind: 'content'` blocks are a sub-agent's answer, rendered as markdown
    // in the card's activity timeline with no expand step — trimming them
    // would blank out the response on reload.
    const { conv, bigSpoken, messages } = await seed();
    const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });
    const spoken = m.reasoningBlocks!.find((r) => r.id === 7)!;
    expect(spoken.kind).toBe("content");
    expect(spoken.text).toBe(bigSpoken);
    expect(spoken.textTruncated).toBeUndefined();
  });

  it("never trims a subagent launch\u2019s arguments, whatever their size", async () => {
    // A `task` call's args carry the subagent card's headline, pills and
    // "Retry extraction" button — all rendered while the card is COLLAPSED,
    // so trimming them would leave a reloaded conversation full of
    // unlabelled, un-retryable rows. Its result is still trimmed.
    const { conv, messages } = await seed();
    const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });
    const task = m.toolCalls!.find((t) => t.id === "X4")!;
    expect(task.argsJson).not.toBeNull();
    expect(JSON.parse(task.argsJson!).agent_type).toBe("memory-extractor");
    expect(task.argsTruncated).toBeUndefined();
    expect(task.resultTruncated).toBe(true);
    expect(task.resultJson).toBeNull();
  });

  it("does not mark a genuinely absent result as truncated", async () => {
    // A pending call's result_json is NULL because there is no result yet —
    // the client must not offer to "load" something that does not exist.
    const { conv, messages } = await seed();
    const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });
    const pending = m.toolCalls!.find((t) => t.id === "X3")!;
    expect(pending.resultJson).toBeNull();
    expect(pending.resultTruncated).toBeUndefined();
    expect(pending.resultBytes).toBeUndefined();
  });

  it("preserves every other field of a trimmed record", async () => {
    const { conv, messages } = await seed();
    const [plain] = messages.listByConversation(conv.id);
    const [trimmed] = messages.listByConversation(conv.id, {
      inlineMaxBytes: TRIM,
    });
    const strip = (m: (typeof plain)["toolCalls"]) =>
      m!.map((t) => ({
        ...t,
        argsJson: null,
        resultJson: null,
      }));
    expect(
      strip(trimmed.toolCalls).map((t) => ({
        ...t,
        argsTruncated: undefined,
        argsBytes: undefined,
        resultTruncated: undefined,
        resultBytes: undefined,
      })),
    ).toEqual(
      strip(plain.toolCalls).map((t) => ({
        ...t,
        argsTruncated: undefined,
        argsBytes: undefined,
        resultTruncated: undefined,
        resultBytes: undefined,
      })),
    );
    expect(trimmed.toolCalls!.map((t) => t.id)).toEqual(
      plain.toolCalls!.map((t) => t.id),
    );
    expect(trimmed.content).toBe(plain.content);

    // Same for reasoning blocks: only `text` and its markers may differ.
    expect(
      trimmed.reasoningBlocks!.map((r) => ({
        ...r,
        text: null,
        textTruncated: undefined,
        textBytes: undefined,
      })),
    ).toEqual(plain.reasoningBlocks!.map((r) => ({ ...r, text: null })));
  });
});

describe("lazy field lookups", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-payload-trim-fetch-");
  });

  it("returns the full stored text for the owner", async () => {
    const { conv, user, bigArgs, bigResult, messages } = await seed();
    expect(
      messages.getToolCallFieldForOwner(conv.id, 2, user.id, "args")?.value,
    ).toBe(bigArgs);
    expect(
      messages.getToolCallFieldForOwner(conv.id, 2, user.id, "result")?.value,
    ).toBe(bigResult);
  });

  it("denies a different user, an unknown id, and a foreign conversation alike", async () => {
    const users = await import("../../src/lib/server/db/repos/users");
    const { conv, messages } = await seed();
    const other = users.ensureLocalUser("intruder");
    expect(
      messages.getToolCallFieldForOwner(conv.id, 2, other.id, "args"),
    ).toBeNull();
    expect(
      messages.getToolCallFieldForOwner(conv.id, 999999, conv.userId, "args"),
    ).toBeNull();
    expect(
      messages.getToolCallFieldForOwner(999999, 2, conv.userId, "args"),
    ).toBeNull();
  });

  it("resolves a file edit diff by id, scoped to the conversation owner", async () => {
    const { conv, messages } = await seed();
    const [m] = messages.listByConversation(conv.id, { inlineMaxBytes: TRIM });
    const bigEdit = m.fileEdits!.find((e) => e.path === "big.ts")!;
    expect(
      messages.getFileEditDiffForOwner(conv.id, bigEdit.id, conv.userId)?.value,
    ).toBe("D".repeat(INLINE_DIFF_MAX_BYTES + 100));
    expect(
      messages.getFileEditDiffForOwner(conv.id, 999999, conv.userId),
    ).toBeNull();
  });

  it("resolves reasoning text by id, scoped to the conversation owner", async () => {
    const users = await import("../../src/lib/server/db/repos/users");
    const { conv, bigReasoning, messages } = await seed();
    expect(
      messages.getReasoningTextForOwner(conv.id, 6, conv.userId)?.value,
    ).toBe(bigReasoning);
    const other = users.ensureLocalUser("reasoning-intruder");
    expect(messages.getReasoningTextForOwner(conv.id, 6, other.id)).toBeNull();
    expect(
      messages.getReasoningTextForOwner(conv.id, 999999, conv.userId),
    ).toBeNull();
    expect(
      messages.getReasoningTextForOwner(999999, 6, conv.userId),
    ).toBeNull();
  });
});
