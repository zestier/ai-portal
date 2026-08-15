import { z } from 'zod';
import { conversationId as convCodec } from '$lib/ids';
import { getLease, inspectLease, leaseIntegrationStatus, touchLease } from '../../leases';
import { err, ok, type PortalTool } from '../types';
import * as convs from '../../db/repos/conversations';
import { describeWorktreeError, leaseView } from './common';

export const StatusArgs = z.object({ leaseId: z.string().trim().min(1).max(64) }).strict();

export function buildWorktreeStatusTool(ctx: {
	userId: number;
	conversationId: number;
}): PortalTool {
	// Re-read the conversation per call rather than capturing it: a lease may be
	// created many turns after the session was established.
	const conversation = () => convs.get(ctx.conversationId, ctx.userId);
	return {
		name: 'worktree_status',
		description: 'Report one PORTAL worktree lease this conversation holds.',
		argsSchema: StatusArgs,
		parameters: {
			type: 'object',
			properties: {
				leaseId: { type: 'string', description: 'Worktree id.' }
			},
			required: ['leaseId'],
			additionalProperties: false
		},
		async handler(args) {
			const { leaseId } = StatusArgs.parse(args);
			const conv = conversation();
			if (!conv) return err('conversation not found', { code: 'conversation_not_found' });
			const lease = getLease(leaseId, ctx.userId);
			if (!lease || lease.heldByConversationId !== convCodec.encode(ctx.conversationId)) {
				return err(`no worktree with id ${leaseId} in this conversation`, {
					code: 'lease_not_found'
				});
			}
			touchLease(lease.id);
			try {
				const { dirtyCount } = await inspectLease(lease);
				const status = await leaseIntegrationStatus(lease, conv);
				return ok(leaseView(lease, dirtyCount, { ahead: status.ahead, behind: status.behind }));
			} catch (cause) {
				const described = describeWorktreeError(cause);
				if (described) {
					return err(described.message, described.code ? { code: described.code } : undefined);
				}
				throw cause;
			}
		}
	};
}
