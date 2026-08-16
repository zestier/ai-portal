import { z } from 'zod';
import * as templates from '../db/repos/prompt-templates';
import {
	BUILT_IN_PROMPT_TEMPLATES,
	TICKET_ACTION_DEFAULTS,
	placeholdersForType
} from '$lib/prompt-templates';
import {
	APPROVAL_MODES,
	PROMPT_TEMPLATE_TYPES,
	SESSION_MODES,
	type ChatPromptTemplate
} from '$lib/types';
import { PORTAL_TOOL_GROUP_IDS } from '$lib/tools/groups';
import { err, ok, type PortalTool } from './types';
import { project, withOmitted, normalizeFieldSelector, FieldsArg, FIELDS_PARAM } from './project';

// Model-relevant template fields kept in the compact default. Provenance
// timestamps and `userId` are dropped (recoverable via the `fields` selector);
// type-only ticket-action metadata stays because it governs launch behavior.
const TEMPLATE_KEEP = [
	'id',
	'type',
	'title',
	'description',
	'prompt',
	'systemPrompt',
	'appendSystemPrompt',
	'launchBehavior',
	'conversationMode',
	'approvalMode',
	'model',
	'disabledToolGroups',
	'workspaceMode',
	'status',
	'pinned'
] as const;

const Type = z.enum(['chat', 'ticket-action']);
const Status = z.enum(['open', 'archived']);
const LaunchBehavior = z.enum(['send', 'draft', 'review']);
const ConversationMode = z.enum(SESSION_MODES);
const ApprovalModeArg = z.enum(APPROVAL_MODES);
const ToolGroupId = z.enum(PORTAL_TOOL_GROUP_IDS as unknown as [string, ...string[]]);
const WorkspaceMode = z.enum(['shared', 'worktree']);

const WORKSPACE_MODE_DESCRIPTION = '"shared" | "worktree" for launched chats. Omit/null = shared.';

const APPROVAL_MODE_DESCRIPTION =
	'"ask" | "auto-approve" | "auto-deny" for launched chats. Omit/null = user default.';

const ListArgs = z
	.object({
		status: z.enum(['open', 'archived', 'all']).optional().default('open'),
		type: Type.optional(),
		limit: z.number().int().min(1).max(50).optional().default(20),
		fields: FieldsArg
	})
	.optional()
	.default({});

const GetArgs = z.object({
	id: z.string().min(1),
	fields: FieldsArg
});

const CreateArgs = z.object({
	type: Type.optional().default('chat'),
	title: z.string().trim().min(1).max(200),
	description: z.string().trim().max(2000).optional(),
	prompt: z.string().trim().min(1).max(100000),
	systemPrompt: z.string().trim().max(100000).nullable().optional(),
	appendSystemPrompt: z.string().trim().max(100000).nullable().optional(),
	launchBehavior: LaunchBehavior.optional(),
	conversationMode: ConversationMode.nullable().optional(),
	approvalMode: ApprovalModeArg.nullable().optional(),
	model: z.string().trim().max(200).nullable().optional(),
	disabledToolGroups: z.array(ToolGroupId).optional(),
	workspaceMode: WorkspaceMode.nullable().optional(),
	pinned: z.boolean().optional()
});

const UpdateArgs = z
	.object({
		id: z.string().min(1),
		title: z.string().trim().min(1).max(200).optional(),
		description: z.string().trim().max(2000).optional(),
		prompt: z.string().trim().min(1).max(100000).optional(),
		systemPrompt: z.string().trim().max(100000).nullable().optional(),
		appendSystemPrompt: z.string().trim().max(100000).nullable().optional(),
		launchBehavior: LaunchBehavior.optional(),
		conversationMode: ConversationMode.nullable().optional(),
		approvalMode: ApprovalModeArg.nullable().optional(),
		model: z.string().trim().max(200).nullable().optional(),
		disabledToolGroups: z.array(ToolGroupId).optional(),
		workspaceMode: WorkspaceMode.nullable().optional(),
		status: Status.optional(),
		pinned: z.boolean().optional()
	})
	.refine(
		(a) =>
			a.title !== undefined ||
			a.description !== undefined ||
			a.prompt !== undefined ||
			a.systemPrompt !== undefined ||
			a.appendSystemPrompt !== undefined ||
			a.launchBehavior !== undefined ||
			a.conversationMode !== undefined ||
			a.approvalMode !== undefined ||
			a.model !== undefined ||
			a.disabledToolGroups !== undefined ||
			a.workspaceMode !== undefined ||
			a.status !== undefined ||
			a.pinned !== undefined,
		{ message: 'No fields to update' }
	);

function placeholderHint(): string {
	const lines = PROMPT_TEMPLATE_TYPES.map((t) => {
		const allowed = placeholdersForType(t);
		const list = allowed.length ? allowed.map((n) => `{{${n}}}`).join(', ') : 'none';
		return `${t}: ${list}`;
	});
	return `Allowed placeholders by type — ${lines.join('; ')}.`;
}

export function buildPromptTemplateTools(opts: { userId: number }): PortalTool[] {
	return [
		{
			name: 'template_list',
			description: 'List the user\u2019s stored prompt templates (chat + ticket-action).',
			argsSchema: ListArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					status: {
						type: 'string',
						enum: ['open', 'archived', 'all'],
						description: 'Default: open.'
					},
					type: {
						type: 'string',
						enum: ['chat', 'ticket-action'],
						description: 'chat | ticket-action.'
					},
					limit: {
						type: 'number',
						description: '1-50 (default 20).'
					},
					fields: FIELDS_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = ListArgs.parse(args);
				templates.ensureTicketActionDefaults(opts.userId);
				const rows = templates.list(opts.userId, {
					status: parsed.status,
					...(parsed.type ? { type: parsed.type } : {}),
					limit: parsed.limit
				});
				if (rows.length === 0) return ok([], 'No templates.');
				const fields = normalizeFieldSelector(parsed.fields);
				const projected = project(rows, {
					...(fields !== undefined ? { fields } : {}),
					keep: TEMPLATE_KEEP
				});
				return ok(
					withOmitted({ templates: projected.value }, projected.omitted),
					`${rows.length} template(s).`
				);
			}
		},
		{
			name: 'template_get',
			description: 'Read one of the user\u2019s stored prompt templates by id.',
			argsSchema: GetArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Template id.' },
					fields: FIELDS_PARAM
				},
				required: ['id'],
				additionalProperties: false
			},
			async handler(args) {
				const { id, fields: rawFields } = GetArgs.parse(args);
				templates.ensureTicketActionDefaults(opts.userId);
				const tpl = templates.get(id, opts.userId);
				if (!tpl) return err(`Template not found: ${id}`);
				const fields = normalizeFieldSelector(rawFields);
				const projected = project(tpl, {
					...(fields !== undefined ? { fields } : {}),
					keep: TEMPLATE_KEEP
				});
				return ok(
					withOmitted(
						{ ...(projected.value as unknown as Record<string, unknown>) },
						projected.omitted
					)
				);
			}
		},
		{
			name: 'template_builtins',
			description:
				'List the read-only built-in default templates (chat presets + Do/Draft/Refine ' +
				'ticket-action defaults); reference for creating/refining stored templates, not ' +
				'editable.',
			argsSchema: z.object({}).optional().default({}),
			permissionBehavior: 'never-prompt',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			async handler() {
				const chat = BUILT_IN_PROMPT_TEMPLATES.map((t) => ({
					id: t.id,
					type: t.type,
					title: t.title,
					description: t.description,
					prompt: t.prompt
				}));
				const ticketAction = TICKET_ACTION_DEFAULTS.map((d) => ({
					key: d.key,
					type: 'ticket-action',
					title: d.title,
					description: d.description,
					prompt: d.prompt,
					launchBehavior: d.launchBehavior,
					conversationMode: d.conversationMode
				}));
				return ok(
					{ chat, ticketAction },
					`${chat.length + ticketAction.length} built-in default(s).`
				);
			}
		},
		{
			name: 'template_create',
			description: 'Create a new stored prompt template.',
			promptGuidelines: [
				'Validates `{{placeholders}}` by type and rejects unknown ones. ' + placeholderHint()
			],
			argsSchema: CreateArgs,
			permissionBehavior: 'always-prompt',
			parameters: {
				type: 'object',
				properties: {
					type: {
						type: 'string',
						enum: ['chat', 'ticket-action'],
						description: 'Template type. Defaults to chat.'
					},
					title: { type: 'string', description: 'Short template title.' },
					description: { type: 'string', description: 'Optional one-line description.' },
					prompt: {
						type: 'string'
					},
					systemPrompt: {
						type: 'string',
						description: 'Optional Markdown; replaces the default system prompt (persona).'
					},
					appendSystemPrompt: {
						type: 'string',
						description: 'Optional Markdown; appended under the active system prompt.'
					},
					launchBehavior: {
						type: 'string',
						enum: ['send', 'draft', 'review']
					},
					conversationMode: {
						type: 'string',
						enum: [...SESSION_MODES]
					},
					approvalMode: {
						type: 'string',
						enum: [...APPROVAL_MODES],
						description: APPROVAL_MODE_DESCRIPTION
					},
					model: { type: 'string' },
					disabledToolGroups: {
						type: 'array',
						items: { type: 'string', enum: [...PORTAL_TOOL_GROUP_IDS] }
					},
					workspaceMode: {
						type: 'string',
						enum: ['shared', 'worktree', 'ask'],
						description: WORKSPACE_MODE_DESCRIPTION
					},
					pinned: { type: 'boolean', description: 'Pin to the top of its list.' }
				},
				required: ['title', 'prompt'],
				additionalProperties: false
			},
			async handler(args) {
				const p = CreateArgs.parse(args);
				try {
					const tpl = templates.create(opts.userId, {
						type: p.type,
						title: p.title,
						...(p.description !== undefined ? { description: p.description } : {}),
						prompt: p.prompt,
						...(p.systemPrompt !== undefined ? { systemPrompt: p.systemPrompt } : {}),
						...(p.appendSystemPrompt !== undefined
							? { appendSystemPrompt: p.appendSystemPrompt }
							: {}),
						...(p.launchBehavior !== undefined ? { launchBehavior: p.launchBehavior } : {}),
						...(p.conversationMode !== undefined ? { conversationMode: p.conversationMode } : {}),
						...(p.approvalMode !== undefined ? { approvalMode: p.approvalMode } : {}),
						...(p.model !== undefined ? { model: p.model } : {}),
						...(p.disabledToolGroups !== undefined
							? { disabledToolGroups: p.disabledToolGroups }
							: {}),
						...(p.workspaceMode !== undefined ? { workspaceMode: p.workspaceMode } : {}),
						...(p.pinned !== undefined ? { pinned: p.pinned } : {})
					});
					return ok(summarize(tpl), `Created ${tpl.type} template ${tpl.id}: ${tpl.title}`);
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		},
		{
			name: 'template_update',
			description: 'Update one of the user\u2019s stored prompt templates.',
			promptGuidelines: [
				'`status: "archived"` soft-deletes (reversible; no hard delete). Built-ins not editable.'
			],
			argsSchema: UpdateArgs,
			permissionBehavior: 'always-prompt',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Template id.' },
					title: { type: 'string', description: 'New title.' },
					description: { type: 'string', description: 'New description.' },
					prompt: {
						type: 'string'
					},
					systemPrompt: {
						type: 'string',
						description:
							'Optional Markdown; replaces the default system prompt (persona). Pass null to clear.'
					},
					appendSystemPrompt: {
						type: 'string',
						description:
							'Optional Markdown; appended under the active system prompt. Pass null to clear.'
					},
					launchBehavior: {
						type: 'string',
						enum: ['send', 'draft', 'review']
					},
					conversationMode: {
						type: 'string',
						enum: [...SESSION_MODES]
					},
					approvalMode: {
						type: 'string',
						enum: [...APPROVAL_MODES],
						description: `New approval mode override: ${APPROVAL_MODE_DESCRIPTION}`
					},
					model: { type: 'string' },
					disabledToolGroups: {
						type: 'array',
						items: { type: 'string', enum: [...PORTAL_TOOL_GROUP_IDS] }
					},
					workspaceMode: {
						type: 'string',
						enum: ['shared', 'worktree', 'ask'],
						description: WORKSPACE_MODE_DESCRIPTION
					},
					status: {
						type: 'string',
						enum: ['open', 'archived'],
						description: 'New status; set "open" to un-archive.'
					},
					pinned: { type: 'boolean', description: 'New pinned state.' }
				},
				required: ['id'],
				additionalProperties: false
			},
			async handler(args) {
				const { id, ...patch } = UpdateArgs.parse(args);
				if (!templates.get(id, opts.userId)) return err(`Template not found: ${id}`);
				try {
					const updated = templates.update(id, opts.userId, patch as templates.UpdateInput);
					if (!updated) return err(`Template not found: ${id}`);
					return ok(summarize(updated), `Updated template ${updated.id}: ${updated.title}`);
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		}
	];
}

function summarize(t: ChatPromptTemplate) {
	return { id: t.id, type: t.type, title: t.title, status: t.status, pinned: t.pinned };
}
