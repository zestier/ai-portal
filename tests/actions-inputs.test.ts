import { describe, expect, it } from 'vitest';
import {
	resolveInputValues,
	substituteArg,
	substituteSteps,
	tokensIn
} from '../src/lib/server/actions/inputs';
import type { ActionInput, ActionStep } from '../src/lib/server/actions/config';

function input(partial: Partial<ActionInput> & { name: string }): ActionInput {
	return {
		label: partial.name,
		type: 'string',
		required: true,
		...partial
	} as ActionInput;
}

describe('tokensIn', () => {
	it('extracts distinct input names, tolerating inner whitespace', () => {
		expect(tokensIn('--ref={{ ref }} --to={{target}} {{ref}}')).toEqual(['ref', 'target']);
	});

	it('returns nothing when there are no tokens', () => {
		expect(tokensIn('pnpm run build')).toEqual([]);
	});
});

describe('resolveInputValues', () => {
	it('returns provided string values and rejects unknown keys', () => {
		const inputs = [input({ name: 'ref' })];
		expect(resolveInputValues(inputs, { ref: 'main' })).toEqual({
			ok: true,
			values: { ref: 'main' }
		});
		const bad = resolveInputValues(inputs, { ref: 'main', nope: 'x' });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain('unknown input');
	});

	it('falls back to a default and enforces required', () => {
		const withDefault = resolveInputValues([input({ name: 'env', default: 'staging' })], {});
		expect(withDefault).toEqual({ ok: true, values: { env: 'staging' } });

		const missingRequired = resolveInputValues([input({ name: 'env' })], {});
		expect(missingRequired.ok).toBe(false);
		if (!missingRequired.ok) expect(missingRequired.error).toContain('required');
	});

	it('resolves an optional unset input to the empty string', () => {
		const res = resolveInputValues([input({ name: 'note', required: false })], {});
		expect(res).toEqual({ ok: true, values: { note: '' } });
	});

	it('validates enum membership', () => {
		const inputs = [input({ name: 'env', type: 'enum', options: ['staging', 'prod'] })];
		expect(resolveInputValues(inputs, { env: 'prod' })).toEqual({
			ok: true,
			values: { env: 'prod' }
		});
		const bad = resolveInputValues(inputs, { env: 'dev' });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain('one of');
	});

	it('coerces and validates numbers', () => {
		const inputs = [input({ name: 'count', type: 'number' })];
		expect(resolveInputValues(inputs, { count: 5 })).toEqual({ ok: true, values: { count: '5' } });
		expect(resolveInputValues(inputs, { count: '12' })).toEqual({
			ok: true,
			values: { count: '12' }
		});
		const bad = resolveInputValues(inputs, { count: 'abc' });
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain('number');
	});

	it('rejects an over-long string value', () => {
		const res = resolveInputValues([input({ name: 'blob' })], { blob: 'x'.repeat(8193) });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain('limit');
	});
});

describe('substituteArg / substituteSteps', () => {
	it('replaces tokens with their resolved values as whole literals', () => {
		expect(substituteArg('--ref={{ref}}', { ref: 'feature/x y' })).toBe('--ref=feature/x y');
	});

	it('leaves a value with shell metacharacters intact (no shell interpretation)', () => {
		// shell:false means this is one argv element, never re-parsed.
		expect(substituteArg('{{msg}}', { msg: '$(rm -rf /)' })).toBe('$(rm -rf /)');
	});

	it('substitutes an unknown token to empty string (config-load already rejects these)', () => {
		expect(substituteArg('{{ghost}}', {})).toBe('');
	});

	it('substitutes args across every step but never the command', () => {
		const steps: ActionStep[] = [
			{ label: 'deploy', command: 'pnpm', args: ['run', 'deploy', '--env={{env}}'] }
		];
		expect(substituteSteps(steps, { env: 'prod' })).toEqual([
			{ label: 'deploy', command: 'pnpm', args: ['run', 'deploy', '--env=prod'] }
		]);
	});
});
