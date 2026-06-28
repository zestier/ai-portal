import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clear } from '$lib/server/auth/session';
import { audit } from '$lib/server/audit';

export const POST: RequestHandler = ({ cookies, url, locals, getClientAddress }) => {
	clear(cookies, url.protocol === 'https:');
	audit({
		event_type: 'logout',
		actor_login: locals.user?.githubLogin ?? null,
		actor_ip: getClientAddress(),
		outcome: 'success'
	});
	throw redirect(303, '/login');
};
