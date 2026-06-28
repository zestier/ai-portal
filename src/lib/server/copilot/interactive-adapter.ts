import type {
	ElicitationSchema,
	ImagePreview,
	InteractiveKind,
	InteractiveRequestView,
	InteractiveRequestViewBody,
	InteractiveResponse,
	PermissionPolicy,
	PortalEvent,
	SessionMode
} from '$lib/types';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { captureImageAttachment, MAX_IMAGE_PREVIEW_BYTES } from './image-attachment';
import { resolveContainedToolPath } from '../files';
import { bufferAttachment, dropAttachment, pathKey, toolCallKey } from './tool-attachment-buffer';
import {
	newRequestId,
	register as registerInteractive,
	decideByPolicy,
	isInteractivePromptCancelledError
} from '../runtime/interactive-requests';
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
import type { ToolPermissionRequest } from '../tools/types';

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
	validateCustomToolArgs?:
		| ((toolName: string, args: unknown) => { feedback: string } | null)
		| undefined;
	// Optional hook letting a portal tool's permission be evaluated as a
	// filesystem request (e.g. a `write` on a derived path) instead of the
	// default `custom-tool` request, so it reuses the existing fs grants/seeds.
	// Returns null to keep the default custom-tool evaluation.
	derivePermissionRequest?:
		| ((toolName: string, args: unknown) => ToolPermissionRequest | null)
		| undefined;
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
				userId: opts.userId,
				kind,
				view: full,
				resolve: (r) => resolve(r as R),
				reject,
				emit: opts.emit
			});
			opts.emit({ type: 'interactive.request', request: full });
		});
	}

	// Eagerly capture a readable image the agent is about to `view` so it can
	// be previewed before approval and rendered in the resolved card. The bytes
	// are staged in an in-memory buffer keyed by toolCallId / (conversation +
	// path) and flushed to `tool_attachments` once the owning tool_calls row
	// exists (on execution_start). Capture is strictly limited to read requests
	// (view is read-only), so this never executes or mutates anything.
	const maybeCaptureImage = (
		req: PermissionRequestLike
	): { keys: string[]; imagePreview?: ImagePreview | undefined } | null => {
		if (req.kind !== 'read') return null;
		if (typeof req.path !== 'string' || req.path.length === 0) return null;
		const root = opts.workingDirectory || process.cwd();
		// Containment guard: `req.path` is model-controlled, so resolve it against
		// the session workspace root and refuse anything that escapes it (same
		// symlink-safe check the file browser uses). Without this, a
		// prompt-injected `view /home/user/secrets/whatever.png` would let this
		// pre-approval capture read image bytes from anywhere on the host.
		const safeAbs = resolveContainedToolPath(root, req.path);
		if (!safeAbs) return null;
		const captured = captureImageAttachment(safeAbs);
		if (!captured) return null;
		// Correlation keys stay on the lexical absolute path so the flush side
		// (which recomputes it lexically in `correlationKeys`) matches; the read
		// above used the contained realpath.
		const absPath = isAbsolute(req.path) ? resolvePath(req.path) : resolvePath(root, req.path);
		const keys = [pathKey(opts.conversationId, absPath)];
		if (typeof req.toolCallId === 'string' && req.toolCallId.length > 0) {
			keys.push(toolCallKey(req.toolCallId));
		}
		bufferAttachment(keys, {
			kind: 'image',
			mimeType: captured.mimeType,
			data: captured.data,
			sourcePath: absPath,
			bufferedAt: Date.now()
		});
		const imagePreview: ImagePreview | undefined =
			captured.data.length <= MAX_IMAGE_PREVIEW_BYTES
				? {
						mimeType: captured.mimeType,
						dataBase64: captured.data.toString('base64'),
						byteSize: captured.data.length
					}
				: undefined;
		return { keys, imagePreview };
	};

	// Inner decision logic. Wrapped by `onPermissionRequest` (below) so a
	// prompt that is cancelled out from under us (turn abort, timeout, client
	// disconnect, or capacity eviction) is reported to the SDK as
	// "user-not-available" rather than a user denial.
	const decideCore = async (req: PermissionRequestLike, imagePreview?: ImagePreview) => {
		const tool = req.toolName ?? req.kind ?? 'unknown';
		// A tool may declare that its permission should be evaluated as a
		// filesystem request on a derived path (see `derivePermissionRequest`).
		// When it does, the grant matcher tool + kind become the fs permission
		// (e.g. `write`, so the request matches the standard fs-write seed whose
		// grant `tool` is `write`) and the derived path is injected so scope-key
		// derivation and the fs matcher read the same target. Display/audit keep
		// the real tool name.
		const override =
			req.toolName && opts.derivePermissionRequest
				? opts.derivePermissionRequest(req.toolName, req.args)
				: null;
		const permissionKind = override ? override.permissionKind : (req.kind ?? 'unknown');
		const matchTool = override ? override.permissionKind : tool;
		const scopeRequest: PermissionRequestLike = override ? { ...req, path: override.path } : req;
		const summary = summarizePermissionRequest(scopeRequest, tool);
		const scopeKey = deriveScopeKey(permissionKind, scopeRequest);
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
					shellAnalysis,
					imagePreview
				}
			);
			if (response.decision === 'deny' || response.decision === 'deny-always') {
				audit('auto-deny');
				return rejectWithFeedback(response, fallbackFeedback);
			}
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		};

		// fs targets to evaluate. A tool may declare additional fs paths that
		// must ALSO be permitted for the same invocation (e.g. `move`, which
		// must satisfy write on BOTH its source and destination). Each target is
		// checked against the real grants + policy and the per-target decisions
		// are combined to the most restrictive result: a deny on ANY target
		// denies the whole request, and an auto-allow requires EVERY target to
		// be permitted. This is the honest generalization of the single-path
		// check — it consults the same grants the user actually has rather than
		// a hardcoded workspace test. Non-fs kinds (shell/url/custom) always
		// have exactly one target (the scope key), so their behavior is
		// unchanged.
		const fsKind = isFilesystemPermissionKind(permissionKind);
		const evalTargets: (string | null)[] =
			override && fsKind ? [override.path, ...(override.additionalPaths ?? [])] : [scopeKey];
		const isMultiTarget = evalTargets.length > 1;

		// Per-target decision, distinguishing an explicit grant outcome (which
		// the session approve-all toggle must NOT override) from a policy-level
		// outcome (which it may). `prompt-grant` is also non-persistable.
		type TargetEval =
			| { kind: 'allow' }
			| { kind: 'deny'; feedback?: string | undefined }
			| { kind: 'prompt-grant'; feedback?: string | undefined }
			| { kind: 'prompt-policy' };
		const evalRank = { allow: 0, 'prompt-policy': 1, 'prompt-grant': 2, deny: 3 } as const;

		// Mirrors the original single-path ordering exactly: explicit grant
		// first (allow/deny/prompt), then the approve-all toggle, then policy.
		const evaluateTarget = (key: string | null): TargetEval => {
			const target = fsKind ? key : null;
			const url = permissionKind === 'url' ? key : null;
			const g = settingsRepo.matchGrantDetailed(
				opts.userId,
				opts.conversationId,
				matchTool,
				permissionKind,
				key,
				{
					shellSegments,
					target,
					url,
					workspaceRoot: opts.workingDirectory ?? null,
					sessionWorkspaceRoot: opts.getSessionWorkspacePath(),
					argsHash: hash
				}
			);
			if (g.outcome === 'allow') return { kind: 'allow' };
			if (g.outcome === 'deny') return { kind: 'deny', feedback: g.feedback ?? undefined };
			if (g.outcome === 'prompt') {
				return { kind: 'prompt-grant', feedback: g.feedback ?? undefined };
			}
			if (opts.getApproveAll()) return { kind: 'allow' };
			const decision = decideByPolicy(opts.policy, 'permission', permissionKind, {
				scopeKey: key,
				workspaceRoot: opts.workingDirectory
			});
			if (decision === 'approved') return { kind: 'allow' };
			if (decision === 'denied') return { kind: 'deny' };
			return { kind: 'prompt-policy' };
		};

		// Combine per-target evaluations most-restrictively. Memoized so the
		// forced-escalation block can reuse a deny/prompt feedback without
		// paying for a second lookup on the main path.
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
				const e = getEval();
				if (e.kind === 'deny' || e.kind === 'prompt-grant') {
					forcedDenyFeedback = e.feedback;
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
					shellAnalysis,
					imagePreview
				}
			);
			if (response.decision === 'deny' || response.decision === 'deny-always') {
				return rejectWithFeedback(response);
			}
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		const evaluation = getEval();
		if (evaluation.kind === 'allow') {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		if (evaluation.kind === 'deny') {
			audit('auto-deny');
			if (evaluation.feedback) return { kind: 'reject', feedback: evaluation.feedback } as const;
			return { kind: 'reject' } as const;
		}
		let promptRequest: {
			canPersistDecision: boolean;
			bestEffortFeedback: string;
			defaultDenyFeedback?: string | undefined;
		};
		if (evaluation.kind === 'prompt-grant') {
			promptRequest = {
				canPersistDecision: false,
				bestEffortFeedback:
					evaluation.feedback ?? bestEffortPromptGrantFeedback({ permissionKind }),
				defaultDenyFeedback: evaluation.feedback
			};
		} else {
			// prompt-policy: the approve-all toggle (applied per-target in
			// evaluateTarget) didn't short-circuit, so a human prompt is needed.
			// A single-target policy prompt is persistable as a grant; a
			// multi-target request can't be captured by one stored scope, so
			// persistence is disabled.
			promptRequest = {
				canPersistDecision: !isMultiTarget,
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
				...(promptRequest.defaultDenyFeedback !== undefined
					? { defaultDenyFeedback: promptRequest.defaultDenyFeedback }
					: {}),
				...(shellAnalysis !== undefined ? { shellAnalysis } : {}),
				...(imagePreview !== undefined ? { imagePreview } : {})
			}
		);
		if (response.decision === 'deny' || response.decision === 'deny-always') {
			return rejectWithFeedback(response);
		}
		return { kind: 'approve-once' } as const;
	};

	// Capture-then-decide wrapper. Stages any viewable image before the
	// decision (so a prompt can preview it), threads the preview into
	// `decideCore`, and drops the staged bytes if the read is rejected or
	// cancelled — only an approved read goes on to flush at execution_start.
	const decidePermission = async (req: PermissionRequestLike) => {
		const capture = maybeCaptureImage(req);
		try {
			const result = await decideCore(req, capture?.imagePreview);
			if (capture && result.kind === 'reject') dropAttachment(capture.keys);
			return result;
		} catch (err) {
			if (capture) dropAttachment(capture.keys);
			throw err;
		}
	};

	const onPermissionRequest = async (req: PermissionRequestLike) => {
		try {
			return await decidePermission(req);
		} catch (err) {
			if (isInteractivePromptCancelledError(err)) {
				// The prompt was abandoned (turn aborted, timed out, client
				// disconnected, or the backing session was evicted) before the
				// user answered. `user-not-available` tells the SDK the user
				// could not be reached — it is NOT a denial, so the SDK does not
				// log a tool rejection. The cancellation is already audited
				// (`auto-cancelled` / `auto-expired`) and broadcast as an
				// `interactive.resolved` event by the registry.
				return { kind: 'user-not-available' } as const;
			}
			throw err;
		}
	};

	const onUserInputRequest = async (req: {
		question?: string;
		choices?: string[];
		allowFreeform?: boolean;
	}) => {
		try {
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
		} catch (err) {
			if (isInteractivePromptCancelledError(err)) {
				return { answer: '', wasFreeform: true };
			}
			throw err;
		}
	};

	const onElicitationRequest = async (ctx: {
		message?: string;
		requestedSchema?: unknown;
		mode?: 'form' | 'url';
		url?: string;
		elicitationSource?: string;
	}) => {
		try {
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
		} catch (err) {
			if (isInteractivePromptCancelledError(err)) {
				return { action: 'cancel' as const };
			}
			throw err;
		}
	};

	const onExitPlanMode = async (req: {
		summary?: string;
		planContent?: string;
		actions?: string[];
		recommendedAction?: string;
	}) => {
		const actions = req.actions ?? ['continue'];
		try {
			const response = await askInteractive<
				Extract<InteractiveResponse, { kind: 'exit_plan_mode' }>
			>('exit_plan_mode', {
				kind: 'exit_plan_mode',
				summary: req.summary ?? 'Exit plan mode and continue?',
				planContent: req.planContent,
				actions,
				recommendedAction: req.recommendedAction ?? actions[0] ?? 'continue'
			});
			return {
				approved: response.approved,
				selectedAction: response.selectedAction,
				feedback: response.feedback
			};
		} catch (err) {
			if (isInteractivePromptCancelledError(err)) {
				return { approved: false };
			}
			throw err;
		}
	};

	const onAutoModeSwitch = async (req: { errorCode?: string; retryAfterSeconds?: number }) => {
		try {
			const response = await askInteractive<
				Extract<InteractiveResponse, { kind: 'auto_mode_switch' }>
			>('auto_mode_switch', {
				kind: 'auto_mode_switch',
				errorCode: req.errorCode,
				retryAfterSeconds: req.retryAfterSeconds
			});
			return response.decision;
		} catch (err) {
			if (isInteractivePromptCancelledError(err)) {
				return 'no' as const;
			}
			throw err;
		}
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
		`${alternative} Use \`permission_capabilities\` to inspect alternatives. If still blocked after verifying no allowed alternative works, retry sparingly with \`forcePermissionPrompt\` for this one-off unblock; only reach for \`request_permission_grant\` when you want a durable, saved rule.`
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
