import type {
	ElicitationSchema,
	InteractiveKind,
	InteractiveRequestView,
	InteractiveRequestViewBody,
	InteractiveResponse,
	PermissionPolicy,
	PortalEvent,
	SessionMode
} from '$lib/types';
import {
	newRequestId,
	register as registerInteractive,
	decideByPolicy
} from './interactive-requests';
import * as settingsRepo from '../db/repos/settings';
import { deriveScopeKey } from '../permissions/matcher';
import {
	detectShellMisuse,
	parseShellCommand,
	type ParsedSegment
} from '../permissions/shell-parser';
import { log } from '../log';
import * as messagesRepo from '../db/repos/messages';
import { argsHash } from '../tool-invocation';
import {
	bestEffortAlternativeHint,
	bestEffortPermissionKindLabel,
	isFilesystemPermissionKind
} from '$lib/permissions/metadata';
import { summarizeGitCommitPermission } from '$lib/permissions/git-commit';

interface PermissionRequestLike {
	kind?: string;
	toolName?: string;
	toolCallId?: string;
	toolDescription?: string;
	fileName?: string;
	fullCommandText?: string;
	path?: string;
	url?: string;
	intention?: string;
	forcePermissionPrompt?: unknown;
	args?: unknown;
}

const FORCE_PERMISSION_PROMPT_MIN_LENGTH = 20;
const INVALID_FORCE_PERMISSION_PROMPT_FEEDBACK =
	'`forcePermissionPrompt` must be a reason string of at least 20 characters explaining why no allowed alternative works.';

interface InteractiveAdapterOptions {
	conversationId: string;
	userId: string;
	workingDirectory: string;
	policy: PermissionPolicy;
	emit(ev: PortalEvent): void;
	getApproveAll(): boolean;
	getMode(): SessionMode;
	getSessionWorkspacePath(): string | null;
	getPermissionBehavior(tool: string): 'normal' | 'always-prompt' | 'never-prompt';
	validateCustomToolArgs?(toolName: string, args: unknown): { feedback: string } | null;
}

export function createInteractiveCallbacks(opts: InteractiveAdapterOptions) {
	async function askInteractive<R extends InteractiveResponse>(
		kind: InteractiveKind,
		view: InteractiveRequestViewBody
	): Promise<R> {
		const requestId = newRequestId();
		const full = { requestId, ...view } as InteractiveRequestView;
		return await new Promise<R>((resolve, reject) => {
			registerInteractive({
				requestId,
				conversationId: opts.conversationId,
				kind,
				view: full,
				resolve: (r) => resolve(r as R),
				reject,
				emit: opts.emit
			});
			opts.emit({ type: 'interactive.request', request: full });
		});
	}

	const onPermissionRequest = async (req: PermissionRequestLike) => {
		const tool = req.toolName ?? req.kind ?? 'unknown';
		const permissionKind = req.kind ?? 'unknown';
		const summary = summarizePermissionRequest(req, tool);
		const scopeKey = deriveScopeKey(permissionKind, req);
		const hash = hashPermissionArgs(req);
		const alwaysPrompt = opts.getPermissionBehavior(tool) === 'always-prompt';
		const neverPrompt = opts.getPermissionBehavior(tool) === 'never-prompt';

		const audit = (decision: 'auto-allow' | 'auto-deny' | 'auto-prompt-required') => {
			try {
				settingsRepo.recordDecision(opts.conversationId, tool, summary, decision);
			} catch (e) {
				log.warn('copilot.permission_audit_failed', {
					conversationId: opts.conversationId,
					err: String(e)
				});
			}
		};

		const forcePermissionPrompt = parseForcePermissionPrompt(req);
		if (forcePermissionPrompt.kind === 'invalid') {
			audit('auto-deny');
			return { kind: 'reject', feedback: forcePermissionPrompt.feedback } as const;
		}
		const forceEscalationReason =
			forcePermissionPrompt.kind === 'valid' ? forcePermissionPrompt.reason : null;

		// Compute shell analysis up front so it can be surfaced in any
		// permission dialog, including a forced prompt that overrides the
		// misuse guard. detectShellMisuse only auto-rejects when there is
		// no valid force; under a valid force the misuse reason is passed
		// to the forced prompt as its defaultDenyFeedback (see below)
		// instead of being hard-rejected here.
		let shellSegments: ParsedSegment[] | null = null;
		let shellAnalysis: import('$lib/types').ShellAnalysisView | undefined = undefined;
		let shellMisuse: { feedback: string } | null = null;
		if (permissionKind === 'shell' && typeof scopeKey === 'string') {
			shellMisuse = detectShellMisuse(scopeKey);
			const parsed = parseShellCommand(scopeKey);
			if (parsed.kind === 'parsed') {
				shellSegments = parsed.segments;
				shellAnalysis = {
					kind: 'parsed',
					segments: parsed.segments.map((s) => ({
						argv: s.argv,
						followingOp: s.followingOp
					}))
				};
			} else {
				shellAnalysis = { kind: 'unsafe', reason: parsed.reason };
			}
		}

		const maybePromptForEscalation = async (
			fallbackFeedback = 'Escalation denied. Use an allowed alternative or stop and explain what capability is missing.',
			defaultDenyFeedback?: string
		) => {
			if (!forceEscalationReason) return null;
			const response = await askInteractive<Extract<InteractiveResponse, { kind: 'permission' }>>(
				'permission',
				{
					kind: 'permission',
					tool,
					permissionKind,
					summary,
					args: req.args ?? null,
					userPolicy: opts.policy,
					canPersistDecision: false,
					escalationReason: forceEscalationReason,
					defaultDenyFeedback,
					shellAnalysis
				}
			);
			if (response.decision === 'deny' || response.decision === 'deny-always') {
				audit('auto-deny');
				return rejectWithFeedback(response, fallbackFeedback);
			}
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		};

		// Grant matching is a side-effect-free lookup. Compute it lazily and
		// memoize so the forced-escalation block can reuse a deny/prompt
		// grant's feedback without paying for a second lookup on the main path.
		const lookupGrant = () => {
			const target = isFilesystemPermissionKind(permissionKind) ? scopeKey : null;
			const url = permissionKind === 'url' ? scopeKey : null;
			return settingsRepo.matchGrantDetailed(
				opts.userId,
				opts.conversationId,
				tool,
				permissionKind,
				scopeKey,
				{
					shellSegments,
					target,
					url,
					workspaceRoot: opts.workingDirectory ?? null,
					sessionWorkspaceRoot: opts.getSessionWorkspacePath(),
					argsHash: hash
				}
			);
		};
		let grantResult: ReturnType<typeof settingsRepo.matchGrantDetailed> | null = null;
		const getGrant = () => (grantResult ??= lookupGrant());

		// A present, valid `forcePermissionPrompt` is the strongest signal:
		// it overrides every auto-allow and auto-deny path that follows —
		// the arg-schema and shell-misuse guards, `never-prompt`,
		// `always-prompt`, grants (including hard denies), the session
		// approve-all toggle, and policy — and always reaches a human
		// prompt. Only the malformed-force reject above runs ahead of it.
		// The forced prompt is approve-once: the human cannot persist a
		// grant from it (`canPersistDecision: false`).
		//
		// Whatever specific reason would otherwise have auto-rejected the
		// request (schema-invalid tool args, a hardcoded shell-misuse
		// refusal, or a deny/prompt grant) is surfaced to the human as the
		// dialog's `defaultDenyFeedback` and returned to the agent if the
		// human declines, so neither side loses that context.
		if (forceEscalationReason) {
			let forcedDenyFeedback: string | undefined;
			if (req.toolName && opts.validateCustomToolArgs) {
				forcedDenyFeedback = opts.validateCustomToolArgs(req.toolName, req.args)?.feedback;
			}
			if (!forcedDenyFeedback && shellMisuse) {
				forcedDenyFeedback = shellMisuse.feedback;
			}
			if (!forcedDenyFeedback) {
				const g = getGrant();
				if (g.outcome === 'deny' || g.outcome === 'prompt') {
					forcedDenyFeedback = g.feedback ?? undefined;
				}
			}
			const forced = await maybePromptForEscalation(forcedDenyFeedback, forcedDenyFeedback);
			if (forced) return forced;
		}

		// Schema-validate custom portal tool args before any permission
		// dialog or grant matching. Args that don't match the tool's
		// declared schema are an agent bug, not something the user
		// should approve; rejecting here with the schema in the
		// feedback lets the agent self-correct on the next turn. A valid
		// force above overrides this guard.
		if (req.toolName && opts.validateCustomToolArgs) {
			const invalid = opts.validateCustomToolArgs(req.toolName, req.args);
			if (invalid) {
				audit('auto-deny');
				return { kind: 'reject', feedback: invalid.feedback } as const;
			}
		}
		if (neverPrompt) {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		if (shellMisuse) {
			audit('auto-deny');
			return { kind: 'reject', feedback: shellMisuse.feedback } as const;
		}

		if (alwaysPrompt) {
			const response = await askInteractive<Extract<InteractiveResponse, { kind: 'permission' }>>(
				'permission',
				{
					kind: 'permission',
					tool,
					permissionKind,
					summary,
					args: req.args ?? null,
					userPolicy: opts.policy,
					canPersistDecision: false,
					shellAnalysis
				}
			);
			if (response.decision === 'deny' || response.decision === 'deny-always') {
				return rejectWithFeedback(response);
			}
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		const grant = getGrant();
		if (grant.outcome === 'allow') {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		if (grant.outcome === 'deny') {
			audit('auto-deny');
			if (grant.feedback) return { kind: 'reject', feedback: grant.feedback } as const;
			return { kind: 'reject' } as const;
		}
		let promptRequest: {
			canPersistDecision: boolean;
			bestEffortFeedback: string;
			defaultDenyFeedback?: string;
		};
		if (grant.outcome === 'prompt') {
			promptRequest = {
				canPersistDecision: false,
				bestEffortFeedback: grant.feedback ?? bestEffortPromptGrantFeedback({ permissionKind }),
				defaultDenyFeedback: grant.feedback ?? undefined
			};
		} else {
			if (opts.getApproveAll()) {
				audit('auto-allow');
				return { kind: 'approve-once' } as const;
			}

			const decision = decideByPolicy(opts.policy, 'permission', permissionKind, {
				scopeKey,
				workspaceRoot: opts.workingDirectory
			});
			if (decision === 'approved') {
				audit('auto-allow');
				return { kind: 'approve-once' } as const;
			}
			if (decision === 'denied') {
				audit('auto-deny');
				return { kind: 'reject' } as const;
			}
			promptRequest = {
				canPersistDecision: true,
				bestEffortFeedback: bestEffortPermissionFeedback({ permissionKind })
			};
		}

		if (opts.getMode() === 'best-effort') {
			// A valid force would have returned from the forced-escalation
			// block above, so an interactive escalation is never reachable
			// here; best-effort simply auto-rejects with actionable feedback.
			audit('auto-prompt-required');
			return {
				kind: 'reject',
				feedback: promptRequest.bestEffortFeedback
			} as const;
		}

		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'permission' }>>(
			'permission',
			{
				kind: 'permission',
				tool,
				permissionKind,
				summary,
				args: req.args ?? null,
				userPolicy: opts.policy,
				canPersistDecision: promptRequest.canPersistDecision,
				defaultDenyFeedback: promptRequest.defaultDenyFeedback,
				shellAnalysis
			}
		);
		if (response.decision === 'deny' || response.decision === 'deny-always') {
			return rejectWithFeedback(response);
		}
		return { kind: 'approve-once' } as const;
	};

	const onUserInputRequest = async (req: {
		question?: string;
		choices?: string[];
		allowFreeform?: boolean;
	}) => {
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'user_input' }>>(
			'user_input',
			{
				kind: 'user_input',
				question: req.question ?? 'The agent is requesting input.',
				choices: req.choices,
				allowFreeform: req.allowFreeform ?? true
			}
		);
		return { answer: response.answer, wasFreeform: response.wasFreeform ?? true };
	};

	const onElicitationRequest = async (ctx: {
		message?: string;
		requestedSchema?: unknown;
		mode?: 'form' | 'url';
		url?: string;
		elicitationSource?: string;
	}) => {
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'elicitation' }>>(
			'elicitation',
			{
				kind: 'elicitation',
				message: ctx.message ?? '',
				mode: ctx.mode ?? 'form',
				url: ctx.url,
				requestedSchema: ctx.requestedSchema as ElicitationSchema | undefined,
				elicitationSource: ctx.elicitationSource
			}
		);
		if (response.action === 'accept') {
			return { action: 'accept' as const, content: response.content ?? {} };
		}
		return { action: response.action };
	};

	const onExitPlanMode = async (req: {
		summary?: string;
		planContent?: string;
		actions?: string[];
		recommendedAction?: string;
	}) => {
		const actions = req.actions ?? ['continue'];
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'exit_plan_mode' }>>(
			'exit_plan_mode',
			{
				kind: 'exit_plan_mode',
				summary: req.summary ?? 'Exit plan mode and continue?',
				planContent: req.planContent,
				actions,
				recommendedAction: req.recommendedAction ?? actions[0] ?? 'continue'
			}
		);
		return {
			approved: response.approved,
			selectedAction: response.selectedAction,
			feedback: response.feedback
		};
	};

	const onAutoModeSwitch = async (req: { errorCode?: string; retryAfterSeconds?: number }) => {
		const response = await askInteractive<
			Extract<InteractiveResponse, { kind: 'auto_mode_switch' }>
		>('auto_mode_switch', {
			kind: 'auto_mode_switch',
			errorCode: req.errorCode,
			retryAfterSeconds: req.retryAfterSeconds
		});
		return response.decision;
	};

	return {
		onPermissionRequest,
		onUserInputRequest,
		onElicitationRequest,
		onExitPlanMode,
		onAutoModeSwitch
	};
}

function rejectWithFeedback(
	response: Extract<InteractiveResponse, { kind: 'permission' }>,
	fallbackFeedback?: string
) {
	const feedback = response.feedback?.trim() || fallbackFeedback;
	return feedback ? ({ kind: 'reject', feedback } as const) : ({ kind: 'reject' } as const);
}

function hashPermissionArgs(req: PermissionRequestLike): string | null {
	if (typeof req.toolCallId === 'string') {
		const args = messagesRepo.getToolCallArgs(req.toolCallId);
		if (args !== null) return argsHash(args);
	}
	if (req.args !== undefined) return argsHash(req.args);
	return null;
}

function parseForcePermissionPrompt(
	req: PermissionRequestLike
): { kind: 'absent' } | { kind: 'invalid'; feedback: string } | { kind: 'valid'; reason: string } {
	const values = forcePermissionPromptValues(req);
	if (values.length === 0) return { kind: 'absent' };

	let reason: string | null = null;
	for (const value of values) {
		if (typeof value !== 'string') {
			return { kind: 'invalid', feedback: INVALID_FORCE_PERMISSION_PROMPT_FEEDBACK };
		}
		const trimmed = value.trim();
		if (trimmed.length < FORCE_PERMISSION_PROMPT_MIN_LENGTH) {
			return { kind: 'invalid', feedback: INVALID_FORCE_PERMISSION_PROMPT_FEEDBACK };
		}
		reason ??= trimmed;
	}

	return { kind: 'valid', reason: reason ?? '' };
}

function forcePermissionPromptValues(req: PermissionRequestLike): unknown[] {
	const values: unknown[] = [];
	if (hasOwn(req, 'forcePermissionPrompt')) values.push(req.forcePermissionPrompt);

	const argValue = readArgValue(req.args, 'forcePermissionPrompt');
	if (argValue.present) values.push(argValue.value);

	if (typeof req.toolCallId === 'string') {
		const persistedValue = readArgValue(
			messagesRepo.getToolCallArgs(req.toolCallId),
			'forcePermissionPrompt'
		);
		if (persistedValue.present) values.push(persistedValue.value);
	}

	return values;
}

function readArgValue(
	args: unknown,
	key: string
): { present: false } | { present: true; value: unknown } {
	if (!args || typeof args !== 'object') return { present: false };
	if (!hasOwn(args, key)) return { present: false };
	return { present: true, value: (args as Record<string, unknown>)[key] };
}

function hasOwn(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

function bestEffortPermissionFeedback(view: { permissionKind: string }): string {
	const alternative = bestEffortAlternativeHint(view.permissionKind);
	const permissionKind = bestEffortPermissionKindLabel(view.permissionKind);
	return (
		`A ${permissionKind} permission request was auto-rejected because this conversation is in \`best-effort\` mode. ` +
		`${alternative} Use \`permission_capabilities\` to inspect alternatives. If still blocked after verifying no allowed alternative works, retry sparingly with \`forcePermissionPrompt\`.`
	);
}

function bestEffortPromptGrantFeedback(view: { permissionKind: string }): string {
	const permissionKind = bestEffortPermissionKindLabel(view.permissionKind);
	return (
		`A ${permissionKind} permission request matched a saved prompt grant and ` +
		'requires interactive approval, ' +
		'but this conversation is in `best-effort` mode and cannot display permission dialogs.'
	);
}

function summarizePermissionRequest(req: PermissionRequestLike, tool: string): string {
	if (tool === 'git_commit') {
		const summary = summarizeGitCommitPermission(req.args);
		if (summary) return summary;
	}
	return req.fullCommandText ?? req.fileName ?? req.path ?? req.url ?? req.toolDescription ?? tool;
}
