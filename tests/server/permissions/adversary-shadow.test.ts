import { describe, it, expect, beforeEach } from "vitest";
import { setupLocalEnv } from "../../helpers/env";
import type { AdversaryOutcome } from "../../../src/lib/server/permissions/adversary/client";
import type {
  ShadowHandle,
  ShadowObserveInput,
  ShadowRecorder,
} from "../../../src/lib/server/permissions/adversary/shadow";

// Phase 0's whole safety story in one file: the adversary observes and records,
// and NOTHING it does — succeeding, failing, hanging, or babbling — may change
// what the permission path returns or what the human is shown.
//
// The provider layer that used to sit in front of the recorder was deleted (T2);
// the reviewer's completion is re-wired onto the shared pi runtime (T5), but the
// harness still drives `createShadowRecorder.observe()` directly with the
// injected `complete` seam so these tests never touch a provider.

const ADVERSARY_MODEL = "reviewer-model";
const AGENT_MODEL = "agent-model";

interface HarnessOptions {
  /** Adversary completion seam. Omit for a canned deny. */
  complete?: (system: string, user: string) => Promise<string>;
  /** Skip enabling the shadow, to test the default-off path. */
  disabled?: boolean;
  /** Make the adversary model equal the agent model. */
  sameModel?: boolean;
  /** Per-conversation override, which should beat the server default. */
  conversationModel?: string;
  /** Point the recorder at a conversation id that does not exist in the DB. */
  brokenConversationId?: boolean;
}

async function makeHarness(options: HarnessOptions = {}) {
  // A configured model IS the enablement — there is no separate on/off flag.
  if (options.disabled) {
    delete process.env.ADVERSARY_SHADOW_BACKEND;
  } else {
    process.env.ADVERSARY_SHADOW_BACKEND = options.sameModel
      ? AGENT_MODEL
      : ADVERSARY_MODEL;
  }
  await setupLocalEnv(`portal-shadow-test-`);

  const { createShadowRecorder } =
    await import("../../../src/lib/server/permissions/adversary/shadow");
  const shadowRepo =
    await import("../../../src/lib/server/db/repos/shadow-decisions");
  const { ensureLocalUser } =
    await import("../../../src/lib/server/db/repos/users");
  const convs = await import("../../../src/lib/server/db/repos/conversations");

  const user = ensureLocalUser();
  const conversationId = convs.create(user.id, {
    title: "shadow test",
    workdir: "/tmp",
    model: AGENT_MODEL,
  }).id;

  let completeCalls = 0;
  const settled: AdversaryOutcome[] = [];
  let notifySettled: (() => void) | null = null;

  const shadowRecorder: ShadowRecorder = createShadowRecorder({
    getModel: () => options.conversationModel ?? null,
    userId: user.id,
    complete: async (system: string, user: string) => {
      completeCalls++;
      return options.complete
        ? await options.complete(system, user)
        : '{"verdict":"deny","denyProbability":0.8,"rationale":"Reaches outside the workspace."}';
    },
    onSettled: (outcome) => {
      settled.push(outcome);
      notifySettled?.();
    },
  });

  // Mirrors what the (deleted) permission adapter passed into `observe`:
  // conversation id, the agent's own model for the same-model guard, and the
  // portal-derived facts of the request under review.
  const observe = (
    overrides: Partial<ShadowObserveInput> = {},
  ): ShadowHandle | null =>
    shadowRecorder.observe({
      conversationId: options.brokenConversationId ? 999999 : conversationId,
      argsHash: null,
      resolutionSource: "prompt-policy",
      agentModel: AGENT_MODEL,
      ...URL_REQUEST_FACTS,
      ...overrides,
    });

  const waitForSettled = async (count = 1) => {
    const deadline = Date.now() + 2000;
    while (settled.length < count && Date.now() < deadline) {
      await new Promise<void>((r) => {
        notifySettled = r;
        setTimeout(r, 10);
      });
    }
    notifySettled = null;
  };

  return {
    shadowRepo,
    user,
    conversationId,
    observe,
    waitForSettled,
    rows: () => shadowRepo.listForConversation(conversationId),
    completeCalls: () => completeCalls,
  };
}

const URL_REQUEST_FACTS = {
  tool: "web_fetch",
  permissionKind: "url",
  scopeKey: "https://example.com/docs",
  args: { url: "https://example.com/docs" },
  workspaceRoots: ["/tmp"],
  workingDirectory: "/tmp",
};

describe("adversary shadow mode", () => {
  beforeEach(() => {
    delete process.env.ADVERSARY_SHADOW_BACKEND;
    delete process.env.ADVERSARY_SHADOW_MAX_IN_FLIGHT;
  });

  it("records the adversary verdict alongside the human decision", async () => {
    const harness = await makeHarness();
    harness.observe()?.recordHuman("allow-once");
    await harness.waitForSettled();

    const rows = harness.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "verdict",
      verdict: "deny",
      denyProbability: 0.8,
      rationale: "Reaches outside the workspace.",
      humanDecision: "allow-once",
      tool: "web_fetch",
      permissionKind: "url",
      scopeKey: "https://example.com/docs",
      adversaryModel: ADVERSARY_MODEL,
      // No grant matched, so policy is what demanded the human. Recorded
      // so the sampled population can be characterized after the fact.
      resolutionSource: "prompt-policy",
      memoized: false,
    });
    expect(rows[0]?.promptVersion).toBeGreaterThanOrEqual(1);
    // Kept so a later analysis can spot rubber-stamping (a human answering
    // in milliseconds is a weak signal that the label is not considered).
    expect(rows[0]?.humanDecidedAt).toBeGreaterThanOrEqual(rows[0]!.createdAt);
  });

  it("records a human denial as the label", async () => {
    const harness = await makeHarness({
      complete: async () => '{"verdict":"deny","rationale":"Untrusted host."}',
    });
    harness.observe()?.recordHuman("deny");
    await harness.waitForSettled();
    expect(harness.rows()[0]).toMatchObject({
      verdict: "deny",
      humanDecision: "deny",
    });
  });

  // The critical Phase 0 safety test. Each of these adversary failure modes
  // must leave the permission decision path byte-identical.
  const failureModes: Array<[string, () => Promise<string>]> = [
    [
      "throws",
      async () => {
        throw new Error("ECONNREFUSED");
      },
    ],
    ["returns unparseable output", async () => "Looks fine to me!"],
    [
      "returns an unknown verdict",
      async () => '{"verdict":"maybe","rationale":"unsure"}',
    ],
  ];

  for (const [label, complete] of failureModes) {
    it(`leaves the decision path unchanged when the adversary ${label}`, async () => {
      const harness = await makeHarness({ complete });
      // `observe` returns a handle (never throws); the caller raises the
      // human dialog regardless of what the adversary does afterwards.
      harness.observe()?.recordHuman("allow-once");
      await harness.waitForSettled();

      const rows = harness.rows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "error", verdict: null });
      expect(rows[0]?.error).toBeTruthy();
      // The human label is still attached: the request itself was a
      // perfectly normal, fully-answered prompt.
      expect(rows[0]?.humanDecision).toBe("allow-once");
    });
  }

  it("never blocks the human dialog on the adversary", async () => {
    // The adversary hangs forever. `observe` must still return a handle
    // synchronously and the label must attach — the row simply stays
    // `pending`.
    const harness = await makeHarness({
      complete: () => new Promise<string>(() => {}),
    });
    harness.observe()?.recordHuman("allow-always");
    expect(harness.rows()[0]).toMatchObject({
      status: "pending",
      verdict: null,
      humanDecision: "allow-always",
    });
  });

  it("leaves no human label when the prompt is cancelled", async () => {
    // A cancelled prompt is NOT a denial, so it must not be scored as one.
    // The row keeps `humanDecision: null`, which the scorer excludes. The
    // recorder never learns the dialog was cancelled — `recordHuman` is
    // simply not called, which is the same contract the adapter followed.
    const harness = await makeHarness();
    harness.observe();
    await harness.waitForSettled();

    const rows = harness.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "verdict",
      humanDecision: null,
      humanDecidedAt: null,
    });

    const { scoreShadowDecisions } =
      await import("../../../src/lib/server/permissions/adversary/scoring");
    expect(scoreShadowDecisions(rows)).toMatchObject({
      total: 1,
      scored: 0,
      excludedNoHumanLabel: 1,
      denyRecall: null,
    });
  });

  it("memoizes identical requests to one provider call", async () => {
    const harness = await makeHarness();
    harness.observe()?.recordHuman("allow-once");
    await harness.waitForSettled(1);
    harness.observe()?.recordHuman("deny");
    await harness.waitForSettled(2);

    expect(harness.completeCalls()).toBe(1);
    const rows = harness.rows();
    expect(rows).toHaveLength(2);
    // Both rows carry the verdict; the second is flagged as reusing it, so
    // cost and coverage can be told apart in the readout.
    expect(rows.map((r) => r.verdict)).toEqual(["deny", "deny"]);
    expect(rows.map((r) => r.memoized)).toEqual([false, true]);
    expect(rows.map((r) => r.humanDecision)).toEqual(["allow-once", "deny"]);
  });

  it("does not replay a verdict when the facts changed underneath it", async () => {
    // Regression: the memo key used to be tool+kind+scopeKey+argsHash, which
    // omits `workspaceRoots` — the one fact the system prompt tells the
    // reviewer to judge against, and which changes mid-session as worktree
    // leases come and go. The identical request judged before and after a
    // lease exists is NOT the same question.
    const harness = await makeHarness();
    harness.observe()?.recordHuman("allow-once");
    await harness.waitForSettled(1);
    harness
      .observe({ workspaceRoots: ["/tmp", "/tmp/worktree-a"] })
      ?.recordHuman("allow-once");
    await harness.waitForSettled(2);

    expect(harness.completeCalls()).toBe(2);
    expect(harness.rows().map((r) => r.memoized)).toEqual([false, false]);
  });

  it("retries after an error instead of caching the failure", async () => {
    let call = 0;
    const harness = await makeHarness({
      complete: async () => {
        call++;
        if (call === 1) throw new Error("transient");
        return '{"verdict":"allow","rationale":"Fine."}';
      },
    });
    harness.observe()?.recordHuman("allow-once");
    await harness.waitForSettled(1);
    harness.observe()?.recordHuman("allow-once");
    await harness.waitForSettled(2);

    expect(harness.completeCalls()).toBe(2);
    expect(harness.rows().map((r) => r.status)).toEqual(["error", "verdict"]);
  });

  it("caps concurrent adversary calls and records the skips visibly", async () => {
    // With no dialog pacing the requests (auto-approve), an unbounded
    // fan-out would open one completion per tool call. Over the cap the row
    // is written as an explicit skip rather than dropped: the hole it leaves
    // is not random (it lands on the busiest moments), so it has to be
    // visible in the data.
    process.env.ADVERSARY_SHADOW_MAX_IN_FLIGHT = "1";
    // A holder rather than a `let`: TypeScript narrows a `let` assigned only
    // inside a callback to `never` at the call site below.
    const gate = { release: () => {} };
    const harness = await makeHarness({
      complete: () =>
        new Promise<string>((resolve) => {
          gate.release = () =>
            resolve(
              '{"verdict":"allow","denyProbability":0.1,"rationale":"ok"}',
            );
        }),
    });

    // First request occupies the only slot and stays in flight.
    harness.observe()?.recordHuman("allow-once");
    // Second request has different facts (so it cannot be memoized) and
    // finds the cap full.
    harness
      .observe({
        scopeKey: "https://example.com/other",
        args: { url: "https://example.com/other" },
      })
      ?.recordHuman("allow-once");
    await harness.waitForSettled(1);

    const skipped = harness.rows().filter((r) => r.status === "error");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.error).toContain("skipped");
    // No call was made, so no latency — a zero would enter the readout's
    // percentiles and make the adversary look fastest exactly when it was
    // being throttled.
    expect(skipped[0]?.latencyMs).toBeNull();
    expect(harness.completeCalls()).toBe(1);

    // The in-flight call still settles normally and frees its slot.
    gate.release();
    await harness.waitForSettled(2);
    expect(harness.rows().filter((r) => r.status === "verdict")).toHaveLength(
      1,
    );
  });

  it("is inert unless a model is configured", async () => {
    const harness = await makeHarness({ disabled: true });
    expect(harness.observe()).toBeNull();
    expect(harness.rows()).toHaveLength(0);
    expect(harness.completeCalls()).toBe(0);
  });

  it("prefers the conversation model over the server default", async () => {
    // The precedence that makes this a setting rather than an env var:
    // conversation override -> user default (seeded onto the conversation at
    // creation) -> server default.
    const harness = await makeHarness({
      conversationModel: "per-conversation-reviewer",
    });
    harness.observe()?.recordHuman("allow-once");
    await harness.waitForSettled();
    expect(harness.rows()[0]?.adversaryModel).toBe("per-conversation-reviewer");
  });

  it("runs from a conversation model alone, with no server default set", async () => {
    // The case an env-only design could not express at all: an operator who
    // never configured a reviewer, and a user who chose one.
    const harness = await makeHarness({
      disabled: true,
      conversationModel: "user-chosen-reviewer",
    });
    harness.observe()?.recordHuman("allow-once");
    await harness.waitForSettled();
    const rows = harness.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.adversaryModel).toBe("user-chosen-reviewer");
  });

  it("refuses to run when the adversary model equals the agent model", async () => {
    // Shared weights means shared blind spots: the run would measure
    // self-agreement, not oversight. Both model strings are
    // provider-qualified, so an equal string IS the same reviewer.
    const harness = await makeHarness({ sameModel: true });
    expect(harness.observe()).toBeNull();
    expect(harness.rows()).toHaveLength(0);
    expect(harness.completeCalls()).toBe(0);
  });

  it("survives a failing shadow insert without touching the decision path", async () => {
    // Foreign key violation: the conversation row does not exist. `observe`
    // must swallow it and return null rather than throw — the measurement
    // experiment can never break the permission path it is measuring.
    const harness = await makeHarness({ brokenConversationId: true });
    expect(harness.observe()).toBeNull();
    expect(harness.completeCalls()).toBe(0);
  });

  it("collects the auto-approve population, unlabelled and excluded from scoring", async () => {
    // These are the requests a future veto-over-auto-approve product would
    // gate. Nobody is asked, so there is no human label and the scorer
    // excludes them — they are collected anyway because the request cannot
    // be recovered after the fact, and can be adjudicated later.
    const harness = await makeHarness();
    harness.observe({ resolutionSource: "auto-approve" });
    await harness.waitForSettled();

    const rows = harness.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resolutionSource: "auto-approve",
      status: "verdict",
      verdict: "deny",
      humanDecision: null,
    });
    // The prompt actually sent is kept so these rows can be adjudicated
    // later — they are the only record of a request nobody was asked about.
    expect(rows[0]?.promptSent).toContain("PERMISSION REQUEST");

    const { scoreShadowDecisions } =
      await import("../../../src/lib/server/permissions/adversary/scoring");
    expect(scoreShadowDecisions(rows)).toMatchObject({
      total: 1,
      scored: 0,
      // Bucketed as "nobody was asked", not as an abandoned prompt, and
      // kept out of the coverage denominator.
      unlabellableByDesign: 1,
      excludedNoHumanLabel: 0,
      coverage: null,
    });
  });

  it("round-trips through the repo into the numbers the readout prints", async () => {
    // Covers the exact data path `scripts/adversary-shadow-report.mjs` uses:
    // repo read -> scoring, including stratification by (model, prompt
    // version) and the memoized-row exclusion.
    const harness = await makeHarness();
    const { scoreShadowDecisions } =
      await import("../../../src/lib/server/permissions/adversary/scoring");
    const repo = harness.shadowRepo;

    const seed = (
      id: string,
      verdict: "allow" | "deny",
      human: "allow-once" | "deny" | null,
      opts: { memoized?: boolean } = {},
    ) => {
      const rowId = repo.insertPending({
        conversationId: harness.conversationId,
        tool: "shell",
        permissionKind: "shell",
        scopeKey: `cmd-${id}`,
        argsHash: null,
        adversaryModel: ADVERSARY_MODEL,
        experimentKey: "exp-1",
        promptVersion: 1,
        factsKey: `facts-${id}`,
        resolutionSource: "prompt-policy",
      });
      repo.recordVerdict(rowId, verdict, "because", {
        denyProbability: 0.7,
        memoized: opts.memoized ?? false,
        promptSent: "PERMISSION REQUEST ...",
      });
      if (human) repo.recordHumanDecision(rowId, human);
    };

    seed("s1", "deny", "deny");
    seed("s2", "deny", "allow-once");
    seed("s3", "allow", "deny");
    seed("s4", "allow", "allow-once");
    seed("s5", "deny", null); // cancelled: no label
    seed("s6", "deny", "deny", { memoized: true }); // correlated replay

    const rows = repo.listForUser(harness.user.id);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.denyProbability === 0.7)).toBe(true);
    expect(rows.every((r) => r.resolutionSource === "prompt-policy")).toBe(
      true,
    );
    // The evidence that makes a disagreement adjudicable later.
    expect(
      rows.every((r) => r.promptSent !== null && r.factsKey !== null),
    ).toBe(true);

    const score = scoreShadowDecisions(rows);
    expect(score).toMatchObject({
      total: 6,
      scored: 4,
      excludedNoHumanLabel: 1,
      memoizedDuplicates: 1,
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
      trueNegatives: 1,
    });
    expect(score.denyPrecision).toBeCloseTo(0.5);
    expect(score.denyRecall).toBeCloseTo(0.5);
    // Memoized replays leave the denominator: excluding them is a choice of
    // estimand, not lost coverage.
    expect(score.coverage).toBeCloseTo(4 / 5);

    // The memoized replay only counts when explicitly asked for.
    expect(
      scoreShadowDecisions(rows, { includeMemoized: true }).truePositives,
    ).toBe(2);
  });
});
