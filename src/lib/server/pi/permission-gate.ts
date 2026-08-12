// The portal permission gateway for pi tool calls.
//
// Hangs off the pi `tool_call` extension bridge (see session.ts): for every
// tool call the resolver decides allow/block, mirroring the native session's
// PreToolUse evaluation without the shadow-reviewer / forced-retry /
// shell-misuse / image-capture machinery those tickets layered on. Every
// decision funnels through the SAME machinery the
// non-pi path uses — `matchGrantDetailed` against the user's grants, the
// conversation's permission policy, and the interactive-request registry for
// human prompts — so a pi session and a native session see identical
// permission behavior.
//
// Evaluation order per call:
//   1. unknown tool                          → block
//   2. `derivePermissionRequest` override    → fs kind on the derived path(s)
//   3. `shell_exec`                          → `shell` kind on the command
//   4. everything else                       → `custom-tool` kind
//   5. grant match (allow / deny / prompt) per fs target, most-restrictive
//   6. `auto-approve` approval mode          → allow (policy still consulted)
//   7. policy (`allow-all` / `deny-all` / `prompt`)
//   8. `never-prompt` / `always-prompt` behaviors
//   9. `auto-deny` approval mode             → block with actionable feedback
//  10. otherwise                             → register a human prompt + await

import type {
	ApprovalMode,
	InteractivePermissionView,
	InteractiveResponse,
	PermissionPolicy,
	PortalEvent
} from '$lib/types';
import {
	autoDenyAlternativeHint,
	isFilesystemPermissionKind,
	permissionKindLabel
} from '$lib/permissions/metadata';
import { deriveScopeKey } from '$lib/permissions/scope-key';
import {
	decideByPolicy,
	isInteractivePromptCancelledError,
	newRequestId,
	register as registerInteractive
} from '../runtime/interactive-requests';
import * as settingsRepo from '../db/repos/settings';
import { argsHash } from '../tool-invocation';
import { log } from '../log';
import type { PortalTool } from '../tools/types';
import type { PiPermissionResolver } from './session';

export interface PiPermissionGateOptions {
	userId: number;
	conversationId: number;
	/** The session's working directory — the shell cwd AND the fs
	 * session-workspace root for this conversation. */
	workingDirectory: string;
	policy: PermissionPolicy;
	/** Every portal tool registered on the session, by name. */
	portalToolsByName: ReadonlyMap<string, PortalTool>;
	/** Live approval mode; a mid-turn PATCH takes effect on the next request. */
	getApprovalMode: () => ApprovalMode;
	/** Every root the conversation may act inside (workspace + held leases). */
	getWorkspaceRoots: () => string[];
	/** Pushes an event into the active turn's stream. */
	emit: (ev: PortalEvent) => void;
}

export function createPiPermissionResolver(opts: PiPermissionGateOptions): PiPermissionResolver {
	return async (toolName, args) => {
		try {
			return await decidePermission(opts, toolName, args);
		} catch (err) {
			// The `tool_call` bridge rethrows handler errors, aborting the turn, so
			// this resolver NEVER throws. A cancelled prompt is a "user not
			// available", not a denial; anything else is an internal failure.
			if (isInteractivePromptCancelledError(err)) {
				return {
					allow: false,
					reason:
						'The permission prompt was dismissed before you answered (turn aborted, timed out, or disconnected). This is not a denial — re-issue the call if the permission is still needed.'
				};
			}
			log.warn('pi.permission_gate_error', {
				conversationId: opts.conversationId,
				tool: toolName,
				err: err instanceof Error ? err.message : String(err)
			});
			return { allow: false, reason: 'The permission check failed; the call was blocked.' };
		}
	};
}

type TargetEval =
	| { kind: 'allow' }
	| { kind: 'deny'; feedback?: string | undefined }
	| { kind: 'prompt-grant'; feedback?: string | undefined }
	| { kind: 'prompt-policy'; feedback?: string | undefined };

const evalRank = { allow: 0, 'prompt-policy': 1, 'prompt-grant': 2, deny: 3 } as const;

async function decidePermission(
	opts: PiPermissionGateOptions,
	toolName: string,
	args: Record<string, unknown>
): Promise<{ allow: boolean; reason?: string }> {
	const tool = opts.portalToolsByName.get(toolName);
	if (!tool) {
		return {
			allow: false,
			reason: `Tool "${toolName}" is not a portal tool; the call was blocked by the portal permission gate.`
		};
	}

	// A tool may declare its permission as a filesystem request on a derived
	// path (see `PortalTool.derivePermissionRequest`); when it does, the grant
	// matcher sees the fs kind + path so existing fs grants/seeds apply.
	const override = tool.derivePermissionRequest ? tool.derivePermissionRequest(args) : null;
	const isShell = toolName === 'shell_exec';
	const permissionKind = override ? override.permissionKind : isShell ? 'shell' : 'custom-tool';
	const matchTool = override ? override.permissionKind : toolName;
	const fsKind = isFilesystemPermissionKind(permissionKind);

	// Scope-key: the derived path for fs overrides, the command text for shell,
	// null (any) for custom-tool grants.
	const scopeKey = override
		? override.path
		: isShell
			? deriveScopeKey('shell', { args })
			: deriveScopeKey(permissionKind, args);

	const summary = summarizePermissionRequest(toolName, permissionKind, scopeKey, args);
	const hash = argsHash(args);
	const workspaceRoots = opts.getWorkspaceRoots();
	const alwaysPrompt = tool.permissionBehavior === 'always-prompt';
	const neverPrompt = tool.permissionBehavior === 'never-prompt';

	const audit = (decision: 'auto-allow' | 'auto-deny' | 'auto-prompt-required') => {
		try {
			settingsRepo.recordDecision(opts.conversationId, toolName, summary, decision);
		} catch (e) {
			log.warn('pi.permission_audit_failed', {
				conversationId: opts.conversationId,
				err: String(e)
			});
		}
	};

	// fs targets to evaluate. A tool may declare additional fs paths that must
	// ALSO be permitted (e.g. `move`): per-target decisions combine
	// most-restrictively (deny on any target denies; auto-allow needs every
	// target). Non-fs kinds always have exactly one target (the scope key).
	const evalTargets: (string | null)[] =
		override && fsKind ? [override.path, ...(override.additionalPaths ?? [])] : [scopeKey];
	const isMultiTarget = evalTargets.length > 1;

	const evaluateTarget = (key: string | null): TargetEval => {
		const g = settingsRepo.matchGrantDetailed(
			opts.userId,
			opts.conversationId,
			matchTool,
			permissionKind,
			key,
			{
				target: fsKind ? key : null,
				url: null,
				workspaceRoots,
				sessionWorkspaceRoot: opts.workingDirectory,
				shellCwd: opts.workingDirectory,
				argsHash: hash
			}
		);
		if (g.outcome === 'allow') return { kind: 'allow' };
		if (g.outcome === 'deny') return { kind: 'deny', feedback: g.feedback ?? undefined };
		if (g.outcome === 'prompt') return { kind: 'prompt-grant', feedback: g.feedback ?? undefined };
		if (opts.getApprovalMode() === 'auto-approve') {
			// Auto-approve lets the request through regardless of policy; the
			// policy is not consulted here because there is nothing to decide.
			return { kind: 'allow' };
		}
		const nearMiss = g.feedback ?? undefined;
		const decision = decideByPolicy(opts.policy, 'permission', permissionKind, {
			scopeKey: key,
			workspaceRoots
		});
		if (decision === 'approved') return { kind: 'allow' };
		if (decision === 'denied') return { kind: 'deny', feedback: nearMiss };
		return { kind: 'prompt-policy', feedback: nearMiss };
	};

	const computeEval = (): TargetEval => {
		let worst: TargetEval = { kind: 'allow' };
		for (const key of evalTargets) {
			const e = evaluateTarget(key);
			if (evalRank[e.kind] > evalRank[worst.kind]) worst = e;
		}
		return worst;
	};
	let evalResult: TargetEval | null = null;
	const getEval = () => (evalResult ??= computeEval());

	if (neverPrompt) {
		audit('auto-allow');
		return { allow: true };
	}

	if (alwaysPrompt) {
		// always-prompt dialogs are not persistable and are audited as
		// auto-allows once the human approves.
		return await askHuman(
			opts,
			{ toolName, permissionKind, summary, args, canPersistDecision: false },
			{
				onApprove: () => {
					audit('auto-allow');
					return { allow: true };
				},
				onDeny: (feedback) => {
					audit('auto-deny');
					return feedback ? { allow: false, reason: feedback } : { allow: false };
				}
			}
		);
	}

	const evaluation = getEval();
	if (evaluation.kind === 'allow') {
		audit('auto-allow');
		return { allow: true };
	}
	if (evaluation.kind === 'deny') {
		audit('auto-deny');
		return { allow: false, reason: evaluation.feedback ?? 'Permission denied.' };
	}

	// prompt-grant (a saved prompt grant matched) or prompt-policy (nothing
	// matched, policy wants a human). A multi-target request can't be captured
	// by one stored scope, so persistence is disabled for those.
	const canPersistDecision = evaluation.kind === 'prompt-policy' ? !isMultiTarget : false;
	const autoDenyFeedback =
		evaluation.kind === 'prompt-grant'
			? (evaluation.feedback ?? autoDenyPromptGrantFeedback({ permissionKind }))
			: evaluation.feedback
				? `${autoDenyPermissionFeedback({ permissionKind })} ${evaluation.feedback}`
				: autoDenyPermissionFeedback({ permissionKind });

	if (opts.getApprovalMode() === 'auto-deny') {
		audit('auto-prompt-required');
		return { allow: false, reason: autoDenyFeedback };
	}

	return await askHuman(
		opts,
		{
			toolName,
			permissionKind,
			summary,
			args,
			canPersistDecision,
			...(evaluation.feedback !== undefined ? { defaultDenyFeedback: evaluation.feedback } : {})
		},
		{
			onApprove: () => {
				audit('auto-allow');
				return { allow: true };
			},
			onDeny: (feedback) => {
				audit('auto-deny');
				return feedback ? { allow: false, reason: feedback } : { allow: false };
			}
		}
	);
}

// Raise a human permission prompt and settle the decision from the response.
// The registry persists any *-always grants and audits the human decision;
// the resolver only maps the outcome to allow/block.
async function askHuman(
	opts: PiPermissionGateOptions,
	view: {
		toolName: string;
		permissionKind: string;
		summary: string;
		args: unknown;
		canPersistDecision: boolean;
		defaultDenyFeedback?: string;
	},
	handlers: {
		onApprove: () => { allow: boolean };
		onDeny: (feedback?: string) => { allow: boolean; reason?: string };
	}
): Promise<{ allow: boolean; reason?: string }> {
	const requestId = newRequestId();
	const fullView: InteractivePermissionView & { requestId: string } = {
		requestId,
		kind: 'permission',
		tool: view.toolName,
		permissionKind: view.permissionKind,
		summary: view.summary,
		args: view.args,
		userPolicy: opts.policy,
		canPersistDecision: view.canPersistDecision,
		...(view.defaultDenyFeedback !== undefined
			? { defaultDenyFeedback: view.defaultDenyFeedback }
			: {})
	};
	const response: InteractiveResponse = await new Promise<InteractiveResponse>(
		(resolve, reject) => {
			registerInteractive({
				requestId,
				conversationId: opts.conversationId,
				userId: opts.userId,
				kind: 'permission',
				view: fullView,
				resolve,
				reject,
				emit: opts.emit
			});
			opts.emit({ type: 'interactive.request', request: fullView });
		}
	);
	if (response.kind !== 'permission') {
		return { allow: false, reason: 'Unexpected response to the permission request.' };
	}
	if (response.decision === 'allow-once' || response.decision === 'allow-always') {
		return handlers.onApprove();
	}
	const feedback = typeof response.feedback === 'string' ? response.feedback.trim() : undefined;
	return handlers.onDeny(feedback || 'The human denied this tool call.');
}

function summarizePermissionRequest(
	toolName: string,
	permissionKind: string,
	scopeKey: string | null,
	args: unknown
): string {
	if (permissionKind === 'shell' && typeof scopeKey === 'string') return scopeKey;
	if (isFilesystemPermissionKind(permissionKind) && typeof scopeKey === 'string') return scopeKey;
	if (args && typeof args === 'object') {
		const text = JSON.stringify(args);
		return `${toolName} ${text}`;
	}
	return toolName;
}

function autoDenyPermissionFeedback(view: { permissionKind: string }): string {
	const kind = permissionKindLabel(view.permissionKind);
	const alternative = autoDenyAlternativeHint(view.permissionKind);
	return (
		`A ${kind} permission request was auto-rejected because this conversation's approval mode is \`auto-deny\`. ` +
		`${alternative} Use \`permission_capabilities\` to inspect alternatives. If still blocked after verifying no allowed alternative works, raise a one-off approval with \`force_retry_tool\`; only reach for \`request_permission_grant\` when you want a durable, saved rule.`
	);
}

function autoDenyPromptGrantFeedback(view: { permissionKind: string }): string {
	const kind = permissionKindLabel(view.permissionKind);
	return (
		`A ${kind} permission request matched a saved prompt grant and ` +
		'requires interactive approval, ' +
		"but this conversation's approval mode is `auto-deny` and cannot display permission dialogs."
	);
}
