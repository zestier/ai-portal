import { z } from 'zod';
import type {
	InteractiveRequestView,
	InteractiveResponse,
	PermissionPolicy,
	PortalEvent
} from '$lib/types';
import { FORCE_RETRY_TOOL_NAME } from '../self-interactive';
import {
	approveForcedRetry,
	getForcedRetry,
	revokeForcedRetry,
	takeForcedRetry
} from '../../runtime/forced-retry';
import {
	isInteractivePromptCancelledError,
	newRequestId,
	register as registerInteractive
} from '../../runtime/interactive-requests';
import { err, ok, type PortalTool } from '../types';

const FORCE_RETRY_REASON_MIN = 20;

export const ForceRetryArgs = z
	.object({
		token: z.string().trim().min(1).max(128),
		reason: z
			.string()
			.trim()
			.min(
				FORCE_RETRY_REASON_MIN,
				`reason must be at least ${FORCE_RETRY_REASON_MIN} characters explaining why this one-off escalation is needed`
			)
			.max(500, 'reason must be at most 500 characters')
	})
	.superRefine((val, ctx) => {
		// `token` must look like a portal-minted one-shot token. The check is
		// loose (24 hex chars) — anything else is still rejected later with a
		// precise error from `getForcedRetry`.
		if (!/^[0-9a-f]{24}$/.test(val.token)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['token'],
				message: 'token must be the 24-hex-character token from the denial feedback'
			});
		}
	});

export interface ForceRetryToolOpts {
	conversationId: number;
	policy: PermissionPolicy;
	emit: (ev: PortalEvent) => void;
	resolvePortalTool?: (name: string) => PortalTool | null;
}

// Build the `force_retry_tool` tool. The tool call itself is `never-prompt`
// (auto-allowed): it has no effect of its own, so there is nothing to gate at
// the call site. Its handler looks up the one-shot token that the interactive
// adapter minted when the exact call was denied (see runtime/forced-retry.ts)
// and raises a fresh approve-once human dialog showing the originally captured
// tool + args. Approving executes the DENIED call for portal-owned tools (the
// resolver finds the portal tool, the captured args run verbatim through its
// handler, and the underlying ToolResult is returned — no re-issue needed) and
// otherwise marks the token approved so a matching retry is auto-allowed by
// `consumeForcedRetryMatch` and the SDK executes it natively. The token is
// one-shot in both paths, so a further request is denied again.
export function buildForceRetryTool(opts: ForceRetryToolOpts): PortalTool {
	return {
		name: FORCE_RETRY_TOOL_NAME,
		description: 'Escalate ONE previously denied tool call to a fresh human approval prompt.',
		promptGuidelines: [
			'Pass the one-shot token from the denial feedback plus a concise reason.',
			'If the human approves, the exact denied call (portal-owned tools) executes immediately with the originally captured args; other tools require retrying the same call (same command/path/url), which is then auto-allowed. Either way it executes exactly once — it saves nothing.',
			'Default way to override a denial; use `request_permission_grant` only for a durable, saved rule.'
		],
		argsSchema: ForceRetryArgs,
		permissionBehavior: 'never-prompt',
		parameters: {
			type: 'object',
			properties: {
				token: {
					type: 'string',
					description: 'One-shot token from the denial.'
				},
				reason: {
					type: 'string',
					description: 'Justification (>=20 chars).'
				}
			},
			required: ['token', 'reason'],
			additionalProperties: false
		},
		async handler(args, ctx) {
			const parsed = ForceRetryArgs.parse(args);
			const entry = getForcedRetry(parsed.token);
			if (!entry) {
				return err(
					'Unknown or expired forced-retry token. Every denial mints a fresh one-shot token embedded in its feedback; re-run the call and use the token from the new denial. Tokens expire after 15 minutes.',
					{ code: 'force_retry_invalid_token' }
				);
			}
			if (entry.conversationId !== opts.conversationId) {
				return err('This token belongs to another conversation.', {
					code: 'force_retry_wrong_conversation'
				});
			}
			if (entry.status !== 'pending') {
				return err('This forced-retry token has already been resolved.', {
					code: 'force_retry_resolved'
				});
			}

			const requestId = newRequestId();
			const view: InteractiveRequestView = {
				requestId,
				kind: 'permission',
				tool: entry.tool,
				permissionKind: entry.permissionKind,
				summary: entry.summary,
				args: entry.args,
				userPolicy: opts.policy,
				canPersistDecision: false,
				escalationReason: parsed.reason,
				...(entry.deniedFeedback !== null ? { defaultDenyFeedback: entry.deniedFeedback } : {})
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
					revokeForcedRetry(parsed.token);
					return err(
						'The forced-retry prompt was dismissed before the human decided (turn aborted, timed out, or disconnected). This is NOT a denial — the token is revoked, so re-issue the original call and the fresh denial will carry a new token.',
						{ code: 'force_retry_cancelled' }
					);
				}
				throw e;
			}

			if (response.kind !== 'permission') {
				return err('Unexpected response to forced-retry prompt.');
			}

			if (response.decision === 'allow-once' || response.decision === 'allow-always') {
				// Portal-owned tools execute DIRECTLY on approval: the captured
				// args run verbatim through the tool's handler (exactly what the
				// human saw and approved — more faithful than a re-issued call
				// whose incidental args could have drifted), and the underlying
				// ToolResult envelope is returned. The token is consumed atomically
				// (`takeForcedRetry`) so a concurrent escalation of the same token
				// cannot also execute, and a re-issued call after this cannot
				// double-run — it is simply denied fresh.
				const portalTool = opts.resolvePortalTool ? opts.resolvePortalTool(entry.tool) : null;
				if (portalTool) {
					if (entry.args === null) {
						// Nothing to execute — the denied request carried no captured
						// args. Error explicitly rather than approve-then-retry: a
						// custom-tool re-issue could never match an args-less entry,
						// which would loop. Revoke so the approval cannot be replayed.
						revokeForcedRetry(parsed.token);
						return err(
							'The denied request carried no captured arguments, so the approved call cannot be executed directly. Re-issue the original tool call; its fresh denial will mint a new token.',
							{ code: 'force_retry_missing_args' }
						);
					}
					const taken = takeForcedRetry(parsed.token);
					if (!taken) {
						return err('This forced-retry token has already been resolved.', {
							code: 'force_retry_resolved'
						});
					}
					try {
						return await portalTool.handler(entry.args, ctx);
					} catch (e) {
						return err(e instanceof Error ? e.message : String(e));
					}
				}

				// Unresolvable (SDK-native) tool: keep the approve-then-retry flow.
				// `approveForcedRetry` only records while the token is still
				// `pending`; a concurrent escalation of the same token (or a
				// pruned entry) can make it false, and reporting success then
				// would be a lie — the retry would still be denied.
				const approved = approveForcedRetry(parsed.token, parsed.reason);
				if (!approved) {
					return err('This forced-retry token has already been resolved.', {
						code: 'force_retry_resolved'
					});
				}
				return ok(
					{ approved: true },
					'The human approved this one-off escalation. Retry the same tool call you were denied on (same command/path/url; incidental args may differ) — it will now be auto-allowed and execute.'
				);
			}

			// Denied, deny-always, or the dialog was otherwise resolved without
			// approval. The token is revoked so it cannot be replayed.
			revokeForcedRetry(parsed.token);
			const feedback = typeof response.feedback === 'string' ? response.feedback.trim() : '';
			return err(
				(feedback
					? `The human declined to override the denial: ${feedback}`
					: 'The human declined to override the denial.') +
					' The forced-retry token is now revoked; the original call remains denied.',
				{ code: 'force_retry_denied' }
			);
		}
	};
}
