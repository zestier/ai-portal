import { z } from 'zod';
import type {
	ApprovalMode,
	InteractiveRequestView,
	InteractiveResponse,
	PermissionPolicy,
	PortalEvent,
	SessionMode
} from '$lib/types';
import {
	GRANT_TOOLS,
	grantToolLabel,
	isFilesystemPermissionKind,
	permissionKindForTool
} from '$lib/permissions/metadata';
import {
	capabilityRuleKindForScope,
	capabilityScopeSummary,
	describeGrantScope
} from '$lib/permissions/scope-summary';
import { GrantScopeSchema, refineScopeToolAlignment } from '$lib/permissions/scope-schema';
import { FORCE_RETRY_TOOL_NAME, GRANT_REQUEST_TOOL_NAME } from './self-interactive';
import {
	approveForcedRetry,
	getForcedRetry,
	revokeForcedRetry,
	takeForcedRetry
} from '../runtime/forced-retry';
import {
	isInteractivePromptCancelledError,
	newRequestId,
	register as registerInteractive
} from '../runtime/interactive-requests';
import * as settings from '../db/repos/settings';
import { conversationId as convCodec } from '$lib/ids';
import { err, ok, type PortalTool } from './types';

const CAPABILITY_PERMISSION_KINDS = [...GRANT_TOOLS, 'custom-tool'] as const;
const PermissionKind = z.enum(CAPABILITY_PERMISSION_KINDS);

const CapabilitiesArgs = z
	.object({
		permissionKind: PermissionKind.optional(),
		toolName: z.string().trim().min(1).max(200).optional(),
		intent: z.string().trim().min(1).max(500).optional()
	})
	.optional()
	.default({});

type CapabilityStatus = 'allowed' | 'denied' | 'prompt_required' | 'partially_allowed';

interface CapabilityRule {
	kind: ReturnType<typeof capabilityRuleKindForScope> | 'policy';
	decision: 'allow' | 'force-allow' | 'deny' | 'prompt';
	scope: 'all-conversations' | 'current-conversation';
	summary: string;
}

interface Capability {
	permissionKind: string;
	status: CapabilityStatus;
	guidance: string;
	allowed?: CapabilityRule[];
	denied?: CapabilityRule[];
	promptRequired?: CapabilityRule[];
}

export function buildPermissionTools(opts: {
	userId: number;
	conversationId: number;
	policy: PermissionPolicy;
	getMode: () => SessionMode;
	getApprovalMode: () => ApprovalMode;
	/** Pushes an event into the active turn's stream. Required so the
	 * grant-request tool can raise a human permission dialog. */
	emit: (ev: PortalEvent) => void;
	/**
	 * Resolves a denied tool name (a portal tool name as the PreToolUse hook
	 * reports it — `bash`, `read`, `git_status`, …) to the portal tool
	 * whose handler owns the call. When it resolves, a `force_retry_tool`
	 * approval executes the originally captured tool + args directly and
	 * returns the underlying `ToolResult`, instead of marking the token
	 * approved for a re-issued call. Null for unresolvable tools keeps the
	 * approve-then-retry flow. Providers build it from their portal tool set;
	 * the catalog stub omits it (direct execution is a runtime concern).
	 */
	resolvePortalTool?: (name: string) => PortalTool | null;
}): PortalTool[] {
	return [
		{
			name: 'permission_capabilities',
			description: 'Read-only summary of allowed permission capabilities.',
			promptGuidelines: ['Use after a rejection to find allowed alternatives before escalating.'],
			argsSchema: CapabilitiesArgs,
			parameters: {
				type: 'object',
				properties: {
					permissionKind: {
						type: 'string',
						enum: PermissionKind.options,
						description: 'Optional permission kind.'
					},
					toolName: {
						type: 'string',
						description: 'Tool name to inspect.'
					},
					intent: {
						type: 'string',
						description: 'What you were trying to do.'
					}
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = CapabilitiesArgs.parse(args);
				return ok(
					permissionCapabilities({
						userId: opts.userId,
						conversationId: opts.conversationId,
						mode: opts.getMode(),
						approvalMode: opts.getApprovalMode(),
						policy: opts.policy,
						...(parsed.permissionKind !== undefined
							? { permissionKind: parsed.permissionKind }
							: {}),
						...(parsed.toolName !== undefined ? { toolName: parsed.toolName } : {}),
						...(parsed.intent !== undefined ? { intent: parsed.intent } : {})
					})
				);
			}
		},
		buildGrantRequestTool(opts),
		buildForceRetryTool(opts)
	];
}

const GRANT_REQUEST_REASON_MIN = 20;

// Appended to the grant-request response on denied / cancelled / allow-once
// outcomes (NOT on a successful allow-always save). These outcomes signal the
// grant may have been the wrong tool for a one-off need; remind the agent that
// in-the-moment unblocks should use `force_retry_tool` instead.
const GRANT_REQUEST_NUDGE =
	'If this was a one-off unblock, call `force_retry_tool` with the token from the denial instead; `request_permission_grant` is only for durable, saved rules.';

const GrantRequestArgs = z
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

// Build the `request_permission_grant` tool. The tool call itself is
// `never-prompt` (auto-allowed): it has no effect of its own, so there is
// nothing to gate at the call site. Its handler ALWAYS raises a human
// permission dialog and only persists a grant if the human approves it —
// there is no code path that records a grant without a human decision, so it
// behaves like a forced prompt even under `allow-all` / session approve-all.
function buildGrantRequestTool(opts: {
	userId: number;
	conversationId: number;
	policy: PermissionPolicy;
	emit: (ev: PortalEvent) => void;
}): PortalTool {
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

const FORCE_RETRY_REASON_MIN = 20;

const ForceRetryArgs = z
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
function buildForceRetryTool(opts: {
	conversationId: number;
	policy: PermissionPolicy;
	emit: (ev: PortalEvent) => void;
	resolvePortalTool?: (name: string) => PortalTool | null;
}): PortalTool {
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

function permissionCapabilities(opts: {
	userId: number;
	conversationId: number;
	mode: SessionMode;
	approvalMode: ApprovalMode;
	policy: PermissionPolicy;
	permissionKind?: string;
	toolName?: string;
	intent?: string;
}) {
	const grants = settings
		.listGrantsForUser(opts.userId)
		.filter(
			(g) => g.conversationId === null || convCodec.parse(g.conversationId) === opts.conversationId
		)
		.filter((g) => !g.expiresAt || g.expiresAt >= Date.now())
		.filter((g) => !opts.toolName || g.tool === opts.toolName || g.tool === '*')
		.filter((g) => !opts.permissionKind || grantCoversPermissionKind(g, opts.permissionKind));

	const kinds = opts.permissionKind
		? [opts.permissionKind]
		: opts.toolName
			? CAPABILITY_PERMISSION_KINDS
			: GRANT_TOOLS;
	const capabilities = kinds.map((permissionKind) =>
		capabilityForKind(permissionKind, grants, opts.policy)
	);

	return {
		mode: opts.mode,
		policy: opts.policy,
		approvalMode: opts.approvalMode,
		filters: {
			permissionKind: opts.permissionKind ?? null,
			toolName: opts.toolName ?? null,
			intent: opts.intent ?? null
		},
		capabilities,
		escalation: {
			forceRetry: {
				supported: true,
				guidance:
					'The default for any in-the-moment / one-off unblock. When a call is denied, the denial feedback carries a one-shot `force_retry_tool` token. Call `force_retry_tool` with that token and a concise reason (>= 20 chars) to raise a human prompt for that call; if the human approves, the exact denied call (portal-owned tools) executes immediately with the captured args, otherwise a matching retry is auto-allowed. It saves nothing.'
			},
			requestPermissionGrant: {
				supported: true,
				guidance:
					'Use ONLY when there is explicit persistence intent — the user or task wants a durable, saved rule that pre-approves future matching calls. For a one-off unblock use the `force_retry_tool` token from the denial instead. Call request_permission_grant with the narrowest structured scope; it always raises a human dialog (in every approval mode, including auto-approve and auto-deny) and is never auto-approved.'
			}
		}
	};
}

function capabilityForKind(
	permissionKind: string,
	grants: settings.GrantSummary[],
	policy: PermissionPolicy
): Capability {
	const relevant = grants.filter((g) => grantCoversPermissionKind(g, permissionKind));
	const allowed = relevant
		.filter((g) => g.decision === 'allow' || g.decision === 'force-allow')
		.map(grantToRule);
	const denied = relevant.filter((g) => g.decision === 'deny').map(grantToRule);
	const promptRequired = relevant.filter((g) => g.decision === 'prompt').map(grantToRule);
	const policyRule = policyRuleFor(permissionKind, policy);
	if (policyRule?.decision === 'allow') allowed.push(policyRule);
	if (policyRule?.decision === 'deny') denied.push(policyRule);

	const status = capabilityStatus(allowed, denied, promptRequired, policy);
	return pruneEmptyArrays({
		permissionKind,
		status,
		guidance: guidanceFor(permissionKind, status),
		allowed,
		denied,
		promptRequired
	});
}

function capabilityStatus(
	allowed: CapabilityRule[],
	denied: CapabilityRule[],
	promptRequired: CapabilityRule[],
	policy: PermissionPolicy
): CapabilityStatus {
	if (denied.length > 0 && (allowed.length > 0 || promptRequired.length > 0)) {
		return 'partially_allowed';
	}
	if (allowed.length > 0 && promptRequired.length > 0) return 'partially_allowed';
	if (allowed.length > 0) return 'allowed';
	if (promptRequired.length > 0) return 'prompt_required';
	if (denied.length > 0 || policy === 'deny-all') return 'denied';
	return 'prompt_required';
}

function grantCoversPermissionKind(g: settings.GrantSummary, permissionKind: string): boolean {
	if (
		g.permissionKind === permissionKind ||
		g.permissionKind === '*' ||
		g.permissionKind === null
	) {
		return true;
	}
	if (permissionKind === 'custom-tool' && g.permissionKind === 'custom-tool') return true;
	if (g.scope?.kind === 'fs' && isFilesystemPermissionKind(permissionKind)) {
		return !g.scope.perms || g.scope.perms.includes(permissionKind);
	}
	return g.scope?.kind === permissionKind;
}

function grantToRule(g: settings.GrantSummary): CapabilityRule {
	return {
		kind: ruleKind(g),
		decision: g.decision,
		scope: g.conversationId === null ? 'all-conversations' : 'current-conversation',
		summary: grantSummary(g)
	};
}

function ruleKind(g: settings.GrantSummary): CapabilityRule['kind'] {
	return capabilityRuleKindForScope(g.scope, g.argsHash);
}

function grantSummary(g: settings.GrantSummary): string {
	if (g.argsHash) return `${decisionVerb(g)} a previously approved exact ${g.tool} invocation.`;
	if (!g.scope) return `${decisionVerb(g)} ${g.tool} requests covered by a legacy grant.`;
	return `${decisionVerb(g)} ${g.tool} for ${capabilityScopeSummary(g.scope)}.`;
}

function decisionVerb(
	g: settings.GrantSummary
): 'Approve' | 'Force approve' | 'Deny' | 'Prompt for' {
	if (g.decision === 'force-allow') return 'Force approve';
	if (g.decision === 'deny') return 'Deny';
	if (g.decision === 'prompt') return 'Prompt for';
	return 'Approve';
}

function policyRuleFor(permissionKind: string, policy: PermissionPolicy): CapabilityRule | null {
	if (policy === 'prompt') return null;
	return {
		kind: 'policy',
		decision: policy === 'allow-all' ? 'allow' : 'deny',
		scope: 'current-conversation',
		summary: `${policy} policy applies to ${permissionKind} requests not covered by grants.`
	};
}

function guidanceFor(permissionKind: string, status: CapabilityStatus): string {
	if (status === 'allowed')
		return `${permissionKind} has allowed paths available; prefer those first.`;
	if (status === 'partially_allowed') {
		return `${permissionKind} has a mix of approve, prompt, or deny rules; use approved alternatives and avoid denied shapes.`;
	}
	if (status === 'denied')
		return `${permissionKind} is hard-denied by policy or grants; a valid force_retry_tool (token from the denial) still reaches a human permission prompt that can override it.`;
	return (
		`${permissionKind} requests not covered by listed grants will prompt. ` +
		'Under the `auto-deny` approval mode, prompt-worthy requests auto-reject; use the `force_retry_tool` token from the denial to reach a human for the exact call.'
	);
}

function pruneEmptyArrays(capability: Capability): Capability {
	if (capability.allowed?.length === 0) delete capability.allowed;
	if (capability.denied?.length === 0) delete capability.denied;
	if (capability.promptRequired?.length === 0) delete capability.promptRequired;
	return capability;
}
