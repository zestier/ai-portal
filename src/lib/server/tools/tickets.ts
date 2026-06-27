import { z } from 'zod';
import * as tickets from '../db/repos/tickets';
import type { UpdateInput } from '../db/repos/tickets';
import type { WorkspaceTicket } from '$lib/types';
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
// the compact default and recoverable via the `fields` selector. `blockedBy`
// (open blockers) and `blocks` (the tickets this one blocks) are part of the
// compact view so ordering is visible on a plain read — they are small, bounded
// id lists — but `withDeps` only attaches them when non-empty, so a ticket with
// no edges shows neither rather than empty arrays.
const TICKET_KEEP = ['id', 'title', 'body', 'status', 'blockedBy', 'blocks'] as const;

// Enrich a ticket with its blocking edges for the agent tools. `blockedBy` is
// the actionable subset (blockers that are still open); `blocks` lists the
// tickets waiting on this one. Each is attached only when non-empty: an empty
// edge list is omitted entirely rather than rendered as `[]`. Both names are in
// TICKET_KEEP, so a `fields` request for either is always valid (never an
// unknown-field error) even on a ticket that currently has no such edges.
function withDeps(ticket: WorkspaceTicket) {
	const blockedBy = tickets.openBlockers(ticket.id);
	const blocks = tickets.listDependents(ticket.id);
	return {
		...ticket,
		...(blockedBy.length ? { blockedBy } : {}),
		...(blocks.length ? { blocks } : {})
	};
}

const Status = z.enum(['open', 'done', 'archived']);

// Edge id lists for `ticket_add`/`ticket_update`. A bounded array of ticket ids.
const EdgeIds = z.array(z.string().trim().min(1)).max(100);

const AddArgs = z.object({
	title: z.string().trim().min(1).max(200),
	body: z.string().trim().max(8000).optional(),
	plan: z.string().trim().max(100000).optional(),
	blockedBy: EdgeIds.optional(),
	blocks: EdgeIds.optional()
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
		plan: z.string().trim().max(100000).optional(),
		status: Status.optional(),
		blockedBy: EdgeIds.optional(),
		blocks: EdgeIds.optional()
	})
	.refine(
		(args) =>
			args.title !== undefined ||
			args.body !== undefined ||
			args.plan !== undefined ||
			args.status !== undefined ||
			args.blockedBy !== undefined ||
			args.blocks !== undefined,
		{
			message: 'No fields to update'
		}
	);

const GetArgs = z.object({
	id: z.string().min(1),
	fields: FieldsArg
});

const BlockArgs = z.object({
	id: z.string().min(1),
	blockedBy: z.string().min(1)
});

const UnblockArgs = z.object({
	id: z.string().min(1),
	blockedBy: z.string().min(1)
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
					body: { type: 'string', description: 'Optional details, notes, or acceptance criteria.' },
					plan: {
						type: 'string',
						description:
							'Optional durable implementation plan / design notes / checklist. Use this ' +
							'(not a scratch markdown file) to persist a worked-out plan with the ticket. ' +
							'Supports `- [ ]` / `- [x]` checklist items for subtasks.'
					},
					blockedBy: {
						type: 'array',
						items: { type: 'string' },
						description:
							'Ids of existing tickets that block this one (must be done first). Lets you ' +
							'create a ticket with its ordering in one call instead of a follow-up ticket_block.'
					},
					blocks: {
						type: 'array',
						items: { type: 'string' },
						description:
							'Ids of existing tickets that this new ticket blocks (the reverse direction).'
					}
				},
				required: ['title'],
				additionalProperties: false
			},
			async handler(args) {
				const parsed = AddArgs.parse(args);
				try {
					const ticket = tickets.create(opts.userId, {
						workspaceKey: opts.workspaceKey,
						title: parsed.title,
						...(parsed.body !== undefined ? { body: parsed.body } : {}),
						...(parsed.plan !== undefined ? { plan: parsed.plan } : {}),
						...(parsed.blockedBy !== undefined ? { blockedBy: parsed.blockedBy } : {}),
						...(parsed.blocks !== undefined ? { blocks: parsed.blocks } : {}),
						sourceConversationId: opts.conversationId
					});
					return ok(
						{ id: ticket.id, title: ticket.title, status: ticket.status },
						`Added ticket ${ticket.id}: ${ticket.title}`
					);
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		},
		{
			name: 'ticket_list',
			description:
				'List durable workspace tickets for the current workspace. Defaults to open tickets. ' +
				'Blocked tickets are annotated with the open tickets blocking them, so a ticket ' +
				'with no such annotation is ready to start. ' +
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
				const fields = normalizeFieldSelector(parsed.fields);
				if (fields !== undefined) {
					const projected = project(rows.map(withDeps), {
						fields,
						keep: TICKET_KEEP
					});
					return ok(withOmitted({ tickets: projected.value }, projected.omitted), summary);
				}
				const rendered = rows
					.map((t) => {
						const blockers = tickets.openBlockers(t.id);
						const blockedNote = blockers.length ? ` (blocked by: ${blockers.join(', ')})` : '';
						return `- ${t.id} [${t.status}] ${t.title}${blockedNote}${t.body ? `\n  ${t.body}` : ''}`;
					})
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
				const { id, fields: rawFields } = GetArgs.parse(args);
				const ticket = tickets.get(id, opts.userId);
				if (!ticket || ticket.workspaceKey !== opts.workspaceKey) {
					return err(`Ticket not found: ${id}`);
				}
				const fields = normalizeFieldSelector(rawFields);
				const projected = project(withDeps(ticket), {
					...(fields !== undefined ? { fields } : {}),
					keep: TICKET_KEEP
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
			name: 'ticket_update',
			description:
				'Update a durable workspace ticket title, body, plan, status, or its blocking edges. Use status=done when a ticket has been completed, or archived when it should be hidden without completion. Use `plan` to persist a worked-out implementation plan or checklist. `blockedBy`/`blocks` replace the complete set of edges on that side (omit to leave unchanged, [] to clear) — a declarative alternative to ticket_block/ticket_unblock.',
			argsSchema: UpdateArgs,
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Ticket id.' },
					title: { type: 'string', description: 'New title.' },
					body: { type: 'string', description: 'New details/body.' },
					plan: {
						type: 'string',
						description:
							'New durable implementation plan / design notes / checklist (replaces the ' +
							'existing plan). Supports `- [ ]` / `- [x]` checklist items for subtasks.'
					},
					status: {
						type: 'string',
						enum: ['open', 'done', 'archived'],
						description: 'New ticket status.'
					},
					blockedBy: {
						type: 'array',
						items: { type: 'string' },
						description:
							'Replace the complete set of tickets this one is blocked by. Omit to leave ' +
							'unchanged; pass [] to clear all blockers.'
					},
					blocks: {
						type: 'array',
						items: { type: 'string' },
						description:
							'Replace the complete set of tickets this one blocks (the reverse direction).'
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
				try {
					const updated = tickets.update(id, opts.userId, patch as UpdateInput);
					if (!updated) return err(`Ticket not found: ${id}`);
					return ok(
						{ id: updated.id, title: updated.title, status: updated.status },
						`Updated ticket ${updated.id}: ${updated.title} [${updated.status}]`
					);
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		},
		{
			name: 'ticket_block',
			description:
				'Record that one ticket is blocked by another (a blocking / ordering edge): `id` should not be started until `blockedBy` is done. Use this to model the order work should happen in — ticket_list then flags what is blocked, and a ticket with no open blockers is ready to start. Rejects self-edges and cycles.',
			argsSchema: BlockArgs,
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'The ticket that is blocked.' },
					blockedBy: {
						type: 'string',
						description: 'The blocking ticket that must be done first.'
					}
				},
				required: ['id', 'blockedBy'],
				additionalProperties: false
			},
			async handler(args) {
				const { id, blockedBy } = BlockArgs.parse(args);
				const dependent = tickets.get(id, opts.userId);
				if (!dependent || dependent.workspaceKey !== opts.workspaceKey) {
					return err(`Ticket not found: ${id}`);
				}
				const prereq = tickets.get(blockedBy, opts.userId);
				if (!prereq || prereq.workspaceKey !== opts.workspaceKey) {
					return err(`Ticket not found: ${blockedBy}`);
				}
				try {
					const result = tickets.addDependency(opts.userId, id, blockedBy);
					const verb = result === 'added' ? 'now blocked by' : 'already blocked by';
					return ok({ id, blockedBy, result }, `Ticket ${id} ${verb} ${blockedBy}.`);
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		},
		{
			name: 'ticket_unblock',
			description:
				'Remove a blocking edge added by ticket_block, so `id` is no longer blocked by `blockedBy`.',
			argsSchema: UnblockArgs,
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'The ticket that is blocked.' },
					blockedBy: { type: 'string', description: 'The blocking ticket to detach.' }
				},
				required: ['id', 'blockedBy'],
				additionalProperties: false
			},
			async handler(args) {
				const { id, blockedBy } = UnblockArgs.parse(args);
				const dependent = tickets.get(id, opts.userId);
				if (!dependent || dependent.workspaceKey !== opts.workspaceKey) {
					return err(`Ticket not found: ${id}`);
				}
				const removed = tickets.removeDependency(opts.userId, id, blockedBy);
				return removed
					? ok(
							{ id, blockedBy, result: 'removed' },
							`Ticket ${id} no longer blocked by ${blockedBy}.`
						)
					: err(`Ticket ${id} is not blocked by ${blockedBy}.`);
			}
		}
	];
}
