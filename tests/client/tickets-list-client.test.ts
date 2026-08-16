import { describe, expect, it } from 'vitest';
import { ticketsPageUrl } from '../../src/lib/client/tickets-list';

describe('ticketsPageUrl', () => {
	it('omits sort/priority params at their defaults', () => {
		const params = new URL(
			ticketsPageUrl({ status: 'open', limit: 20, offset: 0 }),
			'http://localhost'
		).searchParams;
		expect(params.get('status')).toBe('open');
		expect(params.get('sort')).toBeNull();
		expect(params.get('priority')).toBeNull();
	});

	it('encodes a priority sort + filter when non-default', () => {
		const params = new URL(
			ticketsPageUrl({
				status: 'all',
				limit: 20,
				offset: 40,
				sort: 'priority',
				priority: 'P1',
				workspace: '/w'
			}),
			'http://localhost'
		).searchParams;
		expect(params.get('sort')).toBe('priority');
		expect(params.get('priority')).toBe('P1');
		expect(params.get('offset')).toBe('40');
		expect(params.get('workspace')).toBe('/w');
	});

	it('treats explicit recency/all as the default (no params emitted)', () => {
		const params = new URL(
			ticketsPageUrl({ status: 'open', limit: 20, offset: 0, sort: 'recency', priority: 'all' }),
			'http://localhost'
		).searchParams;
		expect(params.get('sort')).toBeNull();
		expect(params.get('priority')).toBeNull();
	});
});
