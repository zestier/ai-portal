import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { setupLocalEnv } from "../../helpers/env";
import { makeTmpDir } from "../../helpers/tmp";
import type {
  ProviderOpenOptions,
  ProviderSession,
} from "../../../src/lib/server/pi/session-contract";
import type { Turn } from "../../../src/lib/server/runtime/turn-runner";

// End-to-end pi session persistence: the durable JSONL session file is created
// on a conversation's first turn (path written back to the conversations row),
// resumed on later turns, and rewound by user-message ordinal for
// edit/regenerate reruns. Uses the real pi path + stub model (PI_STUB=1) so the
// file contents exercise the actual SDK SessionManager, not a mock.

const T = 30_000;

// Text of a pi user message: either a raw string or [TextContent] blocks.
function userText(m: { role?: string; content?: unknown }): string {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter(
        (b): b is { text: string } =>
          !!b && typeof b === "object" && "text" in b,
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/** User messages on the ACTIVE path of a session file, oldest first. */
function activeUserMessages(file: string, cwd: string): string[] {
  const sm = SessionManager.open(file, undefined, cwd);
  return sm
    .buildSessionContext()
    .messages.filter((m) => m.role === "user")
    .map(userText);
}

async function waitForTurn(turn: Turn): Promise<void> {
  while (turn.status === "running") {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(turn.status).toBe("complete");
}

/** Drain a session send, surfacing any error event as a test failure. */
async function sendText(
  session: ProviderSession,
  prompt: string,
  signal: AbortSignal,
): Promise<void> {
  for await (const ev of session.send(prompt, signal)) {
    if (ev.type === "error") throw new Error(`turn errored: ${ev.message}`);
  }
}

describe("pi session persistence", () => {
  beforeAll(async () => {
    process.env.PI_STUB = "1";
    await setupLocalEnv("pi-session-persist-");
    const { resetConfigForTests } =
      await import("../../../src/lib/server/config");
    resetConfigForTests();
  });

  afterEach(async () => {
    // Drop pooled sessions so one test's cached pi session can't leak into the
    // next (each conversation would otherwise keep its file open until reap).
    const { shutdown } = await import("../../../src/lib/server/runtime/pool");
    await shutdown();
  });

  it(
    "creates a durable session file on the first turn and resumes it on the next",
    async () => {
      const wd = makeTmpDir("pi-persist-wd-");
      const { ensureLocalUser } =
        await import("../../../src/lib/server/db/repos/users");
      const { create, get } =
        await import("../../../src/lib/server/db/repos/conversations");
      const { append } =
        await import("../../../src/lib/server/db/repos/messages");
      const { startTurnFromUserMessage } =
        await import("../../../src/lib/server/turn-start");

      const u = ensureLocalUser();
      const conv = create(u.id, { title: "persist", workdir: wd, model: null });
      expect(conv.sessionFile).toBeNull();

      // First turn: no file yet, so the bridge creates one.
      const m1 = append(conv.id, { role: "user", content: "first turn" });
      const turn1 = await startTurnFromUserMessage(conv, m1);
      await waitForTurn(turn1);

      const after1 = get(conv.id, u.id)!;
      expect(after1.sessionFile).not.toBeNull();
      const file = after1.sessionFile!;
      expect(existsSync(file)).toBe(true);

      // Second turn resumes the same file: both turns land on the active path.
      const m2 = append(conv.id, { role: "user", content: "second turn" });
      const turn2 = await startTurnFromUserMessage(after1, m2);
      await waitForTurn(turn2);

      expect(activeUserMessages(file, wd)).toEqual([
        "first turn",
        "second turn",
      ]);
    },
    T,
  );

  it(
    "seeds prior conversation history into a newly-created session file without duplicating the current prompt",
    async () => {
      // Fork/legacy resume: SQLite has complete history, the conversation has
      // no session file yet, and the first persistent turn must replay the
      // history into the tree exactly once (the current prompt is appended by
      // the turn itself, not seeded too).
      const wd = makeTmpDir("pi-seed-wd-");
      const { ensureLocalUser } =
        await import("../../../src/lib/server/db/repos/users");
      const { create, get } =
        await import("../../../src/lib/server/db/repos/conversations");
      const { append } =
        await import("../../../src/lib/server/db/repos/messages");
      const { startTurnFromUserMessage } =
        await import("../../../src/lib/server/turn-start");

      const u = ensureLocalUser();
      const conv = create(u.id, { title: "seed", workdir: wd, model: null });
      append(conv.id, { role: "user", content: "prior question" });
      append(conv.id, { role: "assistant", content: "prior answer" });
      const current = append(conv.id, {
        role: "user",
        content: "current prompt",
      });

      const turn = await startTurnFromUserMessage(conv, current, {
        rerun: true,
      });
      await waitForTurn(turn);

      const after = get(conv.id, u.id)!;
      expect(after.sessionFile).not.toBeNull();
      expect(activeUserMessages(after.sessionFile!, wd)).toEqual([
        "prior question",
        "current prompt",
      ]);
    },
    T,
  );

  it(
    "rewinds to an edited user message ordinal and branches a new path in the file",
    async () => {
      const wd = makeTmpDir("pi-rewind-wd-");
      const { openPiSession } = await import("../../../src/lib/server/pi");
      const session = await openPiSession({
        conversationId: 1,
        userId: 1,
        workingDirectory: wd,
        model: "stub",
        policy: "prompt",
        sessionFilePath: null,
      } satisfies ProviderOpenOptions);
      expect(session.sessionFile).toBeTruthy();
      const file = session.sessionFile!;

      const ac = new AbortController();
      await sendText(session, "first question", ac.signal);
      await sendText(session, "second question", ac.signal);

      // Rerun: rewind to the FIRST user message, then branch with the edited
      // prompt. The active path must now be the new branch only.
      await session.rewindToUserMessageOrdinal?.(0);
      await sendText(session, "edited first question", ac.signal);
      await session.dispose();

      expect(activeUserMessages(file, wd)).toEqual(["edited first question"]);
    },
    T,
  );
});
