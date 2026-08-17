#!/usr/bin/env node
// Adversarial approval mode — Phase 0 readout.
//
// Prints the comparison between what the shadow adversary *would* have decided
// and what the human actually clicked, for permission requests that reached a
// dialog in `ask` conversations.
//
// Three things this report is careful about, because each of them can turn a
// real finding into a comfortable lie:
//
//  1. The headline is adversary-deny **precision and recall**, not agreement.
//     Human denials are rare, so an adversary that approves everything scores
//     high agreement while catching nothing. The "always allow" baseline is
//     printed next to agreement so that trap is visible rather than implied.
//  2. Results are **stratified by experiment key** — a hash over the system
//     prompt, renderer version, truncation budget, backend label and model.
//     Rows collected under different setups are different experiments; pooling
//     them averages away the thing you changed.
//  3. **Memoized rows are excluded** from the headline, which makes its
//     estimand "per unique question asked". The event-weighted view (per
//     permission event, which is what a deployed product gates) is printed
//     separately rather than silently substituted.
//
// And what it cannot fix: the human's click is a *label*, not ground truth.
// These are agreement-with-the-human metrics. Human recall is 1 by
// construction, so this cannot show the adversary "beating" the human — a low
// number is decisive against the mode, a high number is necessary but not
// sufficient for it. A rubber-stamped approval makes a correct denial look like
// a false positive; median human answer latency is printed as a weak proxy.
//
// Usage:
//   pnpm run report:adversary-shadow
//   pnpm run report:adversary-shadow --data-dir ./data --json
//   pnpm run report:adversary-shadow --since 2026-01-01
//
// Read-only: it opens portal.db, runs SELECTs, and exits.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { scoreShadowDecisions } from "../src/lib/server/permissions/adversary/scoring.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {
    dataDir: process.env.DATA_DIR ?? join(repoRoot, "data"),
    json: false,
    since: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--data-dir") out.dataDir = argv[++i];
    else if (arg === "--since") out.since = Date.parse(argv[++i]);
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.since !== null && Number.isNaN(out.since)) {
    throw new Error("--since must be a parseable date");
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    "usage: adversary-shadow-report.mjs [--data-dir <dir>] [--since <date>] [--json]",
  );
  process.exit(0);
}

const dbPath = join(resolve(args.dataDir), "portal.db");
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const tableExists = db
  .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
  .get("permission_shadow_decisions");
if (!tableExists) {
  console.error(
    "permission_shadow_decisions does not exist — run the app once to migrate.",
  );
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT tool, permission_kind, adversary_model, experiment_key, prompt_version,
		        resolution_source, status, verdict, deny_probability, rationale, error,
		        human_decision, human_decided_at, latency_ms, memoized, created_at
		   FROM permission_shadow_decisions
		  WHERE created_at >= ?
		  ORDER BY created_at ASC`,
  )
  .all(args.since ?? 0)
  .map((r) => ({
    ...r,
    humanDecision: r.human_decision,
    memoized: r.memoized === 1,
    resolutionSource: r.resolution_source,
  }));

function groupBy(items, keyOf) {
  const out = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = out.get(key) ?? [];
    bucket.push(item);
    out.set(key, bucket);
  }
  return out;
}

// Stratified by experiment key — a hash over the system prompt, renderer
// version, truncation budget, backend label and model. The backend column was
// dropped (migration 072); the label now lives inside the key, so rows served
// by different backends still cannot pool. Rows written before the backend
// became explicit have a NULL key and read as one legacy stratum.
const strata = groupBy(
  rows,
  (r) => `${r.adversary_model} [exp ${r.experiment_key ?? "pre-069"}]`,
);

/**
 * How often the model actually supplied a deny probability. A collection of
 * nulls means the promised precision/recall curve does not exist — better to
 * find that out here than at analysis time.
 */
function denyProbabilityCoverage(subset) {
  const verdicts = subset.filter((r) => r.status === "verdict" && !r.memoized);
  if (verdicts.length === 0) return null;
  return (
    verdicts.filter((r) => typeof r.deny_probability === "number").length /
    verdicts.length
  );
}

// Human answer latency, non-memoized labelled rows only. A cluster of
// sub-second answers is the signature of rubber-stamping, which would make the
// "human deny" label unreliable in the direction that flatters the human.
const humanLatencies = rows
  .filter((r) => r.human_decided_at !== null && !r.memoized)
  .map((r) => r.human_decided_at - r.created_at)
  .sort((a, b) => a - b);
// Skipped rows (the concurrency cap bit) made no call at all and are stored
// with a NULL latency, so the type check keeps them out. Filtering on the
// prefix as well means an older row written before that was true cannot creep
// in and make the adversary look fastest exactly when it was being throttled.
const isSkip = (r) =>
  typeof r.error === "string" && r.error.startsWith("skipped: ");
const adversaryLatencies = rows
  .filter((r) => !r.memoized && typeof r.latency_ms === "number" && !isSkip(r))
  .map((r) => r.latency_ms)
  .sort((a, b) => a - b);
const skipCount = rows.filter(isSkip).length;

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

if (args.json) {
  console.log(
    JSON.stringify(
      {
        strata: Object.fromEntries(
          [...strata].map(([key, subset]) => [
            key,
            {
              headline: scoreShadowDecisions(subset),
              eventWeighted: scoreShadowDecisions(subset, {
                includeMemoized: true,
              }),
              denyProbabilityCoverage: denyProbabilityCoverage(subset),
              byTool: Object.fromEntries(
                [...groupBy(subset, (r) => r.tool)].map(([k, v]) => [
                  k,
                  scoreShadowDecisions(v),
                ]),
              ),
              byResolutionSource: Object.fromEntries(
                [
                  ...groupBy(subset, (r) => r.resolution_source ?? "unknown"),
                ].map(([k, v]) => [k, scoreShadowDecisions(v)]),
              ),
            },
          ]),
        ),
        latencyMs: {
          adversary: {
            count: adversaryLatencies.length,
            p50: percentile(adversaryLatencies, 0.5),
            p95: percentile(adversaryLatencies, 0.95),
          },
          humanAnswer: {
            count: humanLatencies.length,
            p50: percentile(humanLatencies, 0.5),
            p95: percentile(humanLatencies, 0.95),
          },
        },
        skippedByConcurrencyCap: skipCount,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const pct = (v) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);

console.log(
  "Adversary shadow-mode report (Phase 0 — the adversary had no authority)",
);
if (strata.size > 1) {
  console.log("");
  console.log(
    `  NOTE: ${strata.size} experiment strata present (model x prompt x truncation).`,
  );
  console.log(
    "        They are separate experiments and are NOT pooled below.",
  );
}

for (const [key, subset] of strata) {
  const score = scoreShadowDecisions(subset);
  const eventWeighted = scoreShadowDecisions(subset, { includeMemoized: true });
  const autoApproved = subset.filter(
    (r) => r.resolution_source === "auto-approve",
  ).length;
  console.log("");
  console.log(`== ${key}`);
  console.log(`  shadow rows                ${score.total}`);
  console.log(
    `  scored (verdict + human)   ${score.scored}   coverage ${pct(score.coverage)} of labellable`,
  );
  console.log(`  excluded, prompt abandoned ${score.excludedNoHumanLabel}`);
  console.log(
    `  excluded, never asked      ${score.unlabellableByDesign}   (auto-approve rows seen: ${autoApproved})`,
  );
  console.log(`  excluded, memoized replay  ${score.memoizedDuplicates}`);
  console.log(`  adversary errors           ${score.errors}`);
  console.log(`  never settled (pending)    ${score.pending}`);
  console.log(
    `  deny-probability present   ${pct(denyProbabilityCoverage(subset))}  <- a curve needs this to be high`,
  );
  console.log("");
  console.log(
    "  Adversary DENY vs human deny (agreement with the human, per unique question):",
  );
  console.log(
    `    precision                ${pct(score.denyPrecision)}   (TP ${score.truePositives} / TP+FP ${score.truePositives + score.falsePositives})`,
  );
  console.log(
    `    recall                   ${pct(score.denyRecall)}   (TP ${score.truePositives} / TP+FN ${score.truePositives + score.falseNegatives})`,
  );
  console.log(`    F1                       ${pct(score.denyF1)}`);
  console.log(`    missed human denies      ${score.falseNegatives}`);
  console.log("");
  console.log(`  agreement                  ${pct(score.agreement)}`);
  console.log(`  human deny base rate       ${pct(score.humanDenyRate)}`);
  console.log(
    `  "always allow" baseline    ${pct(score.humanDenyRate === null ? null : 1 - score.humanDenyRate)}  <- agreement must beat this to mean anything`,
  );
  if (eventWeighted.scored !== score.scored) {
    console.log(
      `  event-weighted recall      ${pct(eventWeighted.denyRecall)}  (${eventWeighted.scored} rows incl. memoized replays — per permission event, not per unique question)`,
    );
  }

  const bySource = groupBy(subset, (r) => r.resolution_source ?? "unknown");
  console.log("");
  console.log("  By why the request needed a decision (scored / deny-recall):");
  for (const [source, sourceRows] of bySource) {
    const s = scoreShadowDecisions(sourceRows);
    console.log(
      `    ${source.padEnd(28)} ${String(s.scored).padStart(5)}   ${pct(s.denyRecall)}${
        source === "auto-approve"
          ? "   (unlabelled by construction; for later adjudication)"
          : ""
      }`,
    );
  }

  console.log("");
  console.log("  By tool (scored / deny-recall):");
  for (const [tool, toolRows] of [...groupBy(subset, (r) => r.tool)].sort(
    (a, b) => b[1].length - a[1].length,
  )) {
    const s = scoreShadowDecisions(toolRows);
    console.log(
      `    ${tool.padEnd(28)} ${String(s.scored).padStart(5)}   ${pct(s.denyRecall)}`,
    );
  }
}

console.log("");
if (skipCount > 0) {
  console.log(
    `  skipped (concurrency cap)  ${skipCount}  <- a non-random hole: skips land on the busiest moments`,
  );
}
if (adversaryLatencies.length > 0) {
  console.log(
    `  adversary latency          p50 ${percentile(adversaryLatencies, 0.5)}ms  p95 ${percentile(adversaryLatencies, 0.95)}ms  (${adversaryLatencies.length} calls, skips excluded)`,
  );
}
if (humanLatencies.length > 0) {
  console.log(
    `  human answer latency       p50 ${percentile(humanLatencies, 0.5)}ms  p95 ${percentile(humanLatencies, 0.95)}ms  (${humanLatencies.length} answers)`,
  );
  console.log(
    "  A low human p50 suggests rubber-stamping, which makes the human label — and",
  );
  console.log(
    "  therefore every precision number above — unreliable in the human\u2019s favour.",
  );
}
console.log("");
console.log(
  "  Reminder: these are agreement-with-the-human metrics, not correctness — the",
);
console.log(
  "  human defines the labels, so human recall is 1 by construction and this cannot",
);
console.log(
  "  show the adversary beating a human. `auto-approve` rows carry no label at all;",
);
console.log(
  "  they are collected for later adjudication, because the requests cannot be",
);
console.log("  recovered after the fact.");
