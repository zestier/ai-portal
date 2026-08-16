import { describe, expect, it } from 'vitest';
import { ticketStatusActions } from '../../src/lib/tickets/actions';

describe('ticketStatusActions', () => {
	it('offers Mark done and Archive for an open ticket', () => {
		const actions = ticketStatusActions('open');
		expect(actions.map((a) => a.id)).toEqual(['mark-done', 'archive']);
		expect(actions.map((a) => a.target)).toEqual(['done', 'archived']);
	});

	it('offers Reopen and Archive for a done ticket', () => {
		const actions = ticketStatusActions('done');
		expect(actions.map((a) => a.id)).toEqual(['reopen', 'archive']);
		expect(actions.map((a) => a.target)).toEqual(['open', 'archived']);
	});

	it('offers only Reopen for an archived ticket', () => {
		const actions = ticketStatusActions('archived');
		expect(actions.map((a) => a.id)).toEqual(['reopen']);
		expect(actions[0].target).toBe('open');
	});

	it('gates only Archive behind a confirmation step', () => {
		// The archive-confirm gate: archive is the sole transition that must prompt
		// before firing; reversible transitions (done/reopen) never confirm.
		for (const status of ['open', 'done', 'archived'] as const) {
			for (const action of ticketStatusActions(status)) {
				expect(action.confirm).toBe(action.id === 'archive');
			}
		}
	});

	it('marks Archive (and only Archive) as a danger action', () => {
		const archive = ticketStatusActions('open').find((a) => a.id === 'archive');
		const markDone = ticketStatusActions('open').find((a) => a.id === 'mark-done');
		expect(archive?.danger).toBe(true);
		expect(markDone?.danger).toBe(false);
	});
});
