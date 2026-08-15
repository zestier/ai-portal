import { z } from 'zod';
import * as memoryRepo from '../../db/repos/memory';
import { buildInitialPacket, renderMemoryPacket } from '../../memory/engine';
import { ok, type PortalTool } from '../types';
import type { MemoryToolsOpts } from './common';

export function buildMemoryPacketTools(opts: MemoryToolsOpts): PortalTool[] {
	return [
		{
			name: 'memory_get_packet',
			description: 'Fetch the current initial durable memory packet for this session.',
			argsSchema: z.object({}).optional().default({}),
			permissionBehavior: 'never-prompt',
			parameters: {
				type: 'object',
				properties: {},
				additionalProperties: false
			},
			async handler() {
				const packet = buildInitialPacket(opts.conversationId, opts.mode, {
					globalMemoryEnabled: opts.globalMemoryEnabled
				});
				memoryRepo.recordToolCall(opts.conversationId, {
					turnId: opts.getTurnId?.() ?? null,
					toolName: 'memory_get_packet',
					arguments: {},
					resultSummary: packet.summary
				});
				return ok(renderMemoryPacket(packet), packet.summary);
			}
		}
	];
}
