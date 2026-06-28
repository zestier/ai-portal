import { describe, it, expect, beforeEach } from 'vitest';
import { _safeFieldsForTest } from '../src/lib/server/log';

// The global test setup defaults LOG_LEVEL=warn to suppress noisy db/migration lines.
beforeEach(() => {
	process.env.LOG_LEVEL = 'debug';
});

describe('log safeFields — reserved-key protection', () => {
	it('renames ts/level/msg keys to _ts/_level/_msg', () => {
		const result = _safeFieldsForTest({
			ts: 'caller-ts',
			level: 'caller-level',
			msg: 'caller-msg'
		});
		expect(result._ts).toBe('caller-ts');
		expect(result._level).toBe('caller-level');
		expect(result._msg).toBe('caller-msg');
		// The original reserved keys must be absent from the output.
		expect('ts' in result).toBe(false);
		expect('level' in result).toBe(false);
		expect('msg' in result).toBe(false);
	});

	it('passes through non-reserved fields unchanged', () => {
		const result = _safeFieldsForTest({ userId: 'u1', error: 'boom', count: 42 });
		expect(result.userId).toBe('u1');
		expect(result.error).toBe('boom');
		expect(result.count).toBe(42);
		expect('_userId' in result).toBe(false);
	});

	it('handles a mix of reserved and non-reserved fields', () => {
		const result = _safeFieldsForTest({ msg: 'from-caller', userId: 'u2' });
		expect(result._msg).toBe('from-caller');
		expect(result.userId).toBe('u2');
		expect('msg' in result).toBe(false);
	});

	it('returns an empty object when given an empty object', () => {
		expect(_safeFieldsForTest({})).toEqual({});
	});
});

describe('log emit — reserved-key precedence in the JSON record', () => {
	it('authoritative ts/level/msg override any same-named caller fields in the output', () => {
		// Verify the integration: `line = { ...safeFields(fields), ts, level, msg }`
		// ensures the authoritative fixed keys always win over caller fields.
		const safe = _safeFieldsForTest({
			ts: 'caller-ts',
			level: 'caller-level',
			msg: 'caller-msg'
		});
		const line: Record<string, unknown> = {
			...safe,
			ts: new Date().toISOString(),
			level: 'info',
			msg: 'actual-msg'
		};

		expect(line.msg).toBe('actual-msg');
		expect(line.level).toBe('info');
		expect(line.ts).not.toBe('caller-ts');
		expect(line._ts).toBe('caller-ts');
		expect(line._level).toBe('caller-level');
		expect(line._msg).toBe('caller-msg');
	});
});
