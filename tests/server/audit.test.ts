import { describe, it, expect, afterEach } from 'vitest';
import { audit, setAuditSink, type AuditRecord } from '../../src/lib/server/audit';

afterEach(() => {
	setAuditSink(null); // restore default sink
});

describe('audit', () => {
	it('emits a fully-populated forensic record to the active sink', () => {
		const records: AuditRecord[] = [];
		setAuditSink((r) => records.push(r));

		audit({
			event_type: 'login',
			actor_login: 'alice',
			actor_ip: '203.0.113.7',
			resource: 'github',
			outcome: 'success',
			detail: { foo: 'bar' }
		});

		expect(records).toHaveLength(1);
		const rec = records[0];
		expect(rec.event_type).toBe('login');
		expect(rec.actor_login).toBe('alice');
		expect(rec.actor_ip).toBe('203.0.113.7');
		expect(rec.resource).toBe('github');
		expect(rec.outcome).toBe('success');
		expect(rec.detail).toEqual({ foo: 'bar' });
		// ts is an ISO-8601 timestamp.
		expect(() => new Date(rec.ts).toISOString()).not.toThrow();
		expect(rec.ts).toBe(new Date(rec.ts).toISOString());
	});

	it('defaults optional actor/resource fields to null and omits absent detail', () => {
		const records: AuditRecord[] = [];
		setAuditSink((r) => records.push(r));

		audit({ event_type: 'logout', outcome: 'success' });

		const rec = records[0];
		expect(rec.actor_login).toBeNull();
		expect(rec.actor_ip).toBeNull();
		expect(rec.resource).toBeNull();
		expect('detail' in rec).toBe(false);
	});

	it('never throws when the sink throws', () => {
		setAuditSink(() => {
			throw new Error('sink down');
		});
		expect(() => audit({ event_type: 'redeploy', outcome: 'denied' })).not.toThrow();
	});

	it('setAuditSink(null) restores the default sink (no record captured afterwards)', () => {
		const records: AuditRecord[] = [];
		setAuditSink((r) => records.push(r));
		setAuditSink(null);
		audit({ event_type: 'login', outcome: 'success' });
		expect(records).toHaveLength(0);
	});
});
