import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { requireUserId } from '$lib/server/auth/require';
import { authorizeConversationWorkdir } from '$lib/server/conversation-auth';
import { loadConfig } from '$lib/server/config';
import { canRedeployUser } from '$lib/server/redeploy';
import { log } from '$lib/server/log';
import { audit } from '$lib/server/audit';
import { sseResponse } from '$lib/server/sse';
import { runSequence } from '$lib/server/actions/runner';
import { loadActionsConfig } from '$lib/server/actions/config';
import { actionToSteps, claimActionRun, releaseActionRun } from '$lib/server/actions/service';
import { resolveInputValues } from '$lib/server/actions/inputs';

// Raw input values supplied with the run. Names/coercion are validated against
// the action's declared `inputs` by resolveInputValues; this only bounds the
// wire shape (a flat map of scalars).
const Body = z
	.object({
		inputs: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
	})
	.strict();

/**
 * Run a single project action defined in the conversation's
 * `.zap/actions.json`, streaming its stdout/stderr back as SSE just like the
 * built-in redeploy. Gating:
 *  - conversation-auth (the caller must own the conversation),
 *  - `permission: admin` actions additionally require redeploy-admin rights,
 *  - a per-action-per-conversation in-flight guard (409 on a concurrent run).
 *
 * The child is bound to the request: `request.signal` aborts on client
 * disconnect, killing any running step so an action does not outlive the press.
 */
export const POST: RequestHandler = async ({ params, locals, request, getClientAddress }) => {
	const userId = requireUserId(locals);
	const { conversation, workdir } = authorizeConversationWorkdir(params.id, locals.userId);
	const actionId = params.actionId;
	const cfg = loadConfig();
	const actorLogin = locals.user?.githubLogin ?? null;
	const actorIp = getClientAddress();
	const resource = `conversations/${conversation.id}/actions/${actionId}`;

	const denied = (reason: string, detail?: Record<string, unknown>) => {
		audit({
			event_type: 'action_run',
			actor_login: actorLogin,
			actor_ip: actorIp,
			resource,
			outcome: 'denied',
			detail: { actionId, reason, ...detail }
		});
		log.warn('action.denied', { userId, actionId, reason });
	};

	const result = await loadActionsConfig(workdir);
	if (!result.ok) {
		denied('config_invalid');
		throw error(400, result.error);
	}
	const action = result.actions.find((a) => a.id === actionId);
	if (!action) {
		denied('not_found');
		throw error(404, `No action "${actionId}" defined for this conversation.`);
	}
	if (action.permission === 'admin' && !canRedeployUser(locals.user, cfg)) {
		denied('not_admin', { permission: action.permission });
		throw error(403, 'This action requires an authorized admin.');
	}

	// Resolve typed inputs (Phase 2) before claiming the run guard so a bad
	// request neither holds the guard nor starts a child. An action with no
	// declared inputs accepts an empty body and resolves to `{}`.
	let rawInputs: Record<string, unknown> = {};
	const bodyText = await request.text();
	if (bodyText) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(bodyText);
		} catch {
			denied('bad_body');
			throw error(400, 'Invalid JSON body.');
		}
		const body = Body.safeParse(parsed);
		if (!body.success) {
			denied('bad_body');
			throw error(400, body.error.issues[0]?.message ?? 'Invalid request body.');
		}
		rawInputs = body.data.inputs ?? {};
	}
	const resolved = resolveInputValues(action.inputs, rawInputs);
	if (!resolved.ok) {
		denied('invalid_inputs', { error: resolved.error });
		throw error(400, resolved.error);
	}

	if (!claimActionRun(conversation.id, actionId)) {
		// Distinct from the gating denials above — this is a benign concurrency
		// collision, not an authz failure, so don't write a `denied` audit row.
		throw error(409, 'This action is already running for this conversation.');
	}

	try {
		const steps = actionToSteps(action, workdir, resolved.values);
		log.info('action.start', { userId, conversationId: conversation.id, actionId });
		audit({
			event_type: 'action_run',
			actor_login: actorLogin,
			actor_ip: actorIp,
			resource,
			outcome: 'success',
			detail: { actionId, permission: action.permission, steps: steps.length }
		});

		async function* withGuardRelease() {
			try {
				// rollover stays false: the restart capability is reserved to the
				// built-in redeploy and is not reachable from project config.
				yield* runSequence(steps, {
					rollover: false,
					signal: request.signal,
					logLabel: `action.${actionId}`
				});
			} finally {
				releaseActionRun(conversation.id, actionId);
			}
		}

		return sseResponse(withGuardRelease());
	} catch (err) {
		// Release the guard if anything throws before the generator starts
		// iterating, otherwise the flag would stick until restart.
		releaseActionRun(conversation.id, actionId);
		throw err;
	}
};
