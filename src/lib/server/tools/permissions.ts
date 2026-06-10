import { z } from 'zod';
import type { PermissionPolicy, SessionMode } from '$lib/types';
import { GRANT_TOOLS, isFilesystemPermissionKind } from '$lib/permissions/metadata';
import { capabilityRuleKindForScope, capabilityScopeSummary } from '$lib/permissions/scope-summary';
import * as settings from '../db/repos/settings';
import { ok, type PortalTool } from './types';

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
		}
	];
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
