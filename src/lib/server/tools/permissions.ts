import { z } from 'zod';
import type {
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
import {
	isInteractivePromptCancelledError,
	newRequestId,
	register as registerInteractive
} from '../runtime/interactive-requests';
import * as settings from '../db/repos/settings';
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
	userId: string;
	conversationId: string;
	policy: PermissionPolicy;
	getMode: () => SessionMode;
	/** Pushes an event into the active turn's stream. Required so the
	 * grant-request tool can raise a human permission dialog. */
	emit: (ev: PortalEvent) => void;
}): PortalTool[] {
	return [
		{
			name: 'permission_capabilities',
			description:
				'Read-only summary of currently allowed permission capabilities and recovery options. Use after a permission rejection to find allowed alternatives before escalating.',
			argsSchema: CapabilitiesArgs,
			parameters: {
				type: 'object',
				properties: {
					permissionKind: {
						type: 'string',
						enum: PermissionKind.options,
						description: 'Optional permission kind to inspect.'
					},
					toolName: {
						type: 'string',
						description: 'Optional tool name to inspect, such as shell, git_status, or view.'
					},
					intent: {
						type: 'string',
						description: 'Optional short description of what you were trying to do.'
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
						policy: opts.policy,
						permissionKind: parsed.permissionKind,
						toolName: parsed.toolName,
						intent: parsed.intent
					})
				);
			}
		},
		buildGrantRequestTool(opts)
	];
}

const GRANT_REQUEST_REASON_MIN = 20;

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
	userId: string;
	conversationId: string;
	policy: PermissionPolicy;
	emit: (ev: PortalEvent) => void;
}): PortalTool {
	return {
		name: 'request_permission_grant',
		description:
			'Ask the human to save a narrow, permanent permission grant so future matching tool calls are pre-approved. Useful when scaffolding a project needs a specific toolchain (e.g. running `pnpm`, `cargo`, or `npm`): request the NARROWEST scope that covers the need. This ALWAYS opens a human approval dialog and is never auto-approved, even with approvals bypassed; the human can narrow or deny it. Provide `tool` (the permission kind to grant), a structured `scope`, and a `reason`. Examples of `scope`: shell → {"kind":"shell","rule":{"command":[{"token":"pnpm"}],"positionals":{"kind":"workspace-paths"}}}; write → {"kind":"fs","perms":["write"],"rule":{"kind":"path","root":"workspace","behavior":"any"}}; url → {"kind":"url","rule":{"kind":"host","host":"registry.npmjs.org"}}.',
		argsSchema: GrantRequestArgs,
		permissionBehavior: 'never-prompt',
		parameters: {
			type: 'object',
			properties: {
				tool: {
					type: 'string',
					enum: [...GRANT_TOOLS],
					description:
						'Permission kind the grant covers: `shell` (run a command), `read`/`write`/`edit` (filesystem), or `url` (fetch).'
				},
				reason: {
					type: 'string',
					description:
						'Short justification (>=20 chars) shown to the human for why this grant is needed.'
				},
				scope: {
					type: 'object',
					description:
						'Structured grant scope. Its `kind` must match the tool: shell→{kind:"shell",rule:{command:[{token:"<argv0>"},...],positionals?,pipeline?}}, read/write/edit→{kind:"fs",perms?:["write"],rule:{kind:"path",root:"workspace"|"session-workspace"|"absolute",behavior:"any"|"exact"|"prefix"|"glob",value?}}, url→{kind:"url",rule:{kind:"host"|"host-suffix"|"exact",...}}. Prefer the narrowest shape that covers the need.',
					additionalProperties: true
				}
			},
			required: ['tool', 'scope', 'reason'],
			additionalProperties: false
		},
		async handler(args) {
			const parsed = GrantRequestArgs.parse(args);
			// This tool is the structured analogue of `forcePermissionPrompt`:
			// it ALWAYS raises a human dialog regardless of session mode. Like a
			// forced escalation (see interactive-adapter.ts), it must still reach
			// a human in `best-effort` mode — best-effort only changes the
			// *automatic* policy default, it does not disable the dialog UI. The
			// prompt waits until the human answers or the turn aborts (handled
			// below as a non-denying cancellation).

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
						'The permission grant request was dismissed before the human decided (turn aborted, timed out, or disconnected). This is not a denial — re-issue it if the grant is still needed.',
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
					'The human approved this request but chose not to save a permanent grant; the matching tool calls will still prompt.'
				);
			}

			const feedback = typeof response.feedback === 'string' ? response.feedback.trim() : '';
			return err(
				feedback
					? `The human declined to save this grant: ${feedback}`
					: 'The human declined to save this permission grant.',
				{ code: 'grant_request_denied' }
			);
		}
	};
}

function permissionCapabilities(opts: {
	userId: string;
	conversationId: string;
	mode: SessionMode;
	policy: PermissionPolicy;
	permissionKind?: string;
	toolName?: string;
	intent?: string;
}) {
	const grants = settings
		.listGrantsForUser(opts.userId)
		.filter((g) => g.conversationId === null || g.conversationId === opts.conversationId)
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
		bestEffort: opts.mode === 'best-effort',
		filters: {
			permissionKind: opts.permissionKind ?? null,
			toolName: opts.toolName ?? null,
			intent: opts.intent ?? null
		},
		capabilities,
		escalation: {
			forcePermissionPrompt: {
				supported: true,
				guidance:
					'Use sparingly. Retry the blocked request with forcePermissionPrompt and a concise reason only after verifying no allowed alternative works.'
			},
			requestPermissionGrant: {
				supported: true,
				guidance:
					'When a task needs repeated use of a capability (e.g. running a toolchain while scaffolding), call request_permission_grant with the narrowest structured scope to ask the human to save a permanent grant. It always raises a human dialog (in every mode, including best-effort) and is never auto-approved.'
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
		return `${permissionKind} is hard-denied by policy or grants; a valid forcePermissionPrompt still reaches a human permission prompt that can override it.`;
	return (
		`${permissionKind} requests not covered by listed grants will prompt. ` +
		'In best-effort mode, prompt-worthy requests auto-reject unless retried with forcePermissionPrompt.'
	);
}

function pruneEmptyArrays(capability: Capability): Capability {
	if (capability.allowed?.length === 0) delete capability.allowed;
	if (capability.denied?.length === 0) delete capability.denied;
	if (capability.promptRequired?.length === 0) delete capability.promptRequired;
	return capability;
}
