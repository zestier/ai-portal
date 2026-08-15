import { z } from 'zod';
import * as memoryRepo from '../../db/repos/memory';
import { ok, type PortalTool } from '../types';
import { project, withOmitted, FieldsArg, FIELDS_PARAM } from '../project';
import { EVENT_KEEP, projectOptions } from './common';
import type { MemoryToolsOpts } from './common';

export const RecentEventsArgs = z
	.object({
		entityId: z.string().trim().min(1).max(200).optional(),
		eventType: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(50).optional().default(20),
		fields: FieldsArg
	})
	.optional()
	.default({});

export const TimelineArgs = z
	.object({
		entityId: z.string().trim().min(1).max(200).optional(),
		eventType: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(100).optional().default(50),
		fields: FieldsArg
	})
	.optional()
	.default({});

export function buildMemoryEventsTools(opts: MemoryToolsOpts): PortalTool[] {
	return [
		{
			name: 'memory_get_recent_events',
			description:
				'Fetch recent durable memory events, optionally filtered by entity or event type.',
			argsSchema: RecentEventsArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					entityId: { type: 'string', description: 'Optional entity id.' },
					eventType: { type: 'string', description: 'Optional event type.' },
					limit: { type: 'number', description: 'Events 1-50, default 20.' },
					fields: FIELDS_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = RecentEventsArgs.parse(args);
				const events = memoryRepo.listEvents(opts.conversationId, {
					...parsed,
					entityId: parsed.entityId ? Number(parsed.entityId) : undefined
				});
				const summary = `${events.length} event(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_recent_events',
					arguments: parsed,
					resultSummary: summary,
					resultIds: events.map((event) => event.id)
				});
				const projected = project(events, projectOptions(parsed.fields, EVENT_KEEP));
				return ok(withOmitted({ events: projected.value }, projected.omitted), summary);
			}
		},
		{
			name: 'memory_query_timeline',
			description:
				'Return ordered memory events for timeline reasoning (alibis, chronology, continuity).',
			argsSchema: TimelineArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					entityId: { type: 'string', description: 'Optional entity id.' },
					eventType: { type: 'string', description: 'Optional event type.' },
					limit: { type: 'number', description: 'Events 1-100, default 50.' },
					fields: FIELDS_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = TimelineArgs.parse(args);
				const events = memoryRepo
					.listEvents(opts.conversationId, {
						...parsed,
						entityId: parsed.entityId ? Number(parsed.entityId) : undefined
					})
					.sort((a, b) => a.occurredAt - b.occurredAt || a.id - b.id);
				const summary = `${events.length} timeline event(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_query_timeline',
					arguments: parsed,
					resultSummary: summary,
					resultIds: events.map((event) => event.id)
				});
				const projected = project(events, projectOptions(parsed.fields, EVENT_KEEP));
				return ok(withOmitted({ events: projected.value }, projected.omitted), summary);
			}
		}
	];
}
