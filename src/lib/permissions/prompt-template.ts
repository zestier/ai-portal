export interface TemplatePermissionField {
	label: string;
	value: string;
}

/**
 * Resolved current values of an existing template, loaded read-only server-side
 * and threaded into the permission view so the dialog can render a merged
 * before→after preview for `template_update`. Each field is normalized the same
 * way the patch preview normalizes its args (trimmed strings, `null` = unset).
 */
export interface TemplateBeforeSnapshot {
	title: string | null;
	type: string | null;
	description: string | null;
	launchBehavior: string | null;
	conversationMode: string | null;
	approvalMode: string | null;
	model: string | null;
	pinned: boolean | null;
	status: string | null;
	prompt: string | null;
}

/** A single metadata field rendered as current → proposed in the merged view. */
export interface TemplateFieldChange {
	label: string;
	/** Resolved current value (`null` = unset). */
	before: string | null;
	/** Resolved final value after the edit (`null` = unset). */
	after: string | null;
	changed: boolean;
}

/** The prompt body rendered as current → proposed in the merged view. */
export interface TemplatePromptChange {
	before: string | null;
	after: string | null;
	beforeLineCount: number;
	afterLineCount: number;
	changed: boolean;
}

/**
 * The merged final-values view for `template_update`: what the template will
 * actually look like after the edit, with each field's current and proposed
 * value. Present only when an existing template was loaded for the target id.
 */
export interface TemplateMergedView {
	title: TemplateFieldChange;
	fields: TemplateFieldChange[];
	prompt: TemplatePromptChange;
}

export interface TemplatePermissionPreview {
	action: 'create' | 'update';
	id: string | null;
	title: string | null;
	type: string | null;
	description: string | null;
	launchBehavior: string | null;
	conversationMode: string | null;
	approvalMode: string | null;
	model: string | null;
	pinned: boolean | null;
	status: string | null;
	prompt: string | null;
	promptLineCount: number;
	fields: TemplatePermissionField[];
	/**
	 * Merged before→after view. Non-null only for `template_update` when a
	 * `before` snapshot of the existing template was supplied; otherwise the
	 * dialog falls back to the patch view built from `fields`/`prompt`.
	 */
	merged: TemplateMergedView | null;
}

const TEMPLATE_TOOLS = new Set(['template_create', 'template_update']);

export function templatePermissionPreview(
	tool: string,
	args: unknown,
	before?: TemplateBeforeSnapshot | null
): TemplatePermissionPreview | null {
	if (!TEMPLATE_TOOLS.has(tool)) return null;
	if (!isRecord(args)) return null;

	const action: 'create' | 'update' = tool === 'template_update' ? 'update' : 'create';

	const id = action === 'update' ? optionalString(args.id) : null;
	const title = optionalString(args.title);
	const type = optionalString(args.type) ?? (action === 'create' ? 'chat' : null);
	const description = optionalString(args.description);
	const launchBehavior = optionalString(args.launchBehavior);
	const conversationMode = optionalString(args.conversationMode);
	const approvalMode = optionalString(args.approvalMode);
	const model = optionalString(args.model);
	const status = optionalString(args.status);
	const pinned = typeof args.pinned === 'boolean' ? args.pinned : null;
	const prompt =
		typeof args.prompt === 'string' && args.prompt.trim().length > 0 ? args.prompt : null;
	const promptLineCount = prompt ? prompt.split(/\r\n|\r|\n/).length : 0;

	const fields: TemplatePermissionField[] = [];
	const push = (label: string, value: string | null) => {
		if (value !== null) fields.push({ label, value });
	};
	push('Type', type);
	push('Description', description);
	push('Launch behavior', launchBehavior);
	push('Conversation mode', conversationMode);
	// Always surfaced: this is the one template field that can turn a launched
	// conversation's permission dialogs off (`auto-approve`) or into blanket
	// rejections (`auto-deny`), so it must never be an invisible part of an
	// otherwise innocuous-looking edit the human is asked to approve.
	push('Approvals', approvalMode);
	push('Model', model);
	if (pinned !== null) push('Pinned', pinned ? 'yes' : 'no');
	push('Status', status);

	const merged = action === 'update' && before ? buildMergedView(args, before) : null;

	return {
		action,
		id,
		title,
		type,
		description,
		launchBehavior,
		conversationMode,
		approvalMode,
		model,
		pinned,
		status,
		prompt,
		promptLineCount,
		fields,
		merged
	};
}

/**
 * Map an existing template record to the normalized snapshot the merged view
 * consumes. Accepts a structural shape so this stays free of server imports.
 */
export function templateBeforeSnapshot(tpl: {
	title?: string | null;
	type?: string | null;
	description?: string | null;
	launchBehavior?: string | null;
	conversationMode?: string | null;
	approvalMode?: string | null;
	model?: string | null;
	pinned?: boolean | null;
	status?: string | null;
	prompt?: string | null;
}): TemplateBeforeSnapshot {
	return {
		title: optionalString(tpl.title),
		type: optionalString(tpl.type),
		description: optionalString(tpl.description),
		launchBehavior: optionalString(tpl.launchBehavior),
		conversationMode: optionalString(tpl.conversationMode),
		approvalMode: optionalString(tpl.approvalMode),
		model: optionalString(tpl.model),
		pinned: typeof tpl.pinned === 'boolean' ? tpl.pinned : null,
		status: optionalString(tpl.status),
		prompt: optionalString(tpl.prompt)
	};
}

function buildMergedView(
	args: Record<string, unknown>,
	before: TemplateBeforeSnapshot
): TemplateMergedView {
	// Title can never be cleared: the repo rejects an empty title and otherwise
	// uses `patch.title ?? current.title`, so a null/empty/absent arg keeps current.
	const titleAfter = afterStringKeepCurrent(args, 'title', before.title);
	const title = fieldChange('Title', before.title, titleAfter);

	const fields: TemplateFieldChange[] = [];
	const pushChange = (label: string, beforeVal: string | null, afterVal: string | null) => {
		// "type" is not editable via template_update, so it never changes; we
		// still surface the resolved value so the reviewer sees the full result.
		if (beforeVal === null && afterVal === null) return;
		fields.push(fieldChange(label, beforeVal, afterVal));
	};
	pushChange('Type', before.type, before.type);
	// Description / status mirror the repo's `patch.x ?? current.x`: a null arg
	// keeps the current value rather than clearing it, so don't show a phantom clear.
	pushChange(
		'Description',
		before.description,
		afterStringKeepCurrent(args, 'description', before.description)
	);
	// launchBehavior / conversationMode / model go through the type gate below.
	// NOTE: its premise ("the repo forces them to null for chat templates") no
	// longer holds — `update()` persists all three for both types — so this
	// under-reports those fields on a chat template. Tracked in ticket
	// 01KZ0R9P66GWCQCT713221BF8E; left as-is here because an existing test
	// deliberately pins the current behavior. `approvalMode` below deliberately
	// does NOT use this helper.
	const isTicketAction = before.type === 'ticket-action';
	const afterTicketActionField = (key: string, beforeVal: string | null) =>
		isTicketAction ? afterString(args, key, beforeVal) : beforeVal;
	pushChange(
		'Launch behavior',
		before.launchBehavior,
		afterTicketActionField('launchBehavior', before.launchBehavior)
	);
	pushChange(
		'Conversation mode',
		before.conversationMode,
		afterTicketActionField('conversationMode', before.conversationMode)
	);
	pushChange('Model', before.model, afterTicketActionField('model', before.model));
	// Deliberately NOT gated on the template type: `approval_mode` is persisted
	// for chat templates too, and it is the one field that can silence (or
	// blanket-reject) the permission dialogs of every conversation this template
	// launches. Under-reporting it would let an agent slip it past the human.
	pushChange(
		'Approvals',
		before.approvalMode,
		afterString(args, 'approvalMode', before.approvalMode)
	);
	pushChange(
		'Pinned',
		boolDisplay(before.pinned),
		boolDisplay(afterBool(args, 'pinned', before.pinned))
	);
	pushChange('Status', before.status, afterStringKeepCurrent(args, 'status', before.status));

	const promptAfter = afterPrompt(args, before.prompt);
	const prompt: TemplatePromptChange = {
		before: before.prompt,
		after: promptAfter,
		beforeLineCount: lineCount(before.prompt),
		afterLineCount: lineCount(promptAfter),
		changed: before.prompt !== promptAfter
	};

	return { title, fields, prompt };
}

function fieldChange(
	label: string,
	before: string | null,
	after: string | null
): TemplateFieldChange {
	return { label, before, after, changed: before !== after };
}

/**
 * Resolve a string field's final value: an arg present on the request wins
 * (an explicit `null`/empty clears it); an absent arg keeps the current value.
 */
function afterString(
	args: Record<string, unknown>,
	key: string,
	beforeVal: string | null
): string | null {
	if (!hasOwn(args, key)) return beforeVal;
	return optionalString(args[key]);
}

/**
 * Resolve a string field the update repo can never clear (title, description,
 * status all persist as `patch.x ?? current.x`, and an empty title is rejected).
 * An absent, null, or empty arg keeps the current value; only a non-empty arg
 * replaces it — so the preview never promises a clear that won't be persisted.
 */
function afterStringKeepCurrent(
	args: Record<string, unknown>,
	key: string,
	beforeVal: string | null
): string | null {
	if (!hasOwn(args, key)) return beforeVal;
	return optionalString(args[key]) ?? beforeVal;
}

function afterBool(
	args: Record<string, unknown>,
	key: string,
	beforeVal: boolean | null
): boolean | null {
	if (!hasOwn(args, key)) return beforeVal;
	return typeof args[key] === 'boolean' ? (args[key] as boolean) : beforeVal;
}

function afterPrompt(args: Record<string, unknown>, beforeVal: string | null): string | null {
	if (!hasOwn(args, 'prompt')) return beforeVal;
	// The prompt is required and cannot be cleared; an invalid (empty/whitespace
	// or non-string) value can't take effect, so keep the current body.
	const next =
		typeof args.prompt === 'string' && args.prompt.trim().length > 0 ? args.prompt : null;
	return next ?? beforeVal;
}

function boolDisplay(v: boolean | null): string | null {
	return v === null ? null : v ? 'yes' : 'no';
}

function lineCount(v: string | null): number {
	return v ? v.split(/\r\n|\r|\n/).length : 0;
}

function hasOwn(obj: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

export function summarizeTemplatePermission(tool: string, args: unknown): string | null {
	const preview = templatePermissionPreview(tool, args);
	if (!preview) return null;
	const lines = [preview.action === 'update' ? 'Update prompt template' : 'Create prompt template'];
	if (preview.action === 'update' && preview.id) lines.push(`Template: ${preview.id}`);
	if (preview.title) lines.push(`Title: ${preview.title}`);
	if (preview.type) lines.push(`Type: ${preview.type}`);
	if (preview.description) lines.push(`Description: ${preview.description}`);
	if (preview.launchBehavior) lines.push(`Launch behavior: ${preview.launchBehavior}`);
	if (preview.conversationMode) lines.push(`Conversation mode: ${preview.conversationMode}`);
	if (preview.approvalMode) lines.push(`Approvals: ${preview.approvalMode}`);
	if (preview.model) lines.push(`Model: ${preview.model}`);
	if (preview.pinned !== null) lines.push(`Pinned: ${preview.pinned ? 'yes' : 'no'}`);
	if (preview.status) lines.push(`Status: ${preview.status}`);
	if (preview.promptLineCount > 0) {
		lines.push(
			`Prompt: ${preview.promptLineCount} ${preview.promptLineCount === 1 ? 'line' : 'lines'}`
		);
	}
	lines.push('Approval: one-time only; stored grants are disabled for this tool.');
	return lines.join('\n');
}

function optionalString(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const trimmed = v.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}
