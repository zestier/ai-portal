// Built-in "redeploy" action: pull + rebuild + restart the portal itself.
//
// This is now a thin built-in on top of the generic runner (see
// ./actions/runner.ts). It is the one privileged action that carries the
// rollover semantic — a successful build schedules `process.exit(0)` so the
// `pnpm serve` supervisor relaunches on refreshed code. That capability is
// reserved to built-ins and is NOT expressible from `.zap/actions.toml`.
//
// The redeploy steps deliberately keep the runner's default env behavior
// (`inheritEnv` defaulting to true => full `process.env` spread) and default
// cwd (`process.cwd()` = the portal source tree). User-defined project actions
// get the opposite: default-deny env and a conversation-scoped cwd.

import type { AppConfig } from "./config";
import type { User } from "$lib/types";
import {
  buildActionEnv,
  runSequence,
  runStep,
  scrubLog,
  type ActionEvent,
  type Step,
} from "./actions/runner";

// Re-exported under their historical names so existing imports/tests keep
// working while the implementation lives in the generic runner.
export type { Step };
export type RedeployEvent = ActionEvent;
export { runStep, buildActionEnv };
export const scrubRedeployLog = scrubLog;

export const PULL_STEPS: Step[] = [
  {
    label: "git fetch",
    command: "git",
    args: ["fetch", "--all", "--prune"],
    display: "git fetch --all --prune",
  },
  {
    label: "git pull",
    command: "git",
    args: ["pull", "--ff-only"],
    display: "git pull --ff-only",
  },
  {
    label: "pnpm install",
    command: "pnpm",
    args: ["install", "--frozen-lockfile"],
    display: "pnpm install --frozen-lockfile",
  },
];

export const BUILD_STEPS: Step[] = [
  {
    label: "pnpm run verify",
    command: "pnpm",
    args: ["run", "verify"],
    display: "pnpm run verify",
    // Run the full gate — including Playwright e2e — as a deliberate safety
    // net so a broken build never rolls over onto the live server. The live
    // portal is still serving while this runs, so E2E_ISOLATED makes
    // playwright.config.ts refuse to reuse/attach to the running server and
    // instead spin up its own throwaway server + DB, so the gate can't drive
    // or corrupt live state.
    env: { E2E_ISOLATED: "1" },
  },
];

export function canRedeployUser(user: User | null, cfg: AppConfig): boolean {
  // Single trusted local user — there's no admin allow-list to consult.
  // `cfg` is retained for call-site compatibility (previously it named the
  // GitHub admin allow-list).
  void cfg;
  return !!user;
}

/**
 * Run the redeploy sequence: the privileged built-in carries `rollover: true`,
 * so a fully-successful build exits the process for the supervisor to relaunch.
 */
export function runRedeploy(
  steps: Step[],
  runner?: (step: Step, emit: (ev: RedeployEvent) => void) => Promise<number>,
): AsyncGenerator<RedeployEvent> {
  return runSequence(steps, {
    rollover: true,
    logLabel: "redeploy",
    ...(runner ? { runner } : {}),
  });
}
