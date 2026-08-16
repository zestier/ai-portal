import { getDb } from '../../index';
import { conversationId } from '$lib/ids';
import { convInt } from './rows';

export function recordDecision(
	conversationId: string | number,
	tool: string,
	argsSummary: string,
	decision: PermissionDecisionRecord['decision']
) {
	getDb()
		.prepare(
			`INSERT INTO permission_decisions(conversation_id, tool, args_summary, decision, decided_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(convInt(conversationId), tool, argsSummary, decision, Date.now());
}

export interface PermissionDecisionRecord {
	id: number;
	conversationId: string;
	conversationTitle: string | null;
	tool: string;
	argsSummary: string | null;
	decision:
		| 'allow-once'
		| 'allow-always'
		| 'deny'
		| 'deny-always'
		| 'auto-allow'
		| 'auto-deny'
		| 'auto-prompt-required'
		| 'auto-cancelled'
		| 'auto-expired';
	decidedAt: number;
}

/**
 * Most recent permission decisions across all conversations owned by
 * `userId`. Used by the settings page audit panel so users can see what
 * tools they've been approving (or denying) without spelunking SQLite.
 */
export function listRecentDecisionsForUser(userId: number, limit = 50): PermissionDecisionRecord[] {
	const rows = getDb()
		.prepare(
			`SELECT pd.id, pd.conversation_id, c.title AS conversation_title,
			        pd.tool, pd.args_summary, pd.decision, pd.decided_at
			 FROM permission_decisions pd
			 JOIN conversations c ON c.id = pd.conversation_id
			 WHERE c.user_id = ?
			 ORDER BY pd.decided_at DESC, pd.id DESC
			 LIMIT ?`
		)
		.all(userId, limit) as Array<{
		id: number;
		conversation_id: number;
		conversation_title: string | null;
		tool: string;
		args_summary: string | null;
		decision: string;
		decided_at: number;
	}>;
	return rows.map((r) => ({
		id: r.id,
		conversationId: conversationId.encode(r.conversation_id),
		conversationTitle: r.conversation_title,
		tool: r.tool,
		argsSummary: r.args_summary,
		decision: r.decision as PermissionDecisionRecord['decision'],
		decidedAt: r.decided_at
	}));
}
