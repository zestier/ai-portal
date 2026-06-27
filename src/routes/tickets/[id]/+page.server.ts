import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import * as tickets from '$lib/server/db/repos/tickets';
import { requireUserId } from '$lib/server/auth/require';

export const load: PageServerLoad = ({ params, locals }) => {
	const userId = requireUserId(locals);
	const ticket = tickets.get(params.id, userId);
	if (!ticket) throw error(404, 'Ticket not found');
	return {
		ticket,
		// Full dependency picture for the detail view: prerequisites this ticket
		// depends on (with their status, so satisfied ones are distinguishable from
		// active blockers) and the tickets that depend on it.
		dependsOn: tickets.dependencyRefs(ticket.id, userId),
		dependents: tickets.dependentRefs(ticket.id, userId)
	};
};
