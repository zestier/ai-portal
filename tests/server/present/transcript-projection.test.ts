import { describe, it, expect, beforeEach } from "vitest";
import { setupLocalEnv } from "../../helpers/env";
import { messageId as msgCodec } from "../../../src/lib/ids";
import {
  projectMessageForOwner,
  projectTranscript,
  projectIndexPage,
  previewCut,
} from "../../../src/lib/server/present/transcript";
import {
  TRANSCRIPT_HYDRATED_TAIL,
  TRANSCRIPT_INDEX_COUNT,
  INLINE_ARGS_MAX_BYTES,
} from "../../../src/lib/payload-limits";

// The backend-projected transcript (BFF presentation layer): the server
// shapes raw rows into a compact index (previews + record descriptors) plus a
// bounded hydrated tail, with summaries computed at read time. No
// args/results/diffs/reasoning text ships in the list payload.

async function seed(conversationTitle = "projection") {
  const users = await import("../../../src/lib/server/db/repos/users");
  const convs = await import("../../../src/lib/server/db/repos/conversations");
  const messages = await import("../../../src/lib/server/db/repos/messages");

  const user = users.ensureLocalUser();
  const conv = convs.create(user.id, {
    title: conversationTitle,
    workdir: "/tmp",
    model: null,
  });

  // 8 user + 8 assistant turns, each assistant turn carrying a couple of
  // records (a bash call, a task call, an edit, a reasoning block).
  for (let i = 0; i < 8; i++) {
    messages.append(conv.id, { role: "user", content: `user turn ${i}` });
    const asst = messages.append(conv.id, {
      role: "assistant",
      content: `assistant turn ${i}\n\nSome **markdown** [link](https://x) and \`code\` here.`,
    });
    messages.insertToolCall(asst.id, {
      id: i * 10 + 1,
      tool: "bash",
      argsJson: JSON.stringify({ command: `echo turn-${i}` }),
      resultJson: JSON.stringify({ ok: true, result: "r".repeat(2000) }),
      status: "ok",
      startedAt: i * 1000 + 1,
      endedAt: i * 1000 + 2,
      textOffset: 0,
      parentToolCallId: null,
    });
    messages.insertToolCall(asst.id, {
      id: i * 10 + 2,
      tool: "task",
      argsJson: JSON.stringify({
        agent_type: "memory-extractor",
        description: "extract memory",
        model: "some/model",
        prompt: "p".repeat(INLINE_ARGS_MAX_BYTES + 100),
      }),
      resultJson: null,
      status: "pending",
      startedAt: i * 1000 + 3,
      endedAt: null,
      textOffset: 10,
      parentToolCallId: null,
    });
    messages.insertToolCall(asst.id, {
      id: i * 10 + 4,
      tool: "proc",
      argsJson: JSON.stringify({
        summary: "map owners",
        procedure: "search and reduce ".repeat(20),
        result_requirements: "paths and line ranges",
      }),
      resultJson: null,
      status: "pending",
      startedAt: i * 1000 + 5,
      endedAt: null,
      textOffset: 12,
      parentToolCallId: null,
    });
    messages.insertFileEdit(
      asst.id,
      `src/turn-${i}.ts`,
      "--- a/x\n+++ b/x\n@@ -1 +1,3 @@\n+added line\n-removed line\n context\n",
      20,
      null,
    );
    messages.insertReasoningBlock(asst.id, {
      id: i * 10 + 3,
      segmentIndex: 0,
      text: "First thought then continued reasoning.",
      kind: "reasoning",
      textOffset: 2,
      startedAt: i * 1000 + 4,
      durationMs: 1500,
      parentToolCallId: null,
    });
  }
  return { users, conv, user };
}

async function emptyConversation() {
  const users = await import("../../../src/lib/server/db/repos/users");
  const convs = await import("../../../src/lib/server/db/repos/conversations");
  const user = users.ensureLocalUser();
  const conv = convs.create(user.id, {
    title: "empty",
    workdir: "/tmp",
    model: null,
  });
  return { users, conv, user };
}

describe("previewCut", () => {
  it("strips markdown to plain text and cuts on a word boundary", () => {
    const p = previewCut(
      "one two three **four** five six seven eight nine ten",
      20,
    );
    // The 20-char cut lands mid-word on "five"; the boundary keeps "four".
    expect(p).toBe("one two three four…");
    expect(p!.length).toBeLessThanOrEqual(22);
  });
  it("returns null for empty or whitespace-only content", () => {
    expect(previewCut(null, 300)).toBeNull();
    expect(previewCut("", 300)).toBeNull();
    expect(previewCut("   \n  ", 300)).toBeNull();
  });
  it("returns short text untouched", () => {
    expect(previewCut("hi there", 300)).toBe("hi there");
  });
});

describe("projectTranscript", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-transcript-");
  });

  it("returns an empty projection for an empty conversation", async () => {
    const { conv } = await emptyConversation();
    const t = projectTranscript(conv.id);
    expect(t).toEqual({ tail: [], index: [], hasMoreOlder: false });
  });

  it("hydrates the newest tail and indexes the rest with descriptors", async () => {
    const { conv } = await seed();
    const t = projectTranscript(conv.id);
    expect(t.tail.length).toBe(TRANSCRIPT_HYDRATED_TAIL);
    expect(t.index.length).toBe(16 - TRANSCRIPT_HYDRATED_TAIL); // 16 msgs seeded
    expect(t.hasMoreOlder).toBe(false);

    const last = t.tail[t.tail.length - 1];
    expect(last.role).toBe("assistant");
    expect(last.content).toContain("assistant turn 7");

    // Records carry server-computed summaries; args/results never ship big.
    const tool = last.toolCalls![0];
    expect(tool.summary).toBe("echo turn-7");
    // Result was over the initial cap → marker + byte size, no text.
    expect(tool.resultJson).toBeNull();
    expect(tool.resultTruncated).toBe(true);
    expect(tool.resultBytes).toBeGreaterThan(1000);
    // Args were small → inline on the initial payload too.
    expect(tool.argsJson).toContain("echo turn-7");

    // `task` args over the cap are trimmed but the collapsed card still gets
    // its identity via meta (subagent pills).
    const task = last.toolCalls![1];
    expect(task.argsJson).toBeNull();
    expect(task.argsTruncated).toBe(true);
    expect(task.meta).toMatchObject({
      agent_type: "memory-extractor",
      model: "some/model",
    });
    expect(task.summary).toBe("extract memory");

    const proc = last.toolCalls![2];
    expect(proc.argsJson).toBeNull();
    expect(proc.meta).toMatchObject({
      result_requirements: "paths and line ranges",
    });

    const edit = last.fileEdits![0];
    expect(edit.summary).toBe("src/turn-7.ts (+1 −1)");

    const reasoning = last.reasoningBlocks![0];
    expect(reasoning.summary).toContain("Thought for 2s");
  });

  it("caps the index window and reports hasMoreOlder", async () => {
    const { conv } = await seed();
    const t = projectTranscript(conv.id);
    const tailIds = new Set(t.tail.map((m) => m.id));
    expect(t.index.length + t.tail.length).toBe(16);
    expect(t.index.every((e) => !tailIds.has(e.id))).toBe(true);
    // Every index entry is descriptor-only: no content, no args.
    for (const entry of t.index) {
      expect(entry.preview).toBeTruthy();
      for (const d of entry.records) {
        expect(d.summary.length).toBeGreaterThan(0);
      }
    }
  });

  it("splits a large conversation into tail + bounded index", async () => {
    const users = await import("../../../src/lib/server/db/repos/users");
    const convs =
      await import("../../../src/lib/server/db/repos/conversations");
    const messages = await import("../../../src/lib/server/db/repos/messages");
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "big",
      workdir: "/tmp",
      model: null,
    });
    for (
      let i = 0;
      i < TRANSCRIPT_HYDRATED_TAIL + TRANSCRIPT_INDEX_COUNT + 30;
      i++
    ) {
      messages.append(conv.id, {
        role: i % 2 ? "assistant" : "user",
        content: `m ${i}`,
      });
    }
    const t = projectTranscript(conv.id);
    expect(t.tail.length).toBe(TRANSCRIPT_HYDRATED_TAIL);
    expect(t.index.length).toBe(TRANSCRIPT_INDEX_COUNT);
    expect(t.hasMoreOlder).toBe(true);
  });
});

describe("projectIndexPage", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-transcript-");
  });

  it("pages older-than-beforeId in ascending order with hasMore", async () => {
    // 40 messages: tail (6) + initial index (10) loaded, 24 older to page.
    const users = await import("../../../src/lib/server/db/repos/users");
    const convs =
      await import("../../../src/lib/server/db/repos/conversations");
    const messages = await import("../../../src/lib/server/db/repos/messages");
    const user = users.ensureLocalUser();
    const conv = convs.create(user.id, {
      title: "paging",
      workdir: "/tmp",
      model: null,
    });
    for (let i = 0; i < 40; i++) {
      messages.append(conv.id, {
        role: i % 2 ? "assistant" : "user",
        content: `m ${i}`,
      });
    }
    const all = projectTranscript(conv.id);
    expect(all.hasMoreOlder).toBe(true);

    // Page forward from the oldest loaded index entry — the cursor the
    // client uses — until nothing older remains. Every page is index-only
    // (no content) and shares no ids with earlier pages.
    const seen = new Set(all.index.map((e) => e.id));
    let cursor = msgCodec.parse(all.index[0].id);
    for (;;) {
      const next = projectIndexPage(conv.id, cursor, 6);
      for (const e of next.entries) {
        expect(msgCodec.parse(e.id)).toBeLessThan(cursor);
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      cursor = next.entries[0] ? msgCodec.parse(next.entries[0].id) : cursor;
      if (!next.hasMore) break;
      expect(next.entries.length).toBeGreaterThan(0);
    }
    // All 40 messages loaded exactly once (tail + index + pages).
    expect(seen.size + all.tail.length).toBe(40);
  });

  it("returns an empty page for an unknown beforeId", async () => {
    const { conv } = await seed();
    const page = projectIndexPage(conv.id, 999_999, 6);
    expect(page.entries).toEqual([]);
    expect(page.hasMore).toBe(false);
  });
});
describe("projectMessageForOwner (hydration endpoint)", () => {
  beforeEach(async () => {
    await setupLocalEnv("portal-transcript-");
  });

  it("returns a full body with generous inline limits", async () => {
    const { conv } = await seed();
    const all = projectTranscript(conv.id);
    const midId = all.tail[Math.floor(all.tail.length / 2)].id;

    const hydrated = projectMessageForOwner(conv.id, msgCodec.parse(midId));
    expect(hydrated).not.toBeNull();
    expect(hydrated!.id).toBe(midId);
    const task = hydrated!.toolCalls!.find((t) => t.tool === "task");
    // On the hydration path task args stay inline (they are the card).
    expect(task!.argsJson).toContain("agent_type");
    expect(task!.summary).toBe("extract memory");
  });

  it("returns null for a message not in this conversation", async () => {
    const { conv } = await seed();
    expect(projectMessageForOwner(conv.id, 999_999)).toBeNull();
  });
});
