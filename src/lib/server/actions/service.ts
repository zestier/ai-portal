// Glue between validated `.zap/actions.json` action definitions and the
// generic runner: turns a declarative action into concrete runner `Step`s and
// owns the per-action-per-conversation in-flight guard.

import { buildActionEnv, type Step } from './runner';
import type { ActionDef } from './config';
import { substituteArg } from './inputs';

/**
 * Lower a validated action definition into runner steps bound to a specific
 * conversation workdir. Project actions are clamped to:
 *  - cwd = the conversation workdir (never the portal source tree),
 *  - default-deny env (`inheritEnv: false`) built from a safe base plus the
 *    action's explicit env-name allowlist,
 *  - `shell: false` (inherited from the runner).
 *
 * `values` holds already-validated typed input values (see resolveInputValues);
 * each `{{NAME}}` token in a step's args is substituted with its value. Commands
 * are never substituted. Pass `{}` (the default) for an action with no inputs.
 */
export function actionToSteps(
	action: ActionDef,
	workdir: string,
	values: Record<string, string> = {}
): Step[] {
	const env = buildActionEnv(action.env);
	return action.steps.map((step) => {
		const args = step.args.map((arg) => substituteArg(arg, values));
		return {
			label: step.label ?? step.command,
			command: step.command,
			args,
			display: [step.command, ...args].join(' '),
			cwd: workdir,
			env,
			inheritEnv: false
		};
	});
}

// Per-(conversation, action) in-flight guard. A given action can run in
// parallel across different conversations, but a second run of the SAME action
// in the SAME conversation is rejected (409) until the first finishes. Replaces
// redeploy's single global flag.
const inFlight = new Set<string>();

function key(conversationId: string, actionId: string): string {
	return `${conversationId}\u0000${actionId}`;
}

/** Claim the guard. Returns false if a run is already in flight. */
export function claimActionRun(conversationId: string, actionId: string): boolean {
	const k = key(conversationId, actionId);
	if (inFlight.has(k)) return false;
	inFlight.add(k);
	return true;
}

export function releaseActionRun(conversationId: string, actionId: string): void {
	inFlight.delete(key(conversationId, actionId));
}

/** Test-only: whether a run is currently registered as in-flight. */
export function isActionRunInFlight(conversationId: string, actionId: string): boolean {
	return inFlight.has(key(conversationId, actionId));
}
