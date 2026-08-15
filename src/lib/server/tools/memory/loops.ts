import { z } from 'zod';
import * as memoryRepo from '../../db/repos/memory';
import { ok, type PortalTool } from '../types';
import { project, withOmitted, FieldsArg, FIELDS_PARAM } from '../project';
import { OPEN_LOOP_KEEP, projectOptions } from './common';
import type { MemoryToolsOpts } from './common';

export const OpenLoopsArgs = z
	.object({
		loopType: z.string().trim().min(1).max(100).optional(),
		limit: z.number().int().min(1).max(50).optional().default(20),
		fields: FieldsArg
	})
	.optional()
	.default({});

export function buildMemoryLoopsTools(opts: MemoryToolsOpts): PortalTool[] {
	return [
		{
			name: 'memory_get_open_loops',
			description:
				'Fetch unresolved durable open loops (tasks, promises, plot threads, clues, questions, commitments).',
			argsSchema: OpenLoopsArgs,
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {
					loopType: { type: 'string', description: 'Optional loop type filter.' },
					limit: { type: 'number', description: 'Open loops 1-50, default 20.' },
					fields: FIELDS_PARAM
				},
				additionalProperties: false
			},
			async handler(args) {
				const parsed = OpenLoopsArgs.parse(args);
				const openLoops = memoryRepo.listOpenLoops(opts.conversationId, parsed);
				const summary = `${openLoops.length} open loop(s)`;
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_open_loops',
					arguments: parsed,
					resultSummary: summary,
					resultIds: openLoops.map((loop) => loop.id)
				});
				const projected = project(openLoops, projectOptions(parsed.fields, OPEN_LOOP_KEEP));
				return ok(withOmitted({ openLoops: projected.value }, projected.omitted), summary);
			}
		}
	];
}
