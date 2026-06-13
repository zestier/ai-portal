import { describe, it, expect } from 'vitest';
import { parseApplyPatch } from '../src/lib/client/apply-patch';

describe('parseApplyPatch', () => {
	it('returns null for input that is not apply_patch format', () => {
		expect(parseApplyPatch('just some text')).toBeNull();
		expect(parseApplyPatch('diff --git a/x b/x')).toBeNull();
	});

	it('returns null when the envelope markers are missing', () => {
		expect(parseApplyPatch('*** Begin Patch\n*** Add File: a.txt')).toBeNull();
	});

	it('returns null when the first line is not the Begin Patch marker', () => {
		const input = ['preamble', '*** Begin Patch', '*** End Patch'].join('\n');
		expect(parseApplyPatch(input)).toBeNull();
	});

	it('parses a well-formed add patch', () => {
		const input = ['*** Begin Patch', '*** Add File: hello.txt', '+hello', '*** End Patch'].join(
			'\n'
		);
		const changes = parseApplyPatch(input);
		expect(changes).not.toBeNull();
		expect(changes).toHaveLength(1);
		expect(changes![0]).toMatchObject({ kind: 'add', path: 'hello.txt' });
	});

	it('returns [] (not null) for a recognized but malformed patch with an unrecognized line', () => {
		const input = ['*** Begin Patch', 'something unexpected', '*** End Patch'].join('\n');
		const result = parseApplyPatch(input);
		expect(result).not.toBeNull();
		expect(result).toEqual([]);
	});

	it('returns [] (not null) for a recognized patch that never terminates with End Patch', () => {
		// The literal '*** End Patch' only appears as a substring inside an add
		// body line, so the parser consumes every line and runs off the end
		// without hitting a standalone terminator. Recognized but malformed.
		const input = ['*** Begin Patch', '*** Add File: a.txt', '+contains *** End Patch inline'].join(
			'\n'
		);
		const result = parseApplyPatch(input);
		expect(result).not.toBeNull();
		expect(result).toEqual([]);
	});
});
