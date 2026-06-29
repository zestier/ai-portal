import { z } from 'zod';
import * as templates from '../db/repos/prompt-templates';
import {
	BUILT_IN_PROMPT_TEMPLATES,
	TICKET_ACTION_DEFAULTS,
	placeholdersForType
} from '$lib/prompt-templates';
import { PROMPT_TEMPLATE_TYPES, type ChatPromptTemplate } from '$lib/types';
import { err, ok, type PortalTool } from './types';
import {
	project,
	withOmitted,
	normalizeFieldSelector,
	FieldsArg,
	FIELDS_PARAM,
	FIELDS_NOTE
} from './project';

// Model-relevant template fields kept in the compact default. Provenance
// timestamps and `userId` are dropped (recoverable via the `fields` selector);
// type-only ticket-action metadata stays because it governs launch behavior.
const TEMPLATE_KEEP = [
	'id',
	'type',
	'title',
	'description',
	'prompt',
	'launchBehavior',
	'conversationMode',
	'model',
	'status',
	'pinned'
] as const;

const Type = z.enum(['chat', 'ticket-action']);
const Status = z.enum(['open', 'archived']);
const LaunchBehavior = z.enum(['send', 'draft']);
const ConversationMode = z.enum(['interactive', 'plan', 'autopilot', 'best-effort']);

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
	launchBehavior: LaunchBehavior.optional(),
	conversationMode: ConversationMode.nullable().optional(),
	model: z.string().trim().max(200).nullable().optional(),
	pinned: z.boolean().optional()
});

const UpdateArgs = z
	.object({
		id: z.string().min(1),
		title: z.string().trim().min(1).max(200).optional(),
		description: z.string().trim().max(2000).optional(),
		prompt: z.string().trim().min(1).max(100000).optional(),
		launchBehavior: LaunchBehavior.optional(),
		conversationMode: ConversationMode.nullable().optional(),
		model: z.string().trim().max(200).nullable().optional(),
		status: Status.optional(),
		pinned: z.boolean().optional()
	})
	.refine(
		(a) =>
			a.title !== undefined ||
			a.description !== undefined ||
			a.prompt !== undefined ||
			a.launchBehavior !== undefined ||
			a.conversationMode !== undefined ||
			a.model !== undefined ||
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

export function buildPromptTemplateTools(opts: { userId: string }): PortalTool[] {
	return [
		{
			name: 'template_list',
			description:
				'List the current user\u2019s stored prompt templates (chat + ticket-action). ' +
				'Use this when the task is to review or refine the persisted templates. ' +
				FIELDS_NOTE,
			argsSchema: ListArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					status: {
						type: 'string',
						enum: ['open', 'archived', 'all'],
						description: 'Template status to list. Defaults to open.'
					},
					type: {
						type: 'string',
						enum: ['chat', 'ticket-action'],
						description: 'Filter by template type. Omit for both.'
					},
					limit: {
						type: 'number',
						description: 'Maximum templates to return, 1-50. Defaults to 20.'
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
			description: 'Read one of the user\u2019s stored prompt templates by id. ' + FIELDS_NOTE,
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
				'ticket-action defaults). Use these as a reference when creating or refining stored ' +
				'templates; they cannot be edited directly. ' +
				placeholderHint(),
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
			description:
				'Create a new stored prompt template for the user. Validates `{{placeholders}}` ' +
				'by type and rejects unknown ones. ' +
				placeholderHint(),
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
						type: 'string',
						description: 'The prompt body. Placeholders validated by type.'
					},
					launchBehavior: {
						type: 'string',
						enum: ['send', 'draft'],
						description: 'ticket-action only: send immediately or pre-fill a draft. Default send.'
					},
					conversationMode: {
						type: 'string',
						enum: ['interactive', 'plan', 'autopilot', 'best-effort'],
						description: 'ticket-action only: conversation mode override.'
					},
					model: { type: 'string', description: 'ticket-action only: model override.' },
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
						...(p.launchBehavior !== undefined ? { launchBehavior: p.launchBehavior } : {}),
						...(p.conversationMode !== undefined ? { conversationMode: p.conversationMode } : {}),
						...(p.model !== undefined ? { model: p.model } : {}),
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
			description:
				'Update one of the user\u2019s stored prompt templates. Set `status` to "archived" to ' +
				'soft-delete it (reversible by setting it back to "open"); there is no hard delete. ' +
				'Built-in defaults are not editable. Validates placeholders by type and rejects unknown ' +
				'ones. ' +
				placeholderHint(),
			argsSchema: UpdateArgs,
			permissionBehavior: 'always-prompt',
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Template id.' },
					title: { type: 'string', description: 'New title.' },
					description: { type: 'string', description: 'New description.' },
					prompt: {
						type: 'string',
						description: 'New prompt body. Placeholders validated by type.'
					},
					launchBehavior: {
						type: 'string',
						enum: ['send', 'draft'],
						description: 'ticket-action only: new launch behavior.'
					},
					conversationMode: {
						type: 'string',
						enum: ['interactive', 'plan', 'autopilot', 'best-effort'],
						description: 'ticket-action only: new conversation mode override.'
					},
					model: { type: 'string', description: 'ticket-action only: new model override.' },
					status: {
						type: 'string',
						enum: ['open', 'archived'],
						description: 'New status. Set to open to un-archive a previously archived template.'
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
