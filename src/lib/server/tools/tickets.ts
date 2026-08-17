import { z } from 'zod';
import { conversationId as conversationCodec, ticketId } from '$lib/ids';
import * as tickets from '../db/repos/tickets';
import type { UpdateInput } from '../db/repos/tickets';
import type { WorkspaceTicket } from '$lib/types';
import { TICKET_MODEL_FIELDS } from '$lib/tickets/view';
import { err, ok, type PortalTool } from './types';
import { project, withOmitted, normalizeFieldSelector, FieldsArg, FIELDS_PARAM } from './project';

/** Parse a ticket-handle edge id; an unresolvable handle reads as "not found". */
function parseEdgeId(id: string): number {
	const int = ticketId.tryParse(id);
	if (int === null) throw new Error(`ticket not found: ${id}`);
	return int;
}

// Compact tool view: the shared model-relevant field set minus `plan` (deliberately
// omitted from the compact default — it's the longest field — and recoverable via
// the `fields` selector). Keeping the allowlist in lockstep with `TICKET_MODEL_FIELDS`
// means the tool's projection and the action prompt's `{{ticket.all}}` block can't
// drift apart.
const TICKET_KEEP = TICKET_MODEL_FIELDS.filter((f) => f !== 'plan');

// Enrich a ticket with its blocking edges for the agent tools. `blockedBy` is
// the actionable subset (blockers that are still open); `blocks` lists the
// tickets waiting on this one. Each is attached only when non-empty: an empty
// edge list is omitted entirely rather than rendered as `[]`. Both names are in
// TICKET_KEEP, so a `fields` request for either is always valid (never an
// unknown-field error) even on a ticket that currently has no such edges.
function withDeps(ticket: WorkspaceTicket) {
	const id = ticketId.parse(ticket.id);
	const blockedBy = tickets.openBlockers(id);
	const blocks = tickets.listDependents(id);
	return {
		...ticket,
		...(blockedBy.length ? { blockedBy } : {}),
		...(blocks.length ? { blocks } : {})
	};
}

const Status = z.enum(['open', 'done', 'archived']);

// Ticket priority P0 (highest urgency) … P3 (lowest). Mirrors the DB CHECK and
// the REST API validation so a bad value fails fast and consistently.
const Priority = z.enum(['P0', 'P1', 'P2', 'P3']);

// Edge id lists for `ticket_add`/`ticket_update`. A bounded array of ticket ids.
const EdgeIds = z.array(z.string().trim().min(1)).max(100);

const AddArgs = z.object({
	title: z.string().trim().min(1).max(200),
	body: z.string().trim().max(8000).optional(),
	plan: z.string().trim().max(100000).optional(),
	priority: Priority.optional(),
	blockedBy: EdgeIds.optional(),
	blocks: EdgeIds.optional()
});

const ListArgs = z
	.object({
		status: z.enum(['open', 'done', 'archived', 'all']).optional().default('open'),
		limit: z.number().int().min(1).max(50).optional().default(20),
		fields: FieldsArg
	})
	.prefault({});

const UpdateArgs = z
	.object({
		id: z.string().min(1),
		title: z.string().trim().min(1).max(200).optional(),
		body: z.string().trim().max(8000).optional(),
		plan: z.string().trim().max(100000).optional(),
		priority: Priority.optional(),
		status: Status.optional(),
		blockedBy: EdgeIds.optional(),
		blocks: EdgeIds.optional()
	})
	.refine(
		(args) =>
			args.title !== undefined ||
			args.body !== undefined ||
			args.plan !== undefined ||
			args.priority !== undefined ||
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

export function buildTicketTools(opts: {
	userId: number;
	workspaceKey: string;
	conversationId: string | number;
}): PortalTool[] {
	const conversationIdInt =
		typeof opts.conversationId === 'number'
			? opts.conversationId
			: conversationCodec.parse(opts.conversationId);
	return [
		{
			name: 'ticket_add',
			description: 'Add a durable workspace ticket for later work.',
			argsSchema: AddArgs,
			parameters: {
				type: 'object',
				properties: {
					title: { type: 'string', description: 'Short ticket title.' },
					body: { type: 'string', description: 'Optional details, notes, or acceptance criteria.' },
					plan: {
						type: 'string',
						description: 'Optional plan / design notes / checklist.'
					},
					priority: {
						type: 'string',
						enum: ['P0', 'P1', 'P2', 'P3'],
						description: 'P0 highest, P3 lowest. Default P2.'
					},
					blockedBy: {
						type: 'array',
						items: { type: 'string' },
						description: 'Ids of blocking tickets.'
					},
					blocks: {
						type: 'array',
						items: { type: 'string' },
						description: 'Ids of tickets this one blocks.'
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
						...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
						...(parsed.blockedBy !== undefined
							? { blockedBy: parsed.blockedBy.map(parseEdgeId) }
							: {}),
						...(parsed.blocks !== undefined ? { blocks: parsed.blocks.map(parseEdgeId) } : {}),
						sourceConversationId: conversationIdInt
					});
					return ok(
						{
							id: ticket.id,
							title: ticket.title,
							priority: ticket.priority,
							status: ticket.status
						},
						`Added ticket ${ticket.id} [${ticket.priority}]: ${ticket.title}`
					);
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		},
		{
			name: 'ticket_list',
			description: 'List durable workspace tickets for the current workspace (defaults to open).',
			promptGuidelines: [
				'For substantial work spanning multiple steps or sessions, prefer a durable ticket over ephemeral session state: check ticket_list first and resume the matching ticket (read its `plan`) before re-planning, or open one if none fits. Keep the plan and checklist in the ticket `plan` field and update status as you work.',
				'Ticketing is a convenience for durable work, not a blanket requirement — skip it for lighter, one-off, or non-engineering tasks where a ticket would add overhead without payoff.'
			],
			argsSchema: ListArgs,
			parameters: {
				type: 'object',
				properties: {
					status: {
						type: 'string',
						enum: ['open', 'done', 'archived', 'all'],
						description: 'Default: open.'
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
						const blockers = tickets.openBlockers(ticketId.parse(t.id));
						const blockedNote = blockers.length ? ` (blocked by: ${blockers.join(', ')})` : '';
						return `- ${t.id} [${t.priority}] [${t.status}] ${t.title}${blockedNote}${t.body ? `\n  ${t.body}` : ''}`;
					})
					.join('\n');
				return ok(rendered, summary);
			}
		},
		{
			name: 'ticket_get',
			description: 'Read one durable workspace ticket by id.',
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
				const ticket = tickets.get(ticketId.parse(id), opts.userId);
				if (!ticket || ticket.workspaceKey !== opts.workspaceKey) {
					return err(`Ticket not found: ${id}`);
				}
				const fields = normalizeFieldSelector(rawFields);
				// The tool id is a string (it round-trips into ticket_update's
				// `z.string()` id param), so the result echoes it in that form. Edge lists
				// are T-handles — they round-trip into the same id params.
				const ticketView = {
					...withDeps(ticket),
					id: ticket.id
				};
				const projected = project(ticketView, {
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
			description: "Update a ticket's title, body, plan, priority, status, or blocking edges.",
			promptGuidelines: [
				'status=done when completed; archived when hidden without completion.',
				'`blockedBy`/`blocks` replace the FULL edge set on that side (omit to leave unchanged, [] to clear) — the declarative way to add or remove blocking edges.'
			],
			argsSchema: UpdateArgs,
			parameters: {
				type: 'object',
				properties: {
					id: { type: 'string', description: 'Ticket id.' },
					title: { type: 'string', description: 'New title.' },
					body: { type: 'string', description: 'New details/body.' },
					plan: {
						type: 'string',
						description: 'New plan / design notes / checklist.'
					},
					priority: {
						type: 'string',
						enum: ['P0', 'P1', 'P2', 'P3'],
						description: 'P0 highest, P3 lowest. Omit to leave unchanged.'
					},
					status: {
						type: 'string',
						enum: ['open', 'done', 'archived'],
						description: 'New ticket status.'
					},
					blockedBy: {
						type: 'array',
						items: { type: 'string' },
						description: 'Replace all tickets blocking this one ([] to clear).'
					},
					blocks: {
						type: 'array',
						items: { type: 'string' },
						description: 'Replace all tickets this one blocks.'
					}
				},
				required: ['id'],
				additionalProperties: false
			},
			async handler(args) {
				const { id, ...patch } = UpdateArgs.parse(args);
				const current = tickets.get(ticketId.parse(id), opts.userId);
				if (!current || current.workspaceKey !== opts.workspaceKey) {
					return err(`Ticket not found: ${id}`);
				}
				try {
					const updated = tickets.update(ticketId.parse(id), opts.userId, {
						...patch,
						...(patch.blockedBy !== undefined
							? { blockedBy: patch.blockedBy.map(ticketId.parse) }
							: {}),
						...(patch.blocks !== undefined ? { blocks: patch.blocks.map(ticketId.parse) } : {})
					} as UpdateInput);
					if (!updated) return err(`Ticket not found: ${id}`);
					return ok(
						{
							id: updated.id,
							title: updated.title,
							priority: updated.priority,
							status: updated.status
						},
						`Updated ticket ${updated.id}: ${updated.title} [${updated.priority}] [${updated.status}]`
					);
				} catch (e) {
					return err(e instanceof Error ? e.message : String(e));
				}
			}
		}
	];
}
