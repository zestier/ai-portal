export interface TemplatePermissionField {
	label: string;
	value: string;
}

export interface TemplatePermissionPreview {
	action: 'create' | 'update';
	id: string | null;
	title: string | null;
	type: string | null;
	description: string | null;
	launchBehavior: string | null;
	conversationMode: string | null;
	model: string | null;
	pinned: boolean | null;
	status: string | null;
	prompt: string | null;
	promptLineCount: number;
	fields: TemplatePermissionField[];
}

const TEMPLATE_TOOLS = new Set(['template_create', 'template_update']);

export function templatePermissionPreview(
	tool: string,
	args: unknown
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
	push('Model', model);
	if (pinned !== null) push('Pinned', pinned ? 'yes' : 'no');
	push('Status', status);

	return {
		action,
		id,
		title,
		type,
		description,
		launchBehavior,
		conversationMode,
		model,
		pinned,
		status,
		prompt,
		promptLineCount,
		fields
	};
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
