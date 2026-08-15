import { z } from 'zod';
import type {
	InteractiveRequestView,
	InteractiveResponse,
	PermissionPolicy,
	PortalEvent
} from '$lib/types';
import { GRANT_TOOLS, grantToolLabel, permissionKindForTool } from '$lib/permissions/metadata';
import { capabilityScopeSummary, describeGrantScope } from '$lib/permissions/scope-summary';
import { GrantScopeSchema, refineScopeToolAlignment } from '$lib/permissions/scope-schema';
import { GRANT_REQUEST_TOOL_NAME } from '../self-interactive';
import {
	isInteractivePromptCancelledError,
	newRequestId,
	register as registerInteractive
} from '../../runtime/interactive-requests';
import { err, ok, type PortalTool } from '../types';

const GRANT_REQUEST_REASON_MIN = 20;

// Appended to the grant-request response on denied / cancelled / allow-once
// outcomes (NOT on a successful allow-always save). These outcomes signal the
// grant may have been the wrong tool for a one-off need; remind the agent that
// in-the-moment unblocks should use `force_retry_tool` instead.
export const GRANT_REQUEST_NUDGE =
	'If this was a one-off unblock, call `force_retry_tool` with the token from the denial instead; `request_permission_grant` is only for durable, saved rules.';

export const GrantRequestArgs = z
	.object({
		tool: z.enum(GRANT_TOOLS),
		reason: z
			.string()
			.trim()
			.min(
				GRANT_REQUEST_REASON_MIN,
				`reason must be at least ${GRANT_REQUEST_REASON_MIN} characters explaining why this grant is needed`
			)
			.max(500, 'reason must be at most 500 characters'),
		scope: GrantScopeSchema
	})
	.superRefine(refineScopeToolAlignment);

export interface GrantRequestToolOpts {
	userId: number;
	conversationId: number;
	policy: PermissionPolicy;
	emit: (ev: PortalEvent) => void;
}

// Build the `request_permission_grant` tool. The tool call itself is
// `never-prompt` (auto-allowed): it has no effect of its own, so there is
// nothing to gate at the call site. Its handler ALWAYS raises a human
// permission dialog and only persists a grant if the human approves it —
// there is no code path that records a grant without a human decision, so it
// behaves like a forced prompt even under `allow-all` / session approve-all.
export function buildGrantRequestTool(opts: GrantRequestToolOpts): PortalTool {
	return {
		name: GRANT_REQUEST_TOOL_NAME,
		description:
			'Ask the human to save a PERMANENT permission grant pre-approving all future matching calls.',
		promptGuidelines: [
			"ONLY when there is explicit persistence intent — a durable, saved rule. For a one-off unblock call `force_retry_tool` with the denial's token instead.",
			'Request the NARROWEST scope that covers the need.',
			'ALWAYS opens a human dialog and is never auto-approved, even with approvals bypassed.'
		],
		argsSchema: GrantRequestArgs,
		permissionBehavior: 'never-prompt',
		parameters: {
			type: 'object',
			properties: {
				tool: {
					type: 'string',
					enum: [...GRANT_TOOLS],
					description: 'Permission kind.'
				},
				reason: {
					type: 'string',
					description: 'Justification (>=20 chars).'
				},
				scope: {
					type: 'object',
					description: 'Grant scope; `kind` must match the tool.',
					additionalProperties: true
				}
			},
			required: ['tool', 'scope', 'reason'],
			additionalProperties: false
		},
		async handler(args) {
			const parsed = GrantRequestArgs.parse(args);
			// This tool is the structured analogue of `force_retry_tool`: it
			// ALWAYS raises a human dialog regardless of the conversation's
			// approval mode. Like a forced retry (see runtime/forced-retry.ts),
			// it must still reach a human under
			// `auto-deny` — that mode only changes the *automatic* policy
			// default, it does not disable the dialog UI. The prompt waits
			// until the human answers or the turn aborts (handled below as a
			// non-denying cancellation).

			const permissionKind = permissionKindForTool(parsed.tool);
			const scopeSummary = capabilityScopeSummary(parsed.scope);
			const requestId = newRequestId();
			const view: InteractiveRequestView = {
				requestId,
				kind: 'permission',
				tool: parsed.tool,
				permissionKind,
				summary: `Grant request: ${grantToolLabel(parsed.tool)} — ${scopeSummary}`,
				args: { reason: parsed.reason, scope: parsed.scope },
				userPolicy: opts.policy,
				canPersistDecision: true,
				grantRequest: { reason: parsed.reason, scope: parsed.scope, permissionKind }
			};

			let response: InteractiveResponse;
			try {
				response = await new Promise<InteractiveResponse>((resolve, reject) => {
					registerInteractive({
						requestId,
						conversationId: opts.conversationId,
						kind: 'permission',
						view,
						resolve,
						reject,
						emit: opts.emit
					});
					opts.emit({ type: 'interactive.request', request: view });
				});
			} catch (e) {
				if (isInteractivePromptCancelledError(e)) {
					return err(
						'The permission grant request was dismissed before the human decided (turn aborted, timed out, or disconnected). This is not a denial — re-issue it if the grant is still needed. ' +
							GRANT_REQUEST_NUDGE,
						{ code: 'grant_request_cancelled' }
					);
				}
				throw e;
			}

			if (response.kind !== 'permission') {
				return err('Unexpected response to permission grant request.');
			}

			// On `allow-always` the interactive registry persists the grant from
			// the scope the dialog emits (see runtime/interactive-requests.ts).
			// The human may have narrowed the proposed scope in the dialog, so
			// report what was ACTUALLY persisted (`response.scope`), not the
			// agent's original proposal — otherwise the agent would believe it
			// holds a broader grant than it does.
			if (response.decision === 'allow-always') {
				const savedScope = response.scope?.scope ?? parsed.scope;
				const savedSummary = capabilityScopeSummary(savedScope);
				return ok(
					{
						saved: true,
						tool: parsed.tool,
						scope: savedScope,
						scopeDescription: describeGrantScope({
							scope: savedScope,
							scopePattern: response.scope?.pattern ?? null
						}),
						appliesTo: response.applyToAllConversations ? 'all-conversations' : 'this-conversation',
						expiresInMs: response.expiresInMs ?? null
					},
					`Saved a permanent ${parsed.tool} grant: ${savedSummary}. Matching tool calls are now pre-approved.`
				);
			}

			// `allow-once` approves the request but saves nothing (the dialog
			// normally only offers save/deny, but handle it defensively).
			if (response.decision === 'allow-once') {
				return ok(
					{ saved: false, tool: parsed.tool },
					'The human approved this request but chose not to save a permanent grant; the matching tool calls will still prompt. ' +
						GRANT_REQUEST_NUDGE
				);
			}

			const feedback = typeof response.feedback === 'string' ? response.feedback.trim() : '';
			return err(
				(feedback
					? `The human declined to save this grant: ${feedback}`
					: 'The human declined to save this permission grant.') +
					' ' +
					GRANT_REQUEST_NUDGE,
				{ code: 'grant_request_denied' }
			);
		}
	};
}
