import { z } from 'zod';
import type { ApprovalMode, PermissionPolicy, SessionMode } from '$lib/types';
import { GRANT_TOOLS, isFilesystemPermissionKind } from '$lib/permissions/metadata';
import { capabilityRuleKindForScope, capabilityScopeSummary } from '$lib/permissions/scope-summary';
import * as settings from '../../db/repos/settings';
import { conversationId as convCodec } from '$lib/ids';
import { ok, type PortalTool } from '../types';

const CAPABILITY_PERMISSION_KINDS = [...GRANT_TOOLS, 'custom-tool'] as const;
const PermissionKind = z.enum(CAPABILITY_PERMISSION_KINDS);

export const CapabilitiesArgs = z
	.object({
		permissionKind: PermissionKind.optional(),
		toolName: z.string().trim().min(1).max(200).optional(),
		intent: z.string().trim().min(1).max(500).optional(),
		detail: z.boolean().optional()
	})
	.prefault({});

export type CapabilityStatus = 'allowed' | 'denied' | 'prompt_required' | 'partially_allowed';

export interface CapabilityRule {
	kind: ReturnType<typeof capabilityRuleKindForScope> | 'policy';
	decision: 'allow' | 'force-allow' | 'deny' | 'prompt';
	scope: 'all-conversations' | 'current-conversation';
	summary: string;
}

export interface Capability {
	permissionKind: string;
	status: CapabilityStatus;
	guidance: string;
	allowed?: CapabilityRule[];
	denied?: CapabilityRule[];
	promptRequired?: CapabilityRule[];
}

export interface CapabilitiesToolOpts {
	userId: number;
	conversationId: number;
	policy: PermissionPolicy;
	getMode: () => SessionMode;
	getApprovalMode: () => ApprovalMode;
}

export function buildCapabilitiesTool(opts: CapabilitiesToolOpts): PortalTool {
	return {
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
					...(parsed.permissionKind !== undefined ? { permissionKind: parsed.permissionKind } : {}),
					...(parsed.toolName !== undefined ? { toolName: parsed.toolName } : {}),
					...(parsed.intent !== undefined ? { intent: parsed.intent } : {}),
					verbose: parsed.detail ?? false
				})
			);
		}
	};
}

export function permissionCapabilities(opts: {
	userId: number;
	conversationId: number;
	mode: SessionMode;
	approvalMode: ApprovalMode;
	policy: PermissionPolicy;
	permissionKind?: string;
	toolName?: string;
	intent?: string;
	verbose?: boolean;
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

	if (!opts.verbose) {
		return {
			capabilities: capabilities.map((c) => ({
				permissionKind: c.permissionKind,
				status: c.status
			})),
			escalation: {
				forceRetry: {
					supported: true,
					guidance: 'one-off unblock → force_retry_tool(token)'
				},
				requestPermissionGrant: {
					supported: true,
					guidance: 'durable rule → request_permission_grant'
				}
			}
		};
	}

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

export function capabilityForKind(
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

export function grantCoversPermissionKind(
	g: settings.GrantSummary,
	permissionKind: string
): boolean {
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

export function grantToRule(g: settings.GrantSummary): CapabilityRule {
	return {
		kind: ruleKind(g),
		decision: g.decision,
		scope: g.conversationId === null ? 'all-conversations' : 'current-conversation',
		summary: grantSummary(g)
	};
}

export function ruleKind(g: settings.GrantSummary): CapabilityRule['kind'] {
	return capabilityRuleKindForScope(g.scope, g.argsHash);
}

export function grantSummary(g: settings.GrantSummary): string {
	if (g.argsHash) return `${decisionVerb(g)} a previously approved exact ${g.tool} invocation.`;
	if (!g.scope) return `${decisionVerb(g)} ${g.tool} requests covered by a legacy grant.`;
	return `${decisionVerb(g)} ${g.tool} for ${capabilityScopeSummary(g.scope)}.`;
}

export function decisionVerb(
	g: settings.GrantSummary
): 'Approve' | 'Force approve' | 'Deny' | 'Prompt for' {
	if (g.decision === 'force-allow') return 'Force approve';
	if (g.decision === 'deny') return 'Deny';
	if (g.decision === 'prompt') return 'Prompt for';
	return 'Approve';
}

export function policyRuleFor(
	permissionKind: string,
	policy: PermissionPolicy
): CapabilityRule | null {
	if (policy === 'prompt') return null;
	return {
		kind: 'policy',
		decision: policy === 'allow-all' ? 'allow' : 'deny',
		scope: 'current-conversation',
		summary: `${policy} policy applies to ${permissionKind} requests not covered by grants.`
	};
}

export function guidanceFor(permissionKind: string, status: CapabilityStatus): string {
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

export function pruneEmptyArrays(capability: Capability): Capability {
	if (capability.allowed?.length === 0) delete capability.allowed;
	if (capability.denied?.length === 0) delete capability.denied;
	if (capability.promptRequired?.length === 0) delete capability.promptRequired;
	return capability;
}
