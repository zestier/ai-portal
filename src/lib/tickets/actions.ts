import type { WorkspaceTicketStatus } from '$lib/types';

/**
 * A contextual status-transition button for the ticket detail toolbar. `confirm`
 * marks transitions that require a confirmation step before firing (archive,
 * which hides the ticket); reversible transitions (done/reopen) fire instantly.
 */
export interface TicketStatusAction {
	/** Stable id for keying/tests. */
	id: 'mark-done' | 'reopen' | 'archive';
	label: string;
	target: WorkspaceTicketStatus;
	confirm: boolean;
	danger: boolean;
}

const MARK_DONE: TicketStatusAction = {
	id: 'mark-done',
	label: 'Mark done',
	target: 'done',
	confirm: false,
	danger: false
};

const REOPEN: TicketStatusAction = {
	id: 'reopen',
	label: 'Reopen',
	target: 'open',
	confirm: false,
	danger: false
};

const ARCHIVE: TicketStatusAction = {
	id: 'archive',
	label: 'Archive',
	target: 'archived',
	confirm: true,
	danger: true
};

/**
 * Contextual status transitions available from a given status:
 * - `open`     → Mark done, Archive
 * - `done`     → Reopen, Archive
 * - `archived` → Reopen
 */
export function ticketStatusActions(status: WorkspaceTicketStatus): TicketStatusAction[] {
	switch (status) {
		case 'open':
			return [MARK_DONE, ARCHIVE];
		case 'done':
			return [REOPEN, ARCHIVE];
		case 'archived':
			return [REOPEN];
	}
}
