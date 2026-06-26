import { z } from 'zod';
import * as tickets from '../db/repos/tickets';
import type { UpdateInput } from '../db/repos/tickets';
import { err, ok, type PortalTool } from './types';
import {
	project,
	withOmitted,
	normalizeFieldSelector,
	FieldsArg,
	FIELDS_PARAM,
	FIELDS_NOTE
} from './project';

// Model-relevant ticket fields; provenance ids and timestamps are dropped from
// the compact default and recoverable via the `fields` selector.
const TICKET_KEEP = ['id', 'title', 'body', 'status'] as const;

const Status = z.enum(['open', 'done', 'archived']);

const AddArgs = z.object({
	title: z.string().trim().min(1).max(200),
	body: z.string().trim().max(8000).optional()
});

const ListArgs = z
	.object({
		status: z.enum(['open', 'done', 'archived', 'all']).optional().default('open'),
		limit: z.number().int().min(1).max(50).optional().default(20),
		fields: FieldsArg
	})
	.optional()
	.default({});

const UpdateArgs = z
	.object({
		id: z.string().min(1),
		title: z.string().trim().min(1).max(200).optional(),
		body: z.string().trim().max(8000).optional(),
		status: Status.optional()
	})
	.refine(
		(args) => args.title !== undefined || args.body !== undefined || args.status !== undefined,
		{
			message: 'No fields to update'
		}
	);

const GetArgs = z.object({
	id: z.string().min(1),
	fields: FieldsArg
});

export function buildTicketTools(opts: {
	userId: string;
	workspaceKey: string;
	conversationId: string;
}): PortalTool[] {
	return [
		{
			name: 'ticket_add',
			description:
				'Add a durable workspace ticket for something the user wants to do later. Use when asked to add a ticket, remember a task, or stash follow-up work between sessions.',
			argsSchema: AddArgs,
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Short ticket title.' },
					body: { type: 'string', description: 'Optional details, notes, or acceptance criteria.' }
				},
				required: ['title'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = AddArgs.parse(args);
				const ticket = tickets.create(opts.userId, {
					workspaceKey: opts.workspaceKey,
					title: parsed.title,
					body: parsed.body,
					sourceConversationId: opts.conversationId
				});
				return ok(
					{ id: ticket.id, title: ticket.title, status: ticket.status },
					`Added ticket ${ticket.id}: ${ticket.title}`
				);
			}
		},
		{
			name: 'ticket_list',
			description:
				'List durable workspace tickets for the current workspace. Defaults to open tickets. ' +
				FIELDS_NOTE,
			argsSchema: ListArgs,
			parameters: {
				type: 'object',
				properties: {
					status: {
						type: 'string',
						enum: ['open', 'done', 'archived', 'all'],
						description: 'Ticket status to list. Defaults to open.'
					},
					limit: {
						type: 'number',
						description: 'Maximum tickets to return, 1-50. Defaults to 20.'
					},
					fields: FIELDS_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = ListArgs.parse(args);
				const rows = tickets.list(opts.userId, opts.workspaceKey, parsed);
				if (rows.length === 0) {
					const empty = `No ${parsed.status === 'all' ? '' : `${parsed.status} `}tickets.`;
					return ok(empty, empty);
				}
				const summary = `${rows.length} ticket(s).`;
				// With an explicit `fields` selector, return a structured, projected
				// array (each row trimmed to the requested fields). Without one, keep
				// the dense hand-rendered listing, which is more token-efficient and
				// readable than a projected object array for the common case.
				if (normalizeFieldSelector(parsed.fields) !== undefined) {
					const projected = project(rows, { fields: parsed.fields, keep: TICKET_KEEP });
					return ok(withOmitted({ tickets: projected.value }, projected.omitted), summary);
				}
				const rendered = rows
					.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.body ? `\n  ${t.body}` : ''}`)
					.join('\n');
				return ok(rendered, summary);
			}
		},
		{
			name: 'ticket_get',
			description: 'Read one durable workspace ticket by id. ' + FIELDS_NOTE,
			argsSchema: GetArgs,
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Ticket id.' },
					fields: FIELDS_PARAM
				},
				required: ['id'],
				additionalProperties: false
			},
			async handler(args) {
				const { id, fields } = GetArgs.parse(args);
				const ticket = tickets.get(id, opts.userId);
				if (!ticket || ticket.workspaceKey !== opts.workspaceKey) {
					return err(`Ticket not found: ${id}`);
				}
				const projected = project(ticket, { fields, keep: TICKET_KEEP });
				return ok(
					withOmitted(
						{ ...(projected.value as unknown as Record<string, unknown>) },
						projected.omitted
					)
				);
			}
		},
		{
			name: 'ticket_update',
			description:
				'Update a durable workspace ticket title, body, or status. Use status=done when a ticket has been completed, or archived when it should be hidden without completion.',
			argsSchema: UpdateArgs,
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Ticket id.' },
					title: { type: 'string', description: 'New title.' },
					body: { type: 'string', description: 'New details/body.' },
					status: {
						type: 'string',
						enum: ['open', 'done', 'archived'],
						description: 'New ticket status.'
					}
				},
				required: ['id'],
				additionalProperties: false
			},
			async handler(args) {
				const { id, ...patch } = UpdateArgs.parse(args);
				const current = tickets.get(id, opts.userId);
				if (!current || current.workspaceKey !== opts.workspaceKey) {
					return err(`Ticket not found: ${id}`);
				}
				const updated = tickets.update(id, opts.userId, patch as UpdateInput);
				if (!updated) return err(`Ticket not found: ${id}`);
				return ok(
					{ id: updated.id, title: updated.title, status: updated.status },
					`Updated ticket ${updated.id}: ${updated.title} [${updated.status}]`
				);
			}
		}
	];
}
