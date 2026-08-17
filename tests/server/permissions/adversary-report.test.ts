import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setupLocalEnv } from "../../helpers/env";

// End-to-end test of `scripts/adversary-shadow-report.mjs` against a real
// seeded database.
//
// It exists because the script is plain JS reading hand-written SQL, so a
// column the code uses but the SELECT omits is silently `undefined` rather than
// an error — which is exactly the bug that shipped once here (`isSkip` could
// never match because `error` was not selected, so the throttling hole the
// readout was supposed to expose stayed invisible). Unit-testing the scorer
// cannot catch that; only running the script can.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = resolve(repoRoot, "scripts/adversary-shadow-report.mjs");

async function seed() {
  const dataDir = await setupLocalEnv("portal-report-test-");
  const repo =
    await import("../../../src/lib/server/db/repos/shadow-decisions");
  const { ensureLocalUser } =
    await import("../../../src/lib/server/db/repos/users");
  const convs = await import("../../../src/lib/server/db/repos/conversations");

  const user = ensureLocalUser();
  const conversationId = convs.create(user.id, {
    title: "report test",
    workdir: "/tmp",
    model: "agent-model",
  }).id;

  let n = 0;
  const insert = (
    resolutionSource: "prompt-policy" | "prompt-grant" | "auto-approve",
    experimentKey = "exp-a",
  ) => {
    const label = `row-${conversationId}-${n++}`;
    return repo.insertPending({
      conversationId,
      tool: "shell",
      permissionKind: "shell",
      scopeKey: `cmd-${label}`,
      argsHash: null,
      adversaryModel: "reviewer-model",
      experimentKey,
      promptVersion: 1,
      factsKey: `facts-${label}`,
      resolutionSource,
    });
  };

  return { dataDir, repo, insert };
}

function runReport(dataDir: string): Record<string, unknown> {
  const out = execFileSync(
    process.execPath,
    [scriptPath, "--data-dir", dataDir, "--json"],
    {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    },
  );
  return JSON.parse(out);
}

describe("adversary shadow report script", () => {
  beforeEach(() => {
    // The report reads the database directly and never consults the shadow's
    // runtime config, so there is nothing to reset — but the seeding helper
    // runs migrations, so keep the env clean of a stray reviewer model that
    // could make a stale process-cached config leak between files.
    delete process.env.ADVERSARY_SHADOW_BACKEND;
  });

  it("reads every column it uses, including the ones only the skip logic needs", async () => {
    const { dataDir, repo, insert } = await seed();

    // A scored true positive.
    const tp = insert("prompt-policy");
    repo.recordVerdict(tp, "deny", "dangerous", {
      denyProbability: 0.9,
      latencyMs: 120,
    });
    repo.recordHumanDecision(tp, "deny");

    // A scored true negative.
    const tn = insert("prompt-policy");
    repo.recordVerdict(tn, "allow", "fine", {
      denyProbability: 0.1,
      latencyMs: 80,
    });
    repo.recordHumanDecision(tn, "allow-once");

    // Nobody was asked: unlabellable by design, out of the coverage denominator.
    const auto = insert("auto-approve");
    repo.recordVerdict(auto, "allow", "fine", {
      denyProbability: 0.2,
      latencyMs: 100,
    });

    // Throttled: no call made, so no latency and a `skipped:` marker.
    const skipped = insert("prompt-policy");
    repo.recordError(skipped, "skipped: 4 adversary calls already in flight", {
      latencyMs: null,
    });

    const report = runReport(dataDir);
    const strata = report.strata as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const keys = Object.keys(strata);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("reviewer-model");

    const headline = strata[keys[0]!]!.headline!;
    expect(headline).toMatchObject({
      total: 4,
      scored: 2,
      truePositives: 1,
      trueNegatives: 1,
      unlabellableByDesign: 1,
      errors: 1,
    });
    // Coverage excludes the auto-approve row but not the skip: 2 scored of
    // 3 labellable.
    expect(headline.coverage).toBeCloseTo(2 / 3);

    // The regression this test exists for: the skip must be visible.
    expect(report.skippedByConcurrencyCap).toBe(1);

    // And must not enter the latency sample.
    const latency = report.latencyMs as Record<string, Record<string, number>>;
    expect(latency.adversary!.count).toBe(3);

    // Per-resolution-source breakdown is populated (needs `resolution_source`).
    expect(Object.keys(strata[keys[0]!]!.byResolutionSource!)).toEqual(
      expect.arrayContaining(["prompt-policy", "auto-approve"]),
    );
  });

  it("never pools rows from different experiments", async () => {
    const { dataDir, repo, insert } = await seed();
    const a = insert("prompt-policy", "exp-a");
    repo.recordVerdict(a, "deny", "x", { latencyMs: 10 });
    repo.recordHumanDecision(a, "deny");
    const b = insert("prompt-policy", "exp-b");
    repo.recordVerdict(b, "allow", "x", { latencyMs: 10 });
    repo.recordHumanDecision(b, "allow-once");

    const report = runReport(dataDir);
    expect(Object.keys(report.strata as object)).toHaveLength(2);
  });

  it("exits cleanly on an empty table", async () => {
    const { dataDir } = await seed();
    const report = runReport(dataDir);
    expect(report.strata).toEqual({});
    expect(report.skippedByConcurrencyCap).toBe(0);
  });
});
