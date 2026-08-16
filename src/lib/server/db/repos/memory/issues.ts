import { getDb } from '../../index';
import { appendSessionMemoryLog } from './common';
import { rowToIssue, type IssueRow, type MemoryValidationIssue } from './rows';

export function addIssue(
	conversationId: number,
	input: {
		patchId?: number | null;
		severity: 'info' | 'warning' | 'error';
		code: string;
		message: string;
	}
): MemoryValidationIssue {
	const now = Date.now();
	const info = getDb()
		.prepare(
			`INSERT INTO memory_validation_issues(
			   conversation_id, patch_id, severity, code, message, status, created_at, resolved_at
			 ) VALUES (?, ?, ?, ?, ?, 'open', ?, NULL)`
		)
		.run(conversationId, input.patchId ?? null, input.severity, input.code, input.message, now);
	const id = Number(info.lastInsertRowid);
	const row = getDb()
		.prepare('SELECT * FROM memory_validation_issues WHERE id = ?')
		.get(id) as IssueRow;
	appendSessionMemoryLog(getDb(), conversationId, {
		eventKind: 'issue.create',
		itemType: 'issue',
		itemId: id,
		payload: { issue: rowToIssue(row) }
	});
	return rowToIssue(row);
}

export function listIssues(
	conversationId: number,
	opts: { limit?: number; status?: string } = {}
): MemoryValidationIssue[] {
	const rows = getDb()
		.prepare(
			`SELECT * FROM memory_validation_issues
			  WHERE conversation_id = ? AND status = ?
			  ORDER BY created_at DESC LIMIT ?`
		)
		.all(conversationId, opts.status ?? 'open', opts.limit ?? 50) as IssueRow[];
	return rows.map(rowToIssue);
}
