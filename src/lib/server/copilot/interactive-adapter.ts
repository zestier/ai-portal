import type {
	ApprovalMode,
	ElicitationSchema,
	ImagePreview,
	InteractiveKind,
	InteractivePermissionView,
	InteractiveRequestView,
	InteractiveRequestViewBody,
	InteractiveResponse,
	PermissionPolicy,
	PortalEvent
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
	consumeForcedRetryMatch,
	mintForcedRetry,
	withForceRetryHint
} from '../runtime/forced-retry';
import {
	autoDenyAlternativeHint,
	permissionKindLabel,
	isFilesystemPermissionKind
} from '$lib/permissions/metadata';
import {
	summarizeGitCommitPermission,
	type GitCommitTargetSnapshot
} from '$lib/permissions/git-commit';
import {
	summarizeTemplatePermission,
	templateBeforeSnapshot,
	type TemplateBeforeSnapshot
} from '$lib/permissions/prompt-template';
import * as promptTemplatesRepo from '../db/repos/prompt-templates';
import { getLease } from '../leases';
import {
	createShadowRecorder,
	type ShadowHandle,
	type ShadowRecorder
} from '../permissions/adversary/shadow';
import type { ShadowResolutionSource } from '../db/repos/shadow-decisions';
import type { ToolPermissionRequest } from '../tools/types';
import { checkWorkspaceFileGate } from '../permissions/workspace-file-gate';

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
	args?: unknown;
}

interface InteractiveAdapterOptions {
	conversationId: string;
	userId: string;
	workingDirectory: string;
	/**
	 * Every root the conversation may write inside RIGHT NOW: its workspace plus
	 * any worktree leases it currently holds.
	 *
	 * Deliberately a callback, not a captured value. An orchestrator creates
	 * leases mid-turn, and a lease created during turn N must be auto-allowed
	 * within turn N — a snapshot taken at session establishment would be stale
	 * exactly when it matters. Mirrors `getSessionWorkspacePath`.
	 */
	getWorkspaceRoots(): string[];
	policy: PermissionPolicy;
	emit(ev: PortalEvent): void;
	/**
	 * The conversation's approval mode, read live so a mid-turn PATCH takes
	 * effect on the next request rather than at the next session open.
	 *
	 * Because this is one 3-way enum rather than two overlapping booleans,
	 * `auto-approve` and `auto-deny` are mutually exclusive by construction —
	 * they can no longer race on evaluation order the way `approveAllTools`
	 * and the old `best-effort` mode did.
	 */
	getApprovalMode(): ApprovalMode;
	getSessionWorkspacePath(): string | null;
	getPermissionBehavior(tool: string): 'normal' | 'always-prompt' | 'never-prompt';
	/**
	 * The conversation's agent model and backend, if the provider knows them.
	 * Read only by the Phase 0 adversary shadow, which refuses to run when the
	 * reviewer is the same model on the same backend, and which defaults the
	 * reviewer's backend to the agent's.
	 */
	getAgentModel?: (() => string | null) | undefined;
	getAgentBackend?: (() => string | null) | undefined;
	/**
	 * The conversation's effective adversary (shadow reviewer) model and the
	 * backend that should serve it, or null to fall back to the server default.
	 * Captured at session open; see `ProviderOpenOptions.adversaryModel` for why
	 * they need no live setter.
	 */
	getAdversaryModel?: (() => string | null) | undefined;
	getAdversaryBackend?: (() => string | null) | undefined;
	/**
	 * Records what a second model *would* have decided about each prompt-worthy
	 * request, with no authority over the outcome. Injected so tests can supply
	 * a deterministic recorder; production wires the real one below.
	 */
	shadowRecorder?: ShadowRecorder | undefined;
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
	// One recorder per session so its per-request memo cache is scoped to this
	// conversation. Inert (returns null from every `observe`) unless an
	// adversary model is configured for this conversation, the user, or the
	// server — a configured model is what turns the shadow on.
	const shadowRecorder =
		opts.shadowRecorder ??
		createShadowRecorder({
			getModel: () => opts.getAdversaryModel?.() ?? null,
			getBackend: () => opts.getAdversaryBackend?.() ?? null,
			userId: opts.userId
		});
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

	// Result of the evaluation phase of a permission request. `prompt` is
	// returned when a human dialog is required; it carries the dialog view plus
	// a `finalize` that settles the decision once the human answers.
	// `evaluatePermissionRequest` never prompts — it backs both `decideCore`
	// (which raises the dialog) and the claude-agent provider's PreToolUse
	// hook, which returns `permissionDecision: 'ask'` on the `prompt` case so
	// the SDK's own permission flow (and its unbounded `canUseTool` wait) owns
	// the human prompt.
	type PermissionEvaluation =
		| { kind: 'approve-once' }
		| { kind: 'reject'; feedback?: string }
		| {
				kind: 'prompt';
				view: InteractivePermissionView;
				/**
				 * Adversary-shadow population for this prompt; `null` for dialogs
				 * that are deliberately never shadowed (`always-prompt`).
				 */
				shadowSource: 'prompt-grant' | 'prompt-policy' | null;
				observeShadow: (source: 'prompt-grant' | 'prompt-policy') => ShadowHandle | null;
				finalize: (
					response: Extract<InteractiveResponse, { kind: 'permission' }>,
					shadow: ShadowHandle | null
				) => { kind: 'approve-once' } | { kind: 'reject'; feedback?: string };
		  };

	const evaluatePermissionRequest = async (
		req: PermissionRequestLike,
		imagePreview?: ImagePreview
	): Promise<PermissionEvaluation> => {
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
		// Resolved before the summary because a `git_commit` into a lease lands in
		// a different checkout and branch than this conversation's workspace, and
		// nothing else in the request says so — not the summary, not the audit row.
		const commitTarget =
			tool === 'git_commit'
				? loadCommitTargetSnapshot(req.args, opts.userId, opts.conversationId)
				: undefined;
		const summary = summarizePermissionRequest(scopeRequest, tool, commitTarget);
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

		// Checked-in workspace permissions (.zap/permissions.toml):
		// fire-and-forget, hash-gated import check. Never influences THIS
		// decision — the last human-approved state stays active until the
		// drifted file is approved — so any failure here is logged, not thrown.
		try {
			checkWorkspaceFileGate({
				userId: opts.userId,
				conversationId: opts.conversationId,
				workspaceRoot: opts.getWorkspaceRoots()[0] ?? null,
				emit: opts.emit
			});
		} catch (e) {
			log.warn('copilot.workspace_permissions_gate_failed', {
				conversationId: opts.conversationId,
				err: String(e)
			});
		}

		// A token minted when this exact request was previously denied and then
		// approved through `force_retry_tool` makes the retry the strongest
		// signal: the human explicitly approved THIS call, so it overrides
		// every auto-allow and auto-deny path that follows (arg-schema and
		// shell-misuse guards, `never-prompt`, `always-prompt`, grants
		// including hard denies, approval mode, and policy). Consumed
		// one-shot — a third identical request is denied again.
		const forcedApproval = consumeForcedRetryMatch({
			conversationId: opts.conversationId,
			tool,
			permissionKind,
			scopeKey,
			argsHash: hash
		});
		if (forcedApproval) {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}

		// Every denial below mints a one-shot forced-retry token bound to this
		// exact request and embeds the hint in the feedback the agent sees, so
		// any denial can be escalated via `force_retry_tool` — including a
		// human denying a normal dialog. Approving that tool is what flips the
		// matching retry to auto-allow above.
		const deny = (feedback?: string): { kind: 'reject'; feedback?: string } => {
			const token = mintForcedRetry({
				conversationId: opts.conversationId,
				tool,
				permissionKind,
				scopeKey,
				argsHash: hash,
				summary,
				args: req.args ?? null,
				deniedFeedback: feedback ?? null
			});
			return {
				kind: 'reject',
				feedback: withForceRetryHint(feedback ?? 'Permission denied.', token)
			};
		};

		// Compute shell analysis up front so it can be surfaced in any
		// permission dialog. detectShellMisuse auto-rejects the request (a
		// forced retry can still reach a human via `force_retry_tool`, which
		// shows the misuse reason as the dialog's defaultDenyFeedback).
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

		// Phase 0 adversary shadow. Strictly observational: it records what a
		// second model would have decided, so adversary-deny precision/recall
		// can be measured before the idea is ever given authority. It cannot
		// allow, deny, or delay anything, and the call is fire-and-forget.
		//
		// Note what is NOT handed over: `summary` is excluded because
		// `summarizePermissionRequest` falls back to `req.toolDescription` —
		// model-authored narration wearing a portal-derived field's clothes.
		const observeShadow = (resolutionSource: ShadowResolutionSource) =>
			shadowRecorder.observe({
				conversationId: opts.conversationId,
				tool,
				permissionKind,
				scopeKey,
				argsHash: hash,
				fsTargets: evalTargets,
				shellSegments,
				shellUnsafeReason: shellAnalysis?.kind === 'unsafe' ? shellAnalysis.reason : null,
				commitTarget: commitTarget ?? null,
				workspaceRoots: opts.getWorkspaceRoots(),
				workingDirectory: opts.workingDirectory,
				args: req.args,
				resolutionSource,
				agentModel: opts.getAgentModel?.() ?? null,
				agentBackend: opts.getAgentBackend?.() ?? null
			});

		// Per-target decision, distinguishing an explicit grant outcome (which
		// the conversation's `auto-approve` approval mode must NOT override)
		// from a policy-level outcome (which it may). `prompt-grant` is also
		// non-persistable.
		type TargetEval =
			| { kind: 'allow' }
			| { kind: 'deny'; feedback?: string | undefined }
			| { kind: 'prompt-grant'; feedback?: string | undefined }
			| { kind: 'prompt-policy'; feedback?: string | undefined };
		const evalRank = { allow: 0, 'prompt-policy': 1, 'prompt-grant': 2, deny: 3 } as const;

		// Mirrors the original single-path ordering exactly: explicit grant
		// first (allow/deny/prompt), then `auto-approve`, then policy.
		let approvalModeAllowed = false;
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
					workspaceRoots: opts.getWorkspaceRoots(),
					sessionWorkspaceRoot: opts.getSessionWorkspacePath(),
					// The shell's cwd — deliberately the conversation's working
					// directory, NOT `getSessionWorkspacePath()`. Those are different
					// places: the SDK "session workspace" is its infinite-session
					// state dir (~/.copilot/session-state/<id>), while shell commands
					// run in the checkout. Resolving `cat README.md` against the
					// former would check a different file than the one the shell
					// opens — and could approve it, since that dir is itself readable.
					shellCwd: opts.workingDirectory,
					argsHash: hash
				}
			);
			if (g.outcome === 'allow') return { kind: 'allow' };
			if (g.outcome === 'deny') return { kind: 'deny', feedback: g.feedback ?? undefined };
			if (g.outcome === 'prompt') {
				return { kind: 'prompt-grant', feedback: g.feedback ?? undefined };
			}
			if (opts.getApprovalMode() === 'auto-approve') {
				// Remembered so the shadow can label this row's population
				// correctly: an allow that ONLY happened because the
				// conversation is in `auto-approve` is exactly the population a
				// future veto product would gate. A request the policy would
				// have allowed anyway is not — it would have been auto-allowed
				// in `ask` too — so the policy is consulted here purely to keep
				// those out of the sample. It cannot change the outcome.
				if (
					decideByPolicy(opts.policy, 'permission', permissionKind, {
						scopeKey: key,
						workspaceRoots: opts.getWorkspaceRoots()
					}) !== 'approved'
				) {
					approvalModeAllowed = true;
				}
				return { kind: 'allow' };
			}
			// `none` carries no grant decision, but the matcher may still have
			// explained why an allow grant declined — e.g. a shell rule that
			// defers to the fs grants naming the permission the path lacked.
			// Without this the prompt would report a generic (and for such rules,
			// wrong) workspace-boundary reason.
			const nearMiss = g.feedback ?? undefined;
			const decision = decideByPolicy(opts.policy, 'permission', permissionKind, {
				scopeKey: key,
				workspaceRoots: opts.getWorkspaceRoots()
			});
			if (decision === 'approved') return { kind: 'allow' };
			if (decision === 'denied') return { kind: 'deny', feedback: nearMiss };
			return { kind: 'prompt-policy', feedback: nearMiss };
		};

		// Combine per-target evaluations most-restrictively. Memoized so a
		// deny/prompt path can reuse a target's feedback without paying for a
		// second lookup on the main path.
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

		// Schema-validate custom portal tool args before any permission
		// dialog or grant matching. Args that don't match the tool's
		// declared schema are an agent bug, not something the user
		// should approve; rejecting here with the schema in the
		// feedback lets the agent self-correct on the next turn. A forced
		// retry still reaches a human, which is why the deny below mints a
		// token rather than silently discarding the request.
		//
		// This applies to CUSTOM tool requests only. A request that already
		// carries a filesystem kind (read/write/edit) is a runtime builtin
		// tool (e.g. the Copilot runtime's `edit`) being evaluated as an fs
		// permission on `path`; its args are the runtime's, not a portal
		// tool's, so validating them against a same-named portal tool would
		// falsely reject a legitimate call (and let an out-of-workspace path
		// sneak past the fs auto-deny below). Portal fs tools themselves send
		// kind `custom-tool` (the runtime doesn't know they are fs tools), so
		// they still get schema-validated here and then overridden to an fs
		// kind by `derivePermissionRequest` above.
		if (
			req.toolName &&
			opts.validateCustomToolArgs &&
			!isFilesystemPermissionKind(req.kind ?? '')
		) {
			const invalid = opts.validateCustomToolArgs(req.toolName, req.args);
			if (invalid) {
				audit('auto-deny');
				return deny(invalid.feedback);
			}
		}
		if (neverPrompt) {
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		if (shellMisuse) {
			audit('auto-deny');
			return deny(shellMisuse.feedback);
		}

		if (alwaysPrompt) {
			const templateBefore =
				tool === 'template_update'
					? loadTemplateBeforeSnapshot(req.args, opts.userId, opts.conversationId)
					: undefined;
			return {
				kind: 'prompt' as const,
				// `always-prompt` dialogs are deliberately NOT shadowed (an
				// adversary could never settle them) and are audited as
				// auto-allows once the human approves.
				shadowSource: null,
				observeShadow,
				view: {
					kind: 'permission',
					tool,
					permissionKind,
					summary,
					args: req.args ?? null,
					userPolicy: opts.policy,
					canPersistDecision: false,
					shellAnalysis,
					imagePreview,
					...(templateBefore !== undefined ? { templateBefore } : {}),
					...(commitTarget !== undefined ? { commitTarget } : {})
				},
				finalize: (response) => {
					if (response.decision === 'deny' || response.decision === 'deny-always') {
						return deny(denyFeedbackOf(response));
					}
					audit('auto-allow');
					return { kind: 'approve-once' } as const;
				}
			};
		}
		const evaluation = getEval();
		if (evaluation.kind === 'allow') {
			// Requests that `auto-approve` waved through are the population an
			// eventual veto product would actually gate, so they are shadowed
			// too. They get NO human label (nobody was asked), which means the
			// scorer excludes them — deliberately. They are collected because
			// the request is unrecoverable after the fact and can be
			// adjudicated later; scoring them was never the point.
			if (approvalModeAllowed) observeShadow('auto-approve');
			audit('auto-allow');
			return { kind: 'approve-once' } as const;
		}
		if (evaluation.kind === 'deny') {
			audit('auto-deny');
			return deny(evaluation.feedback);
		}
		let promptRequest: {
			canPersistDecision: boolean;
			autoDenyFeedback: string;
			defaultDenyFeedback?: string | undefined;
		};
		if (evaluation.kind === 'prompt-grant') {
			promptRequest = {
				canPersistDecision: false,
				autoDenyFeedback: evaluation.feedback ?? autoDenyPromptGrantFeedback({ permissionKind }),
				defaultDenyFeedback: evaluation.feedback
			};
		} else {
			// prompt-policy: `auto-approve` (applied per-target in
			// evaluateTarget) didn't short-circuit, so a human prompt is needed.
			// A single-target policy prompt is persistable as a grant; a
			// multi-target request can't be captured by one stored scope, so
			// persistence is disabled.
			promptRequest = {
				canPersistDecision: !isMultiTarget,
				autoDenyFeedback: evaluation.feedback
					? `${autoDenyPermissionFeedback({ permissionKind })} ${evaluation.feedback}`
					: autoDenyPermissionFeedback({ permissionKind }),
				defaultDenyFeedback: evaluation.feedback
			};
		}

		// The approval mode is a single enum, so `auto-approve` and `auto-deny`
		// cannot both apply: an `auto-approve` conversation already returned
		// above as `evaluation.kind === 'allow'`, and only `auto-deny` reaches
		// here. That exclusivity used to be an accident of evaluation order
		// between the approve-all toggle and `best-effort` mode.
		//
		// `always-prompt` tools (notably `request_permission_grant`) were
		// dispatched to a dialog before this point — so auto-deny never
		// suppresses a prompt that is meant to always reach a human. It simply
		// rejects the remaining prompt-worthy requests with actionable feedback.
		if (opts.getApprovalMode() === 'auto-deny') {
			audit('auto-prompt-required');
			return deny(promptRequest.autoDenyFeedback);
		}

		// Phase 0 adversary shadow; see `observeShadow` above. Strictly
		// observational — the prompt below is raised and awaited identically
		// whether or not the adversary ever responds.
		return {
			kind: 'prompt' as const,
			shadowSource: evaluation.kind === 'prompt-grant' ? 'prompt-grant' : 'prompt-policy',
			observeShadow,
			view: {
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
			},
			finalize: (response, shadow) => {
				// Only a real answer produces a label. A cancelled or expired
				// prompt throws out of `askInteractive`, leaving `human_decision`
				// NULL, which the scorer excludes rather than counting as a denial.
				shadow?.recordHuman(response.decision);
				if (response.decision === 'deny' || response.decision === 'deny-always') {
					return deny(denyFeedbackOf(response));
				}
				return { kind: 'approve-once' } as const;
			}
		};
	};

	// Inner decision logic: evaluate, and when a human dialog is required,
	// raise and await it. Wrapped by `onPermissionRequest` (below) so a prompt
	// that is cancelled out from under us (turn abort, timeout, client
	// disconnect, or capacity eviction) is reported to the SDK as
	// "user-not-available" rather than a user denial.
	const decideCore = async (req: PermissionRequestLike, imagePreview?: ImagePreview) => {
		const evaluation = await evaluatePermissionRequest(req, imagePreview);
		if (evaluation.kind !== 'prompt') return evaluation;
		// The shadow observation fires BEFORE the prompt is raised — a cancelled
		// prompt still leaves its row behind with `human_decision` NULL.
		const shadow = evaluation.shadowSource
			? evaluation.observeShadow(evaluation.shadowSource)
			: null;
		const response = await askInteractive<Extract<InteractiveResponse, { kind: 'permission' }>>(
			'permission',
			evaluation.view
		);
		return evaluation.finalize(response, shadow);
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
		// No cancellation catch here on purpose. If the prompt is abandoned (turn
		// aborted, timed out, client disconnected, or backing session evicted),
		// `askInteractive` throws an `InteractivePromptCancelledError` which we let
		// propagate. Unlike permissions, the SDK's user-input handler has no
		// `user-not-available` sentinel — its only return shape is an answer.
		// Returning an empty string would be read as the user supplying `''`, so
		// the model proceeds on phantom input (e.g. using `""` as a
		// filename/command) and wastes tokens; rethrowing lets the SDK abort the
		// tool call instead. The cancellation is already audited and broadcast as
		// an `interactive.resolved` event by the registry.
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
		evaluatePermissionRequest,
		onUserInputRequest,
		onElicitationRequest,
		onExitPlanMode,
		onAutoModeSwitch
	};
}

function denyFeedbackOf(
	response: Extract<InteractiveResponse, { kind: 'permission' }>
): string | undefined {
	const feedback = response.feedback?.trim();
	return feedback || undefined;
}

function hashPermissionArgs(req: PermissionRequestLike): string | null {
	if (typeof req.toolCallId === 'string') {
		const args = messagesRepo.getToolCallArgs(req.toolCallId);
		if (args !== null) return argsHash(args);
	}
	if (req.args !== undefined) return argsHash(req.args);
	return null;
}

function autoDenyPermissionFeedback(view: { permissionKind: string }): string {
	const alternative = autoDenyAlternativeHint(view.permissionKind);
	const kind = permissionKindLabel(view.permissionKind);
	return (
		`A ${kind} permission request was auto-rejected because this conversation's approval mode is \`auto-deny\`. ` +
		`${alternative} Use \`permission_capabilities\` to inspect alternatives. If still blocked after verifying no allowed alternative works, retry the exact call with \`force_retry_tool\` (the token is attached to this denial) for this one-off unblock; only reach for \`request_permission_grant\` when you want a durable, saved rule.`
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

function summarizePermissionRequest(
	req: PermissionRequestLike,
	tool: string,
	commitTarget?: GitCommitTargetSnapshot | undefined
): string {
	if (tool === 'git_commit') {
		const summary = summarizeGitCommitPermission(req.args, commitTarget ?? null);
		if (summary) return summary;
	}
	if (tool === 'template_create' || tool === 'template_update') {
		const summary = summarizeTemplatePermission(tool, req.args);
		if (summary) return summary;
	}
	return req.fullCommandText ?? req.fileName ?? req.path ?? req.url ?? req.toolDescription ?? tool;
}

/**
 * Resolve a `git_commit` request's `worktree` lease id into what the dialog
 * needs to name the destination: label, branch, and checkout path.
 *
 * Strictly read-only, and scoped to leases held by THIS conversation — the same
 * check the tool itself enforces, so the dialog cannot be used to probe another
 * conversation's leases. A lease id that does not resolve still yields a
 * snapshot carrying the raw id: the call will fail, but the human should see
 * that a worktree was targeted rather than assume the commit lands locally.
 */
function loadCommitTargetSnapshot(
	args: unknown,
	userId: string,
	conversationId: string
): GitCommitTargetSnapshot | undefined {
	if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
	const raw = (args as Record<string, unknown>).worktree;
	if (typeof raw !== 'string') return undefined;
	// Normalized exactly as the tool's own schema normalizes it. Resolving the
	// raw value instead would let `"  <id>  "` render as an unresolved id — which
	// reads like the "lease you don't hold" case — while the handler trims it and
	// commits into the real worktree.
	const leaseId = raw.trim();
	if (leaseId.length === 0) return undefined;
	try {
		const lease = getLease(leaseId, userId);
		if (!lease || lease.heldByConversationId !== conversationId) return { leaseId };
		return { leaseId, label: lease.label, branch: lease.branch, path: lease.path };
	} catch (e) {
		log.warn('copilot.commit_target_load_failed', { conversationId, err: String(e) });
		return { leaseId };
	}
}

/**
 * Load a read-only snapshot of the existing template targeted by a
 * `template_update` so the permission dialog can show a merged before→after
 * view. Strictly read-only (no DB writes); returns `undefined` for a missing
 * id, a missing/deleted template, or any lookup error, in which case the dialog
 * falls back to the patch view.
 */
function loadTemplateBeforeSnapshot(
	args: unknown,
	userId: string,
	conversationId: string
): TemplateBeforeSnapshot | undefined {
	if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
	const id = (args as Record<string, unknown>).id;
	if (typeof id !== 'string' || id.length === 0) return undefined;
	try {
		const tpl = promptTemplatesRepo.get(id, userId);
		return tpl ? templateBeforeSnapshot(tpl) : undefined;
	} catch (e) {
		log.warn('copilot.template_before_load_failed', {
			conversationId,
			err: String(e)
		});
		return undefined;
	}
}
